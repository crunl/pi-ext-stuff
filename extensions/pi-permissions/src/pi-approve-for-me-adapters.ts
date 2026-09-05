import { resolve } from "node:path";

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type {
  AdmissionPlan,
  CapabilityRequestInput,
  GuardianAdapter,
  GuardianReviewInput,
} from "./approve-for-me-engine.ts";
import {
  type AutoReviewApprovalOverride,
  type AutoReviewerContext,
  type AutoReviewResult,
  buildAutoReviewRequest,
} from "./auto-review-request.ts";
import {
  type AutoReviewer,
  AutoReviewerFailure,
  type TrustedAutoReviewerContext,
} from "./auto-reviewer.ts";
import { fingerprintValue } from "./config.ts";
import type { GuardianTranscriptEntry } from "./guardian-transcript.ts";
import type { RiskDecision } from "./risk-policy.ts";
import {
  createGuardianEvidencePolicyCeiling,
  createGuardianEvidenceScope,
  type GuardianEvidenceScope,
  type SandboxPolicy,
} from "./sandbox.ts";
import { errorMessage, isRecord } from "./unknown-value.ts";

/**
 * Trusted host data needed to turn an Engine review into the production
 * Guardian implementation. The Engine owns authorization state; this object
 * only carries the evidence and runtime context needed by the reviewer.
 */
export interface PiGuardianReviewContext {
  event: ToolCallEvent;
  transcript: readonly GuardianTranscriptEntry[];
  autoReviewerContext: AutoReviewerContext;
  sandboxProfile: "workspace-write" | "read-only";
  sandboxEnabled: boolean;
  baseSandboxPolicy?: SandboxPolicy;
  onResult?: (result: AutoReviewResult) => void;
}

type PiGuardianInput = GuardianReviewInput<PiGuardianReviewContext> & {
  /** Added by the Engine for the explicit /approve exact retry path. */
  approvalOverride?: AutoReviewApprovalOverride;
};

type PromptRiskDecision = Extract<RiskDecision, { action: "prompt" }>;

const INVALID_GUARDIAN_IDENTITY =
  "pi-permissions: reviewer event identity does not match Engine invocation";

