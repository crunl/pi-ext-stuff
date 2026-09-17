import { resolve } from "node:path";
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  ProviderStreamOptions,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  type AutoReviewerContext,
  type AutoReviewRequest,
  type AutoReviewResult,
  parseAutoReviewResult,
  renderAutoReviewPrompt,
  renderAutoReviewTrustedContext,
} from "./auto-review-request.ts";
import { fingerprintValue } from "./config.ts";
import { AutoReviewerFailure, type GuardianReviewIdentity } from "./guardian/errors.ts";
import { resolveGuardianModel } from "./guardian-model.ts";
import {
  GUARDIAN_REVIEW_MAX_ATTEMPTS,
  GUARDIAN_REVIEW_MAX_TOOL_ROUNDS,
  GUARDIAN_REVIEW_TIMEOUT_MS,
  guardianRetryDelayMs,
  renderGuardianSystemPrompt,
} from "./guardian-policy.ts";
import { GuardianReviewSessionManager } from "./guardian-session.ts";
import { createIsolatedGuardianToolRuntime, type GuardianToolRuntime } from "./guardian-tools.ts";
import type { GuardianEvidenceScope } from "./sandbox-policy.ts";
import { errorMessage } from "./unknown-value.ts";

export type { AutoReviewerContext } from "./auto-review-request.ts";
export type {
  AutoReviewerFailureKind,
  GuardianReviewIdentity,
} from "./guardian/errors.ts";
export { AutoReviewerFailure } from "./guardian/errors.ts";

export interface AutoReviewer {
  invalidateSession(): void;
  review(
    request: AutoReviewRequest,
    context: TrustedAutoReviewerContext,
    signal?: AbortSignal,
  ): Promise<AutoReviewResult>;
}

/** Host-only review context. Evidence authority is never rendered to the model. */
export interface TrustedAutoReviewerContext extends AutoReviewerContext {
  readonly guardianEvidenceScope: GuardianEvidenceScope;
}

type Complete = (
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions,
) => Promise<AssistantMessage>;

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
type GuardianToolRuntimeFactory = (scope: GuardianEvidenceScope) => GuardianToolRuntime;

/** Codex sync reviewer prefers Low; keep high only via explicit config. */
const DEFAULT_REVIEW_REASONING = "low";
const RETRYABLE_PROVIDER_STATUSES = new Set([500, 502, 503, 504]);
const RETRYABLE_PROVIDER_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "API_CONNECTION_ERROR",
  "CONNECTION_ERROR",
  "OVERLOADED",
  "OVERLOADED_ERROR",
  "SERVER_ERROR",
  "SERVICE_UNAVAILABLE",
  "STREAM_DISCONNECTED",
  "STREAM_ERROR",
  "WEBSOCKET_ERROR",
]);
const RETRYABLE_PROVIDER_MESSAGE =
  /(?:^|\b)(?:server overloaded|internal server error|response stream connection failed|response stream disconnected|WebSocket stream closed before response\.completed)(?:\b|$)/i;

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)
    : undefined;
}

function isTransientProviderFailure(error: unknown): boolean {
  const visited = new Set<object>();
  const statuses: number[] = [];
  let current: unknown = error;
  let transientCodeOrMessage = false;
  for (;;) {
    const record = errorRecord(current);
    if (!record || visited.has(record)) break;
    visited.add(record);
    const metadata = errorRecord(record.$metadata);
    const response = errorRecord(record.$response);
    for (const status of [
      record.status,
      record.statusCode,
      metadata?.httpStatusCode,
      response?.status,
      response?.statusCode,
    ]) {
      if (typeof status === "number") statuses.push(status);
    }
    if (
      typeof record.code === "string" &&
      RETRYABLE_PROVIDER_CODES.has(record.code.toUpperCase())
    ) {
      transientCodeOrMessage = true;
    }
    if (typeof record.message === "string" && RETRYABLE_PROVIDER_MESSAGE.test(record.message)) {
      transientCodeOrMessage = true;
    }
    current = record.cause;
  }
  if (statuses.length > 0) {
    return statuses.every((status) => RETRYABLE_PROVIDER_STATUSES.has(status));
  }
  return transientCodeOrMessage;
}

