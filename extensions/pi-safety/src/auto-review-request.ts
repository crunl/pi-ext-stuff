import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { GuardianReviewInput } from "./approve-for-me-engine.ts";
import type { SafetyConfig } from "./config.ts";
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

type AutoReviewRisk = GuardianRiskLevel;
type AutoReviewUserAuthorization = GuardianUserAuthorization;

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
    /** Effort actually used for this review (config or code default). */
    reasoningEffort?: string;
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
  reviewer?: SafetyConfig["reviewer"];
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
  /** Whether this is an ordinary sandbox or a host tool review. */
  executionMode?: "sandboxed" | "host-admitted";
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
  staticRisk?: "Skip" | "NeedsApproval" | "Forbidden";
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

const REVIEWER_DECISION_KEYS = new Set(["outcome", "risk_level", "user_authorization"]);

const DUPLICATE_DECISION_KEY_ERROR = "Invalid reviewer output: duplicate decision field";
const UNVERIFIABLE_DECISION_KEYS_ERROR = "Invalid reviewer output: unverifiable decision fields";

function isDecisionContractError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === DUPLICATE_DECISION_KEY_ERROR ||
      error.message === UNVERIFIABLE_DECISION_KEYS_ERROR)
  );
}

function skipJsonWhitespace(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && " \t\n\r".includes(source[cursor])) cursor += 1;
  return cursor;
}

/**
 * Decode one JSON string member starting at `source[index] === '"'`. Escapes
 * are resolved the way `JSON.parse` resolves them (including `\uXXXX`, so an
 * attacker cannot hide a decision key behind `"\u006ftcome"`); a string that
 * cannot be decoded returns undefined instead of desynchronizing the scanner.
 */
function readJsonString(
  source: string,
  index: number,
): { value: string; next: number } | undefined {
  if (source[index] !== '"') return undefined;
  let cursor = index + 1;
  let value = "";
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '"') return { value, next: cursor + 1 };
    if (char !== "\\") {
      value += char;
      cursor += 1;
      continue;
    }
    const escaped = source[cursor + 1];
    if (escaped === "u") {
      const hex = source.slice(cursor + 2, cursor + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
      // Decision keys are pure ASCII, so decoding each \uXXXX to one code
      // unit matches JSON.parse exactly for key identity; surrogate pairs
      // only ever produce non-matching keys and the cursor still advances
      // past both escapes.
      value += String.fromCharCode(Number.parseInt(hex, 16));
      cursor += 6;
      continue;
    }
    const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    const mapped = escaped === undefined ? undefined : simple[escaped as keyof typeof simple];
    if (mapped === undefined) return undefined;
    value += mapped;
    cursor += 2;
  }
  return undefined;
}

function skipJsonValue(source: string, index: number): number | undefined {
  const cursor = skipJsonWhitespace(source, index);
  const char = source[cursor];
  if (char === '"') return readJsonString(source, cursor)?.next;
  if (char === "{" || char === "[") {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let scan = cursor; scan < source.length; scan += 1) {
      const current = source[scan];
      if (inString) {
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') inString = false;
        continue;
      }
      if (current === '"') inString = true;
      else if (current === "{" || current === "[") depth += 1;
      else if (current === "}" || current === "]") {
        depth -= 1;
        if (depth === 0) return scan + 1;
      }
    }
    return undefined;
  }
  if (char === undefined) return undefined;
  let end = cursor;
  while (end < source.length && !",}]\n\t\r ".includes(source[end])) end += 1;
  return end === cursor ? undefined : end;
}

/**
 * Fail closed on reviewer JSON whose top-level object repeats a decision
 * field. `JSON.parse` silently keeps only the last duplicate member, which
 * would let `{"outcome":"allow","outcome":"deny"}` (or a Unicode-escaped key)
 * collapse below the guardian policy floor. Only top-level decision keys are
 * counted; nested duplicates inside rationale-shaped values stay JSON.parse
 * semantics. Candidates that do not start a top-level object are left to
 * JSON.parse (prose recovery is the caller's brace-slice fallback); an
 * object-looking candidate the scanner cannot traverse throws as
 * unverifiable, never as accepted.
 */
function assertUniqueTopLevelDecisionKeys(source: string): void {
  let cursor = skipJsonWhitespace(source, 0);
  if (source[cursor] !== "{") return;
  cursor = skipJsonWhitespace(source, cursor + 1);
  if (source[cursor] === "}") return;
  const seen = new Set<string>();
  for (;;) {
    const key = readJsonString(source, cursor);
    if (key === undefined) throw new Error(UNVERIFIABLE_DECISION_KEYS_ERROR);
    if (REVIEWER_DECISION_KEYS.has(key.value)) {
      if (seen.has(key.value)) throw new Error(DUPLICATE_DECISION_KEY_ERROR);
      seen.add(key.value);
    }
    cursor = skipJsonWhitespace(source, key.next);
    if (source[cursor] !== ":") throw new Error(UNVERIFIABLE_DECISION_KEYS_ERROR);
    const afterValue = skipJsonValue(source, cursor + 1);
    if (afterValue === undefined) throw new Error(UNVERIFIABLE_DECISION_KEYS_ERROR);
    cursor = skipJsonWhitespace(source, afterValue);
    if (source[cursor] === ",") {
      cursor = skipJsonWhitespace(source, cursor + 1);
      continue;
    }
    if (source[cursor] === "}") return;
    throw new Error(UNVERIFIABLE_DECISION_KEYS_ERROR);
  }
}

function parseAssessmentPayload(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    assertUniqueTopLevelDecisionKeys(text);
    parsed = JSON.parse(text);
  } catch (error) {
    if (isDecisionContractError(error)) throw error;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("Invalid reviewer output: expected JSON");
    }
    try {
      const candidate = text.slice(start, end + 1);
      assertUniqueTopLevelDecisionKeys(candidate);
      parsed = JSON.parse(candidate);
    } catch (sliceError) {
      if (isDecisionContractError(sliceError)) throw sliceError;
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
