import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { GuardianReviewInput } from "./approve-for-me-engine.ts";
import type { PermissionsConfig } from "./config.ts";
import { type GuardianAction, guardianActionFromToolCall } from "./guardian-action.ts";
import {
  type GuardianRiskLevel,
  type GuardianUserAuthorization,
  guardianPolicyFloorViolation,
  renderGuardianSystemPrompt,
} from "./guardian-policy.ts";
import { boundGuardianTranscript, type GuardianTranscriptEntry } from "./guardian-transcript.ts";
import type { RiskDecision } from "./risk-policy.ts";
import type { NetworkPolicyView } from "./sandbox-policy.ts";
import { isRecord } from "./unknown-value.ts";

export type AutoReviewRisk = GuardianRiskLevel;
export type AutoReviewUserAuthorization = GuardianUserAuthorization;

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
  sessionKind?: "trunk_new" | "trunk_reused" | "ephemeral_forked";
  hadPriorReviewContext?: boolean;
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
}

export interface AutoReviewApprovalOverride {
  denialId: string;
  actionFingerprint: string;
}

export interface GuardianPermissionContext {
  sandboxProfile: "workspace-write" | "read-only";
  /** Whether this is an ordinary sandbox, exact command escalation, or host tool review. */
  executionMode?: "sandboxed" | "escalated" | "host-admitted";
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
  requestedWholeNetwork?: boolean;
  authorityFreezePoint?: "execution-attempt-after-review";
  baselineNetwork?: NetworkPolicyView;
  effectiveNetwork?: NetworkPolicyView;
  authority?: GuardianReviewInput["authority"];
  permissionLifetime?:
    | "turn-end-after-confirmation"
    | "pending-connection-only"
    | "exact-action-only";
  networkWarning?: string;
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
  /** Raw append-only log + epoch for Delta-mode prompts. */
  transcriptMeta?: {
    epoch: number;
    rawEntries: readonly GuardianTranscriptEntry[];
  };
}

type PromptDecision = Extract<RiskDecision, { action: "prompt" }>;

const MAX_ACTION_CHARACTERS = 16_000;

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
  transcriptEpoch?: number,
  rawTranscript?: readonly GuardianTranscriptEntry[],
): AutoReviewRequest {
  const untrustedAction = guardianActionFromToolCall(event, cwd);
  const enrichedPermissionContext: GuardianPermissionContext = {
    ...structuredClone(permissionContext),
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
  const rawEntries = rawTranscript ?? transcript;
  return {
    toolCallId: event.toolCallId,
    untrustedTranscript: boundGuardianTranscript(rawEntries),
    untrustedAction,
    permissionContext: enrichedPermissionContext,
    ...(approvalOverride === undefined ? {} : { approvalOverride }),
    ...(transcriptEpoch === undefined
      ? {}
      : { transcriptMeta: { epoch: transcriptEpoch, rawEntries } }),
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

/**
 * Delta-mode prompt: prior transcript lives in the reviewer session history;
 * this user message carries only the entries not yet sent.
 */
export function renderDeltaReviewPrompt(
  transcriptDelta: readonly GuardianTranscriptEntry[],
  untrustedAction: unknown,
  permissionContext: unknown,
): string {
  return JSON.stringify({
    untrustedTranscriptDelta: transcriptDelta,
    untrustedAction,
    permissionContext,
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
  const policyViolation = guardianPolicyFloorViolation({
    outcome: parsed.outcome,
    riskLevel: risk,
    userAuthorization,
  });
  if (policyViolation !== undefined) {
    throw new Error(`Invalid reviewer output: ${policyViolation}`);
  }
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
