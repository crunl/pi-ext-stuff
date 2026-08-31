import { basename, isAbsolute } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { PermissionsConfig } from "./config.ts";
import { type GuardianAction, guardianActionFromToolCall } from "./guardian-action.ts";
import { renderGuardianSystemPrompt } from "./guardian-policy.ts";
import { boundGuardianTranscript, type GuardianTranscriptEntry } from "./guardian-transcript.ts";
import type { RiskDecision } from "./risk-policy.ts";
import { isRecord } from "./unknown-value.ts";

export type AutoReviewRisk = "low" | "medium" | "high" | "critical";
export type AutoReviewUserAuthorization = "unknown" | "low" | "medium" | "high";

export interface AutoReviewResult {
  decision: "approve" | "deny";
  risk: AutoReviewRisk;
  userAuthorization: AutoReviewUserAuthorization;
  rationale: string;
  guardian?: {
    provider: string;
    model: string;
    source: "configured" | "active" | "active-fallback";
    fallbackNotice?: "configured-reviewer-unavailable";
  };
}

/** A host-loaded project instruction file that Codex exposes to Guardian as
 * trusted parent instructions. This is deliberately narrower than Pi's full
 * system-prompt input: skills, tool snippets, and extension-authored prompt
 * text are not parent authorization. */
export interface AutoReviewerParentInstruction {
  readonly path: string;
  readonly content: string;
}

/** Host-provided inputs a guardian review run needs. Owned here so that
 * model selection and the reviewer implementation can share it without
 * importing each other. */
export interface AutoReviewerContext {
  modelRegistry: Pick<ModelRegistry, "find" | "getApiKeyAndHeaders">;
  activeModel?: Model<Api>;
  reviewer?: PermissionsConfig["reviewer"];
  guardianPolicy?: string;
  guardianSession: {
    sessionId: string;
    cwd: string;
    configFingerprint: string;
  };
  /** Bounded AGENTS files loaded by the host's system-prompt builder. */
  parentInstructions?: readonly AutoReviewerParentInstruction[];
}

export interface AutoReviewApprovalOverride {
  denialId: string;
  actionFingerprint: string;
}

export interface GuardianPermissionContext {
  sandboxProfile: "workspace-write" | "read-only";
  sandboxEnforcesAction: boolean;
  filesystemWriteRoots: string[];
  filesystemDenyRead: string[];
  filesystemDenyWrite: string[];
  requestedNetworkTargets: Array<{
    host: string;
    port?: number;
    protocol?: string;
  }>;
  allowedNetworkHosts: string[];
  deniedNetworkHosts: string[];
  staticRisk?: "LOW" | "REVIEW" | "HARD";
  staticReason?: string;
  justification?: string;
}

export interface AutoReviewRequest {
  toolCallId: string;
  untrustedTranscript: GuardianTranscriptEntry[];
  untrustedAction: GuardianAction;
  permissionContext: GuardianPermissionContext;
  approvalOverride?: AutoReviewApprovalOverride;
}

type PromptDecision = Extract<RiskDecision, { action: "prompt" }>;

const MAX_ACTION_CHARACTERS = 16_000;
export const MAX_GUARDIAN_PARENT_INSTRUCTION_PATH_CHARACTERS = 4_096;
export const MAX_GUARDIAN_PARENT_INSTRUCTION_CHARACTERS = 32 * 1024;
const TRUSTED_PARENT_INSTRUCTION_BASENAMES = new Set(["AGENTS.md", "AGENTS.override.md"]);

export const AUTO_REVIEW_DENIED_ACTION_APPROVAL_DEVELOPER_PREFIX =
  "The user has manually approved a specific action that was previously `Rejected`.";

export const AUTO_REVIEW_SYSTEM_PROMPT = renderGuardianSystemPrompt();

function serializeAction(
  request: Pick<AutoReviewRequest, "untrustedAction" | "permissionContext">,
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(request);
  } catch {
    throw new Error("auto reviewer input exceeds action limit");
  }
  if (serialized.length > MAX_ACTION_CHARACTERS) {
    throw new Error("auto reviewer input exceeds action limit");
  }
  return serialized;
}

export function buildAutoReviewRequest(
  event: ToolCallEvent,
  decision: PromptDecision,
  cwd: string,
  permissionContext: GuardianPermissionContext,
  transcript: readonly GuardianTranscriptEntry[],
  approvalOverride?: AutoReviewApprovalOverride,
): AutoReviewRequest {
  const untrustedAction = guardianActionFromToolCall(event, cwd);
  const enrichedPermissionContext: GuardianPermissionContext = {
    ...permissionContext,
    requestedNetworkTargets: permissionContext.requestedNetworkTargets.map((target) => ({
      ...target,
    })),
    allowedNetworkHosts: [...permissionContext.allowedNetworkHosts],
    deniedNetworkHosts: [...permissionContext.deniedNetworkHosts],
    filesystemWriteRoots: [...permissionContext.filesystemWriteRoots],
    filesystemDenyRead: [...permissionContext.filesystemDenyRead],
    filesystemDenyWrite: [...permissionContext.filesystemDenyWrite],
    staticRisk: decision.risk,
    staticReason: decision.reason,
    ...(decision.justification === undefined ? {} : { justification: decision.justification }),
  };
  serializeAction({
    untrustedAction,
    permissionContext: enrichedPermissionContext,
  });
  return {
    toolCallId: event.toolCallId,
    untrustedTranscript: boundGuardianTranscript(transcript),
    untrustedAction,
    permissionContext: enrichedPermissionContext,
    ...(approvalOverride === undefined ? {} : { approvalOverride }),
  };
}