export function toolCallEventMetadata(event: ToolCallEvent): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event as unknown as Record<string, unknown>)) {
    if (key === "type" || key === "toolCallId" || key === "toolName" || key === "input") continue;
    metadata[key] = value;
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function requestedCapabilities(
  decision: Extract<RiskDecision, { action: "prompt" }>,
): CapabilityRequestInput[] {
  return [
    ...(decision.networkHosts ?? []).map(
      (host): CapabilityRequestInput => ({ kind: "network", host }),
    ),
    ...(decision.filesystemWriteRoots ?? []).map(
      (path): CapabilityRequestInput => ({
        kind: "filesystem",
        operation: "write",
        path,
      }),
    ),
  ];
}

/**
 * Translate the legacy/static risk vocabulary into the Engine's admission
 * vocabulary. This is intentionally a projection, not an authorization
 * decision: the Engine and its execution Adapter remain authoritative.
 */
export function admissionPlanFromRiskDecision(decision: RiskDecision): AdmissionPlan {
  if (decision.action === "block") {
    return { kind: "deny", reason: decision.reason };
  }
  if (decision.action === "allow") {
    return { kind: "allow" };
  }

  const requested = requestedCapabilities(decision);
  return {
    kind: "review",
    risk: decision.risk,
    ...(requested.length > 0 ? { requested } : {}),
    review: requested.length > 0 ? "capability" : "action",
    reason: decision.reason,
    summary: decision.summary,
    ...(decision.executionMode === undefined ? {} : { executionMode: decision.executionMode }),
    ...(decision.justification === undefined ? {} : { justification: decision.justification }),
  };
}

function isTranscriptEntry(value: unknown): value is GuardianTranscriptEntry {
  if (
    !isRecord(value) ||
    (value.role !== "user" && value.role !== "assistant" && value.role !== "tool")
  ) {
    return false;
  }
  if (typeof value.content !== "string") return false;
  if (value.role === "tool") {
    return typeof value.toolName === "string" && typeof value.isError === "boolean";
  }
  return true;
}

function transcriptFromEngine(
  input: GuardianReviewInput<PiGuardianReviewContext>,
): GuardianTranscriptEntry[] {
  return input.context.transcript.filter(isTranscriptEntry).map((entry) => ({ ...entry }));
}

function approvalOverrideFromEngine(
  input: GuardianReviewInput<PiGuardianReviewContext>,
): AutoReviewApprovalOverride | undefined {
  const candidate = (input as PiGuardianInput).approvalOverride;
  if (
    !isRecord(candidate) ||
    typeof candidate.denialId !== "string" ||
    typeof candidate.actionFingerprint !== "string"
  ) {
    return undefined;
  }
  return candidate;
}

function assertEventMatchesCall(input: PiGuardianInput): void {
  const event = input.context.event;
  if (
    event.toolCallId !== input.call.id ||
    event.toolName !== input.call.tool ||
    fingerprintValue(event.input) !== fingerprintValue(input.call.input) ||
    fingerprintValue({ metadata: toolCallEventMetadata(event) }) !==
      fingerprintValue({ metadata: input.call.metadata }) ||
    resolve(input.context.autoReviewerContext.guardianSession.cwd) !== resolve(input.call.cwd)
  ) {
    throw new Error(INVALID_GUARDIAN_IDENTITY);
  }
}

function policyForReview(
  input: GuardianReviewInput<PiGuardianReviewContext>,
): SandboxPolicy | undefined {
  const context = input.context;
  if (input.ownership === "host-admission") {
    // Host-admission tools execute under their own host authority. A true
    // sandbox-enabled flag describes the coding-agent process only; it does
    // not mean an external MCP/custom tool is isolated by the sandbox adapter.
    return undefined;
  }
  if (input.effective.mode === "escalated") {
    // A one-shot escalated lease carries no sandbox policy. Evidence still
    // comes from the separate baseline lease in evidenceScopeForReview().
    return undefined;
  }
  return input.effective.policy ?? context.baseSandboxPolicy;
}

function evidenceScopeForReview(
  input: GuardianReviewInput<PiGuardianReviewContext>,
): GuardianEvidenceScope {
  const parentPolicy =
    input.ownership === "host-admission"
      ? (input.context.baseSandboxPolicy ??
        (input.context.sandboxEnabled ? undefined : createGuardianEvidencePolicyCeiling()))
      : input.baseline.policy;
  if (!parentPolicy) {
    throw new Error("Guardian review requires a trusted parent evidence policy");
  }
  return createGuardianEvidenceScope(input.call.cwd, parentPolicy);
}

function guardianPermissionContext(
  input: GuardianReviewInput<PiGuardianReviewContext>,
  decision: PromptRiskDecision,
): {
  sandboxProfile: "workspace-write" | "read-only";
  executionMode: "sandboxed" | "escalated" | "host-admitted";
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
  staticRisk: "LOW" | "REVIEW" | "HARD";
  staticReason: string;
  justification?: string;
} {
  const policy = policyForReview(input);
  const escalated = input.effective.mode === "escalated";
  const hostAdmitted = input.ownership === "host-admission";
  const requestedNetworkTargets = input.requested.flatMap((request) =>
    request.kind === "network"
      ? [
          {
            host: request.host,
            ...(request.port === undefined ? {} : { port: request.port }),
            ...(request.protocol === undefined ? {} : { protocol: request.protocol }),
          },
        ]
      : [],
  );
  return {
    sandboxProfile: input.context.sandboxProfile,
    executionMode: escalated ? "escalated" : hostAdmitted ? "host-admitted" : "sandboxed",
    sandboxEnforcesAction: !hostAdmitted && !escalated && input.context.sandboxEnabled,
    // Escalated execution has no sandbox grant or effective filesystem/network
    // policy. The baseline remains separate reviewer evidence.
    filesystemWriteRoots: escalated ? [] : [...(policy?.filesystem.allowWrite ?? [])],
    filesystemDenyRead: escalated ? [] : [...(policy?.filesystem.denyRead ?? [])],
    filesystemDenyWrite: escalated ? [] : [...(policy?.filesystem.denyWrite ?? [])],
    requestedNetworkTargets,
    allowedNetworkHosts: escalated ? [] : [...(policy?.network.allowedDomains ?? [])],
    deniedNetworkHosts: escalated ? [] : [...(policy?.network.deniedDomains ?? [])],
    staticRisk: decision.risk,
    staticReason: decision.reason,
    ...(decision.justification === undefined ? {} : { justification: decision.justification }),
  };
}

function promptDecisionFromEngine(
  input: GuardianReviewInput<PiGuardianReviewContext>,
): PromptRiskDecision {
  return {
    action: "prompt",
    risk: input.risk ?? "REVIEW",
    reason: input.reason ?? "Permission review requested",
    summary: input.summary ?? input.call.tool,
    ...(input.source === "permission-amendment" && input.reason !== undefined
      ? { justification: input.reason }
      : {}),
    ...(input.executionMode === undefined ? {} : { executionMode: input.executionMode }),
    ...(input.justification === undefined ? {} : { justification: input.justification }),
  };
}

export function createPiGuardianAdapter(
  autoReviewer: AutoReviewer,
): GuardianAdapter<PiGuardianReviewContext> {
  return {
    async review(input, signal) {
      const piInput = input as PiGuardianInput;
      assertEventMatchesCall(piInput);
      const decision = promptDecisionFromEngine(input);
      const permissionContext = guardianPermissionContext(input, decision);
      const request = buildAutoReviewRequest(
        input.context.event,
        decision,
        input.call.cwd,
        permissionContext,
        transcriptFromEngine(input),
        approvalOverrideFromEngine(input),
      );
      let result: AutoReviewResult;
      try {
        const reviewerContext: TrustedAutoReviewerContext = {
          ...input.context.autoReviewerContext,
          guardianEvidenceScope: evidenceScopeForReview(input),
        };
        result = await autoReviewer.review(request, reviewerContext, signal);
      } catch (error) {
        if (error instanceof AutoReviewerFailure) {
          if (error.kind === "timeout") return { kind: "timed-out" };
          if (error.kind === "cancelled") return { kind: "cancelled" };
        }
        return { kind: "failed", reason: errorMessage(error) };
      }
      try {
        input.context.onResult?.(result);
      } catch {
        // Reviewer identity/status reporting is observational. A UI or event
        // consumer must never turn an approval into an authorization failure.
      }
      return result.decision === "approve"
        ? { kind: "approve", rationale: result.rationale }
        : { kind: "deny", rationale: result.rationale };
    },
  };
}
