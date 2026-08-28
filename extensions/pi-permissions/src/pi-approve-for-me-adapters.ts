import { resolve } from "node:path";

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type {
  AdmissionPlan,
  CapabilityRequest,
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
import type { AutoReviewer } from "./auto-reviewer.ts";
import { fingerprintValue } from "./config.ts";
import type { GuardianTranscriptEntry } from "./guardian-transcript.ts";
import type { RiskDecision } from "./risk-policy.ts";
import type { SandboxPolicy } from "./sandbox.ts";

/**
 * Trusted host data needed to turn an Engine review into the production
 * Guardian implementation. The Engine owns authorization state; this object
 * only carries the evidence and runtime context needed by the reviewer.
 */
export interface PiGuardianReviewContext {
  event: ToolCallEvent;
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

function requestedCapabilities(decision: Extract<RiskDecision, { action: "prompt" }>): {
  requested: CapabilityRequestInput[];
  networkHosts: string[];
  filesystemWriteRoots: string[];
} {
  const networkHosts = [...(decision.networkHosts ?? [])];
  const filesystemWriteRoots = [...(decision.filesystemWriteRoots ?? [])];
  const requested: CapabilityRequestInput[] = [
    ...networkHosts.map((host): CapabilityRequestInput => ({ kind: "network", host })),
    ...filesystemWriteRoots.map(
      (path): CapabilityRequestInput => ({
        kind: "filesystem",
        operation: "write",
        path,
      }),
    ),
  ];
  return { requested, networkHosts, filesystemWriteRoots };
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

  const { requested } = requestedCapabilities(decision);
  return {
    kind: "review",
    risk: decision.risk,
    ...(requested.length > 0 ? { requested } : {}),
    review: requested.length > 0 ? "capability" : "action",
    reason: decision.reason,
    summary: decision.summary,
    ...(decision.executionPlan === undefined ? {} : { execution: decision.executionPlan }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return input.transcript.filter(isTranscriptEntry);
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
  return input.effective.policy ?? context.baseSandboxPolicy;
}

function guardianPermissionContext(
  input: GuardianReviewInput<PiGuardianReviewContext>,
  decision: PromptRiskDecision,
): {
  sandboxProfile: "workspace-write" | "read-only";
  sandboxEnforcesAction: boolean;
  filesystemWriteRoots: string[];
  filesystemDenyRead: string[];
  filesystemDenyWrite: string[];
  requestedNetworkHosts: string[];
  allowedNetworkHosts: string[];
  deniedNetworkHosts: string[];
  staticRisk: "LOW" | "REVIEW" | "HARD";
  staticReason: string;
  justification?: string;
} {
  const policy = policyForReview(input);
  const requested = requestedCapabilities(decision);
  return {
    sandboxProfile: input.context.sandboxProfile,
    sandboxEnforcesAction: input.ownership !== "host-admission" && input.context.sandboxEnabled,
    filesystemWriteRoots: [...(policy?.filesystem.allowWrite ?? [])],
    filesystemDenyRead: [...(policy?.filesystem.denyRead ?? [])],
    filesystemDenyWrite: [...(policy?.filesystem.denyWrite ?? [])],
    requestedNetworkHosts: requested.networkHosts,
    allowedNetworkHosts: [...(policy?.network.allowedDomains ?? [])],
    deniedNetworkHosts: [...(policy?.network.deniedDomains ?? [])],
    staticRisk: decision.risk,
    staticReason: decision.reason,
    ...(decision.justification === undefined ? {} : { justification: decision.justification }),
  };
}

function promptDecisionFromEngine(
  input: GuardianReviewInput<PiGuardianReviewContext>,
): PromptRiskDecision {
  const requested = input.requested;
  const networkHosts = requested
    .filter(
      (request): request is Extract<CapabilityRequest, { kind: "network" }> =>
        request.kind === "network",
    )
    .map((request) => request.host);
  const filesystemWriteRoots = requested
    .filter(
      (request): request is Extract<CapabilityRequest, { kind: "filesystem" }> =>
        request.kind === "filesystem" && request.operation === "write",
    )
    .map((request) => request.path);
  return {
    action: "prompt",
    risk: input.risk ?? "REVIEW",
    reason: input.reason ?? "Permission review requested",
    summary: input.summary ?? input.call.tool,
    ...(networkHosts.length > 0 ? { networkHosts } : {}),
    ...(filesystemWriteRoots.length > 0 ? { filesystemWriteRoots } : {}),
    ...(input.source === "permission-amendment" && input.reason !== undefined
      ? { justification: input.reason }
      : {}),
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
      const result = await autoReviewer.review(request, input.context.autoReviewerContext, signal);
      input.context.onResult?.(result);
      return result.decision === "approve"
        ? { kind: "approve", rationale: result.rationale }
        : { kind: "deny", rationale: result.rationale };
    },
  };
}