export function renderAutoReviewPrompt(request: AutoReviewRequest): string {
  return JSON.stringify({
    untrustedTranscript: boundGuardianTranscript(request.untrustedTranscript),
    untrustedAction: request.untrustedAction,
    permissionContext: request.permissionContext,
    outputSchema: {
      risk_level: ["low", "medium", "high", "critical"],
      user_authorization: ["unknown", "low", "medium", "high"],
      outcome: ["allow", "deny"],
      rationale: "string",
    },
  });
}

export function renderAutoReviewTrustedContext(request: AutoReviewRequest): string | undefined {
  if (request.approvalOverride === undefined) return undefined;
  return approvedActionContext(
    serializeAction({
      untrustedAction: request.untrustedAction,
      permissionContext: request.permissionContext,
    }),
  );
}

/**
 * Keep the host boundary and the reviewer boundary consistent. A caller may
 * construct AutoReviewerContext directly, so filtering and bounds are applied
 * again here instead of trusting every optional context-file-shaped object.
 * Malformed entries are omitted. Like Codex's AGENTS loader, the final entry
 * may be cut to the remaining total budget; no later file is then admitted.
 */
export function boundAutoReviewerParentInstructions(
  instructions: readonly AutoReviewerParentInstruction[] | undefined,
): AutoReviewerParentInstruction[] {
  if (instructions === undefined) return [];
  const bounded: AutoReviewerParentInstruction[] = [];
  const seenPaths = new Set<string>();
  let totalCharacters = 0;
  for (const candidate of instructions) {
    if (!isRecord(candidate)) continue;
    const path = candidate.path;
    const content = candidate.content;
    if (
      typeof path !== "string" ||
      typeof content !== "string" ||
      !isAbsolute(path) ||
      !TRUSTED_PARENT_INSTRUCTION_BASENAMES.has(basename(path)) ||
      path.length > MAX_GUARDIAN_PARENT_INSTRUCTION_PATH_CHARACTERS ||
      content.length === 0 ||
      seenPaths.has(path)
    ) {
      continue;
    }
    const remainingCharacters = MAX_GUARDIAN_PARENT_INSTRUCTION_CHARACTERS - totalCharacters;
    if (remainingCharacters <= path.length) break;
    const contentBudget = remainingCharacters - path.length;
    const boundedContent = content.slice(0, contentBudget);
    seenPaths.add(path);
    bounded.push({ path, content: boundedContent });
    totalCharacters += path.length + boundedContent.length;
    if (boundedContent.length < content.length) break;
  }
  return bounded;
}

export function renderAutoReviewParentInstructions(
  instructions: readonly AutoReviewerParentInstruction[] | undefined,
): string | undefined {
  const bounded = boundAutoReviewerParentInstructions(instructions);
  if (bounded.length === 0) return undefined;
  return [
    "# Trusted Parent Project Instructions",
    "The host supplied the following bounded AGENTS instructions through its trusted context-file loader. They may establish user authorization according to the Guardian policy for the action under review.",
    ...bounded.map(({ path, content }) =>
      [`<parent_instruction path=${JSON.stringify(path)}>`, content, "</parent_instruction>"].join(
        "\n",
      ),
    ),
  ].join("\n\n");
}

function approvedActionContext(serializedAction: string): string {
  return [
    AUTO_REVIEW_DENIED_ACTION_APPROVAL_DEVELOPER_PREFIX,
    "",
    "Approved action:",
    serializedAction,
  ].join("\n");
}

function parseAssessmentPayload(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("Invalid reviewer output: expected JSON");
    }
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new Error("Invalid reviewer output: expected JSON");
    }
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid reviewer output: expected an object");
  }
  return parsed;
}

export function parseAutoReviewResult(text: string): AutoReviewResult {
  const parsed = parseAssessmentPayload(text);
  if (parsed.outcome !== "allow" && parsed.outcome !== "deny") {
    throw new Error("Invalid reviewer output: invalid outcome");
  }
  if (
    parsed.risk_level !== undefined &&
    parsed.risk_level !== null &&
    !new Set<unknown>(["low", "medium", "high", "critical"]).has(parsed.risk_level)
  ) {
    throw new Error("Invalid reviewer output: invalid risk");
  }
  if (
    parsed.user_authorization !== undefined &&
    parsed.user_authorization !== null &&
    !new Set<unknown>(["unknown", "low", "medium", "high"]).has(parsed.user_authorization)
  ) {
    throw new Error("Invalid reviewer output: invalid user authorization");
  }
  if (
    parsed.rationale !== undefined &&
    parsed.rationale !== null &&
    typeof parsed.rationale !== "string"
  ) {
    throw new Error("Invalid reviewer output: rationale is required");
  }
  const decision = parsed.outcome === "allow" ? "approve" : "deny";
  const risk = (parsed.risk_level ?? (decision === "approve" ? "low" : "high")) as AutoReviewRisk;
  const userAuthorization = (parsed.user_authorization ?? "unknown") as AutoReviewUserAuthorization;
  const rationale =
    typeof parsed.rationale === "string" && parsed.rationale.trim().length > 0
      ? parsed.rationale
      : decision === "approve"
        ? "Auto-review approved this action."
        : "Auto-review returned a deny decision without a rationale.";
  return {
    decision,
    risk,
    userAuthorization,
    rationale,
  };
}
