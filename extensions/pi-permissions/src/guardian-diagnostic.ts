import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderStreamOptions,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { AutoReviewRequest, AutoReviewResult } from "./auto-review-request.ts";
import { type AutoReviewer, PiAutoReviewer } from "./auto-reviewer.ts";
import { AutoReviewerFailure, type AutoReviewerFailureKind } from "./guardian/errors.ts";
import {
  GuardianWorkerAbortError,
  type GuardianWorkerFailure,
  GuardianWorkerInfrastructureError,
  GuardianWorkerProtocolError,
} from "./guardian-worker-client.ts";
import { createGuardianEvidenceScope, type SandboxPolicy } from "./sandbox-policy.ts";

const DIAGNOSTIC_CALL_ID = "guardian-diagnostic-call-1";
const DIAGNOSTIC_REVIEW_ID = "guardian-diagnostic-review-1";
const DIAGNOSTIC_TOOL_ID = "guardian-diagnostic-evidence-1";
const DIAGNOSTIC_MARKER = "guardian-diagnostic-ok";
const MAX_EVENT_BYTES = 512;

type DiagnosticComplete = (
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions,
) => Promise<AssistantMessage>;

export type GuardianDiagnosticPhase =
  | "diagnostic.start"
  | "reviewer.tool-request"
  | "guardian.evidence-received"
  | "guardian.cleanup-complete"
  | "diagnostic.complete"
  | "diagnostic.failed";

export type GuardianDiagnosticFailure =
  | GuardianWorkerFailure
  | { readonly stage: "review"; readonly code: AutoReviewerFailureKind | "failed" };

export interface GuardianDiagnosticEvent {
  schemaVersion: 2;
  phase: GuardianDiagnosticPhase;
  status: "running" | "pass" | "fail";
  callId: string;
  reviewId: string;
  failedAt?: Exclude<GuardianDiagnosticPhase, "diagnostic.failed">;
  failure?: GuardianDiagnosticFailure;
}

export interface GuardianDiagnosticResult {
  exitCode: 0 | 1;
  failure?: GuardianDiagnosticFailure;
}

interface GuardianDiagnosticOptions {
  cwd: string;
  emit: (event: GuardianDiagnosticEvent) => void;
  reviewer?: Pick<AutoReviewer, "review">;
}

const LOCAL_REVIEWER_MODEL: Model<Api> = {
  id: "guardian-diagnostic-local",
  name: "Guardian diagnostic local reviewer",
  api: "openai-responses",
  provider: "guardian-diagnostic",
  baseUrl: "http://127.0.0.1.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_024,
  maxTokens: 256,
};

const DIAGNOSTIC_PARENT_POLICY: SandboxPolicy = {
  filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
  network: {
    allowedDomains: [],
    deniedDomains: ["*"],
    trustedFakeIpRanges: [],
    allowLocalBinding: false,
  },
};

const DIAGNOSTIC_REQUEST = (cwd: string): AutoReviewRequest => ({
  toolCallId: DIAGNOSTIC_CALL_ID,
  untrustedTranscript: [
    {
      role: "user",
      content: "Run the read-only Guardian runtime diagnostic.",
    },
  ],
  untrustedAction: {
    kind: "shell",
    toolCallId: DIAGNOSTIC_CALL_ID,
    command: `printf ${DIAGNOSTIC_MARKER}`,
    cwd,
  },
  permissionContext: {
    sandboxProfile: "read-only",
    sandboxEnforcesAction: true,
    filesystemWriteRoots: [],
    filesystemDenyRead: [],
    filesystemDenyWrite: [],
    requestedNetworkTargets: [],
    allowedNetworkHosts: [],
    deniedNetworkHosts: ["*"],
    staticRisk: "REVIEW",
    staticReason: "Guardian runtime diagnostic",
  },
});

function diagnosticEvent(
  phase: GuardianDiagnosticPhase,
  status: GuardianDiagnosticEvent["status"],
  extra: Pick<GuardianDiagnosticEvent, "failedAt" | "failure"> = {},
): GuardianDiagnosticEvent {
  return {
    schemaVersion: 2,
    phase,
    status,
    callId: DIAGNOSTIC_CALL_ID,
    reviewId: DIAGNOSTIC_REVIEW_ID,
    ...extra,
  };
}

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: LOCAL_REVIEWER_MODEL.api,
    provider: LOCAL_REVIEWER_MODEL.provider,
    model: LOCAL_REVIEWER_MODEL.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