function cancelledFailure(): AutoReviewerFailure {
  return new AutoReviewerFailure("cancelled", "Auto review was cancelled");
}

function timeoutFailure(guardian: GuardianReviewIdentity): AutoReviewerFailure {
  return new AutoReviewerFailure("timeout", "Auto review timed out", undefined, guardian);
}

/** One shared gate for the per-attempt provider-failure catches: rethrows
 * timeout/fatal failures, returns normally only when a retry is allowed. */
function assertRetryableRequestFailure(
  error: unknown,
  context: { attempt: number; timedOut: boolean; identity: GuardianReviewIdentity },
): void {
  if (context.timedOut) throw timeoutFailure(context.identity);
  if (context.attempt >= GUARDIAN_REVIEW_MAX_ATTEMPTS || !isTransientProviderFailure(error)) {
    throw new AutoReviewerFailure(
      "provider",
      "Auto reviewer request failed",
      { cause: error },
      context.identity,
    );
  }
}

/** Gate for non-"stop" terminal responses: only an upstream "error" stop
 * whose message looks transient may be retried within the attempt budget. */
function assertRetryableStop(
  failure: AutoReviewerFailure,
  context: {
    attempt: number;
    stopReason: string;
    errorMessage?: string;
    identity: GuardianReviewIdentity;
  },
): void {
  if (
    context.attempt >= GUARDIAN_REVIEW_MAX_ATTEMPTS ||
    context.stopReason !== "error" ||
    !isTransientProviderFailure(new Error(context.errorMessage ?? ""))
  ) {
    throw failure;
  }
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Auto review aborted"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error("Auto review aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function completeWithAbort<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Auto review aborted"));
      return;
    }
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Auto review aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    request.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function assistantText(response: AssistantMessage): string {
  return response.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function assistantToolCalls(response: AssistantMessage): ToolCall[] {
  return response.content.filter((part): part is ToolCall => part.type === "toolCall");
}

async function waitBeforeRetry(
  sleep: Sleep,
  attempt: number,
  deadline: number,
  guardian: GuardianReviewIdentity,
  callerSignal?: AbortSignal,
): Promise<void> {
  const delayMs = guardianRetryDelayMs(attempt);
  const remainingMs = deadline - Date.now();
  if (remainingMs <= delayMs) throw timeoutFailure(guardian);
  const deadlineSignal = AbortSignal.timeout(remainingMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadlineSignal]) : deadlineSignal;
  try {
    await sleep(delayMs, signal);
  } catch (error) {
    if (callerSignal?.aborted) throw cancelledFailure();
    if (deadlineSignal.aborted || Date.now() >= deadline) throw timeoutFailure(guardian);
    throw error;
  }
  if (callerSignal?.aborted) throw cancelledFailure();
  if (Date.now() >= deadline) throw timeoutFailure(guardian);
}

function defaultGuardianToolRuntime(scope: GuardianEvidenceScope): GuardianToolRuntime {
  return createIsolatedGuardianToolRuntime(scope);
}

export class PiAutoReviewer implements AutoReviewer {
  constructor(
    private readonly invoke: Complete = complete,
    private readonly sessions = new GuardianReviewSessionManager(),
    private readonly sleep: Sleep = sleepWithAbort,
    private readonly createTools: GuardianToolRuntimeFactory = defaultGuardianToolRuntime,
  ) {}

  invalidateSession(): void {
    this.sessions.invalidate();
  }