function toolResultText(result: ToolResultMessage): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function createLocalReviewerStub(
  emit: (event: GuardianDiagnosticEvent) => void,
): DiagnosticComplete {
  let round = 0;
  return async (_model, context) => {
    round += 1;
    if (round === 1) {
      if (!context.tools?.some((tool) => tool.name === "inspect")) {
        throw new GuardianWorkerInfrastructureError(
          "Guardian diagnostic is unsupported on this platform",
          undefined,
          { stage: "initialization", code: "unsupported" },
        );
      }
      emit(diagnosticEvent("reviewer.tool-request", "running"));
      return assistantMessage(
        [
          {
            type: "toolCall",
            id: DIAGNOSTIC_TOOL_ID,
            name: "inspect",
            arguments: { command: `printf ${DIAGNOSTIC_MARKER}` },
          },
        ],
        "toolUse",
      );
    }

    const result = context.messages.findLast(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === DIAGNOSTIC_TOOL_ID,
    );
    if (
      round !== 2 ||
      !result ||
      result.isError ||
      !toolResultText(result).includes(DIAGNOSTIC_MARKER)
    ) {
      throw new GuardianWorkerProtocolError(
        "Guardian diagnostic evidence did not match the fixed marker",
      );
    }
    emit(diagnosticEvent("guardian.evidence-received", "running"));
    return assistantMessage(
      [
        {
          type: "text",
          text: JSON.stringify({
            risk_level: "low",
            user_authorization: "high",
            outcome: "allow",
            rationale: "The read-only local diagnostic completed successfully.",
          }),
        },
      ],
      "stop",
    );
  };
}

export function classifyGuardianDiagnosticFailure(error: unknown): GuardianDiagnosticFailure {
  const visited = new Set<object>();
  let reviewerFailure: GuardianDiagnosticFailure | undefined;
  let current = error;
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if (current instanceof GuardianWorkerInfrastructureError) {
      return { stage: current.failure.stage, code: current.failure.code };
    }
    if (current instanceof GuardianWorkerAbortError) {
      return { stage: "transport", code: "cancelled" };
    }
    if (current instanceof AutoReviewerFailure) {
      reviewerFailure ??= { stage: "review", code: current.kind };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return reviewerFailure ?? { stage: "review", code: "failed" };
}

export function serializeGuardianDiagnosticEvent(event: GuardianDiagnosticEvent): string {
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized) > MAX_EVENT_BYTES) {
    throw new Error("Guardian diagnostic event exceeds its output bound");
  }
  return serialized;
}

export async function runGuardianSrtDiagnostic(
  options: GuardianDiagnosticOptions,
): Promise<GuardianDiagnosticResult> {
  let lastPhase: Exclude<GuardianDiagnosticPhase, "diagnostic.failed"> = "diagnostic.start";
  const emit = (event: GuardianDiagnosticEvent): void => {
    if (event.phase !== "diagnostic.failed") lastPhase = event.phase;
    options.emit(event);
  };
  emit(diagnosticEvent("diagnostic.start", "running"));

  try {
    const evidenceScope = createGuardianEvidenceScope(options.cwd, DIAGNOSTIC_PARENT_POLICY);
    const reviewer = options.reviewer ?? new PiAutoReviewer(createLocalReviewerStub(emit));
    const result: AutoReviewResult = await reviewer.review(DIAGNOSTIC_REQUEST(options.cwd), {
      guardianSession: {
        sessionId: DIAGNOSTIC_REVIEW_ID,
        cwd: options.cwd,
        configFingerprint: "guardian-diagnostic-v1",
      },
      guardianEvidenceScope: evidenceScope,
      modelRegistry: {
        find: () => undefined,
        getApiKeyAndHeaders: async () => ({ ok: true }),
      },
      activeModel: LOCAL_REVIEWER_MODEL,
    });
    if (result.decision !== "approve") {
      throw new Error("Guardian diagnostic reviewer did not approve the fixed read-only action");
    }
    emit(diagnosticEvent("guardian.cleanup-complete", "pass"));
    emit(diagnosticEvent("diagnostic.complete", "pass"));
    return { exitCode: 0 };
  } catch (error) {
    const failure = classifyGuardianDiagnosticFailure(error);
    emit(
      diagnosticEvent("diagnostic.failed", "fail", {
        failedAt: lastPhase,
        failure,
      }),
    );
    return { exitCode: 1, failure };
  }
}