  async review(
    request: AutoReviewRequest,
    context: TrustedAutoReviewerContext,
    callerSignal?: AbortSignal,
  ): Promise<AutoReviewResult> {
    if (callerSignal?.aborted) {
      throw cancelledFailure();
    }

    const guardian = await resolveGuardianModel(context);
    if (callerSignal?.aborted) {
      throw cancelledFailure();
    }
    const model = guardian.model;
    const reasoningEffort = context.reviewer?.reasoningEffort ?? DEFAULT_REVIEW_REASONING;
    const guardianIdentity: GuardianReviewIdentity = {
      provider: model.provider,
      model: model.id,
      source: guardian.source,
      reasoningEffort,
      ...(guardian.fallbackNotice === undefined ? {} : { fallbackNotice: guardian.fallbackNotice }),
    };

    let auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
    try {
      auth = await context.modelRegistry.getApiKeyAndHeaders(model);
    } catch {
      throw new AutoReviewerFailure(
        "unavailable",
        "No usable configured or active reviewer model is available",
        undefined,
        guardianIdentity,
      );
    }
    if (!auth.ok) {
      throw new AutoReviewerFailure(
        "unavailable",
        "No usable configured or active reviewer model is available",
        undefined,
        guardianIdentity,
      );
    }
    if (callerSignal?.aborted) {
      throw cancelledFailure();
    }

    if (resolve(context.guardianEvidenceScope.cwd) !== resolve(context.guardianSession.cwd)) {
      throw new AutoReviewerFailure(
        "unavailable",
        "Guardian evidence scope does not match the review session",
        undefined,
        guardianIdentity,
      );
    }
    const toolRuntime = this.createTools(context.guardianEvidenceScope);
    const toolFingerprint = fingerprintValue({
      authorityFingerprint: context.guardianEvidenceScope.authorityFingerprint,
      tools: toolRuntime.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    });
    const trustedContext = renderAutoReviewTrustedContext(request);
    const systemPrompt = renderGuardianSystemPrompt(context.guardianPolicy, trustedContext);
    const closeToolRuntime = async (): Promise<void> => {
      await toolRuntime.close?.();
    };
    let lease: ReturnType<GuardianReviewSessionManager["open"]>;
    try {
      lease = this.sessions.open(
        {
          sessionId: context.guardianSession.sessionId,
          cwd: context.guardianSession.cwd,
          configFingerprint: context.guardianSession.configFingerprint,
          provider: model.provider,
          model: model.id,
          reasoningEffort,
          toolFingerprint,
        },
        renderAutoReviewPrompt(request),
        toolRuntime.tools,
        systemPrompt,
        request.transcriptMeta
          ? {
              epoch: request.transcriptMeta.epoch,
              rawEntries: request.transcriptMeta.rawEntries,
              action: request.untrustedAction,
              permissionContext: request.permissionContext,
            }
          : undefined,
      );
    } catch (error) {
      await closeToolRuntime();
      throw error;
    }
    const deadline = Date.now() + GUARDIAN_REVIEW_TIMEOUT_MS;
    let pendingCommitMessages: Message[] | undefined;
    try {
      reviewAttempts: for (let attempt = 1; attempt <= GUARDIAN_REVIEW_MAX_ATTEMPTS; attempt += 1) {
        let attemptContext = lease.context;
        const attemptMessages: Message[] = [];
        let toolRounds = 0;

        for (;;) {
          if (callerSignal?.aborted) throw cancelledFailure();
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) throw timeoutFailure(guardianIdentity);
          const deadlineSignal = AbortSignal.timeout(remainingMs);
          const signal = callerSignal
            ? AbortSignal.any([callerSignal, deadlineSignal])
            : deadlineSignal;

          let response: AssistantMessage;
          try {
            response = await completeWithAbort(
              this.invoke(model, attemptContext, {
                apiKey: auth.apiKey,
                headers: auth.headers,
                env: auth.env,
                reasoningEffort,
                timeoutMs: remainingMs,
                maxRetries: 0,
                cacheRetention: "short",
                signal,
                sessionId: lease.sessionId,
              }),
              signal,
            );
          } catch (error) {
            if (callerSignal?.aborted) throw cancelledFailure();
            assertRetryableRequestFailure(error, {
              attempt,
              timedOut: deadlineSignal.aborted || Date.now() >= deadline,
              identity: guardianIdentity,
            });
            await waitBeforeRetry(this.sleep, attempt, deadline, guardianIdentity, callerSignal);
            continue reviewAttempts;
          }

          if (callerSignal?.aborted) throw cancelledFailure();
          if (deadlineSignal.aborted || Date.now() >= deadline) {
            throw timeoutFailure(guardianIdentity);
          }
          const toolCalls = assistantToolCalls(response);
          if (toolCalls.length > 0 || response.stopReason === "toolUse") {
            if (response.stopReason !== "toolUse" || toolCalls.length === 0) {
              throw new AutoReviewerFailure(
                "provider",
                `Auto reviewer stopped with ${response.stopReason}`,
                undefined,
                guardianIdentity,
              );
            }
            if (toolRounds >= GUARDIAN_REVIEW_MAX_TOOL_ROUNDS) {
              throw new AutoReviewerFailure(
                "provider",
                `Auto reviewer exceeded ${GUARDIAN_REVIEW_MAX_TOOL_ROUNDS} read-only tool rounds without a final assessment`,
                undefined,
                guardianIdentity,
              );
            }

            let toolResults: ToolResultMessage[];
            try {
              toolResults = await this.executeToolCalls(
                toolRuntime,
                toolCalls,
                deadline,
                guardianIdentity,
                callerSignal,
              );
            } catch (error) {
              if (error instanceof AutoReviewerFailure) throw error;
              if (callerSignal?.aborted) throw cancelledFailure();
              if (Date.now() >= deadline) throw timeoutFailure(guardianIdentity);
              throw new AutoReviewerFailure(
                "provider",
                "Auto reviewer read-only tool execution failed",
                { cause: error },
                guardianIdentity,
              );
            }
            attemptMessages.push(response, ...toolResults);
            attemptContext = lease.extend(attemptMessages);
            toolRounds += 1;
            continue;
          }
          if (response.stopReason !== "stop") {
            assertRetryableStop(
              new AutoReviewerFailure(
                "provider",
                `Auto reviewer stopped with ${response.stopReason}`,
                undefined,
                guardianIdentity,
              ),
              {
                attempt,
                stopReason: response.stopReason,
                errorMessage: response.errorMessage,
                identity: guardianIdentity,
              },
            );
            await waitBeforeRetry(this.sleep, attempt, deadline, guardianIdentity, callerSignal);
            continue reviewAttempts;
          }

          const text = assistantText(response);
          try {
            const result = parseAutoReviewResult(text);
            // Keep the successful turn provisional until the evidence runtime
            // has closed cleanly. A cleanup/reset failure must not persist an
            // approval or its evidence in the next review's session trunk.
            pendingCommitMessages = [...attemptMessages, response];
            return {
              ...result,
              guardian: guardianIdentity,
              sessionKind: lease.sessionKind,
              hadPriorReviewContext: lease.hadPriorReviewContext,
            };
          } catch (error) {
            const failure = new AutoReviewerFailure(
              "parse",
              `Failed to parse Auto reviewer output: ${errorMessage(error)}`,
              { cause: error },
              guardianIdentity,
            );
            if (attempt >= GUARDIAN_REVIEW_MAX_ATTEMPTS) throw failure;
            await waitBeforeRetry(this.sleep, attempt, deadline, guardianIdentity, callerSignal);
            continue reviewAttempts;
          }
        }
      }
      throw new AutoReviewerFailure(
        "provider",
        "Auto reviewer request failed",
        undefined,
        guardianIdentity,
      );
    } finally {
      try {
        await closeToolRuntime();
        if (pendingCommitMessages) lease.commit(pendingCommitMessages);
      } finally {
        lease.release();
      }
    }
  }

  private async executeToolCalls(
    runtime: GuardianToolRuntime,
    toolCalls: ToolCall[],
    deadline: number,
    guardian: GuardianReviewIdentity,
    callerSignal?: AbortSignal,
  ): Promise<ToolResultMessage[]> {
    const results: ToolResultMessage[] = [];
    for (const toolCall of toolCalls) {
      if (callerSignal?.aborted) throw cancelledFailure();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw timeoutFailure(guardian);
      const deadlineSignal = AbortSignal.timeout(remainingMs);
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, deadlineSignal])
        : deadlineSignal;
      try {
        const result = await completeWithAbort(runtime.execute(toolCall, signal), signal);
        results.push(result);
      } catch (error) {
        if (callerSignal?.aborted) throw cancelledFailure();
        if (deadlineSignal.aborted || Date.now() >= deadline) throw timeoutFailure(guardian);
        throw error;
      }
    }
    return results;
  }
}
