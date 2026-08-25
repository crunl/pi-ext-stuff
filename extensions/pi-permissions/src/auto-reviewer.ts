import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderStreamOptions,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  type AutoReviewRequest,
  type AutoReviewResult,
  type AutoReviewerContext,
  parseAutoReviewResult,
  renderAutoReviewPrompt,
} from "./auto-review-request.ts";
import { resolveGuardianModel } from "./guardian-model.ts";
import {
  GUARDIAN_REVIEW_MAX_ATTEMPTS,
  GUARDIAN_REVIEW_TIMEOUT_MS,
  guardianRetryDelayMs,
  renderGuardianSystemPrompt,
} from "./guardian-policy.ts";
import { GuardianReviewSessionManager } from "./guardian-session.ts";
import { createGuardianToolRuntime, type GuardianToolRuntime } from "./guardian-tools.ts";
import {
  AutoReviewerFailure,
  type GuardianReviewIdentity,
} from "./guardian/errors.ts";

export type {
  AutoReviewerFailureKind,
  GuardianReviewIdentity,
} from "./guardian/errors.ts";
export { AutoReviewerFailure } from "./guardian/errors.ts";
export type { AutoReviewerContext } from "./auto-review-request.ts";

export interface AutoReviewer {
  invalidateSession(): void;
  review(
    request: AutoReviewRequest,
    context: AutoReviewerContext,
    signal?: AbortSignal,
  ): Promise<AutoReviewResult>;
}

type Complete = (
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions,
) => Promise<AssistantMessage>;

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
type GuardianToolRuntimeFactory = (cwd: string) => GuardianToolRuntime;

const DEFAULT_REVIEW_REASONING = "medium";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

export class PiAutoReviewer implements AutoReviewer {
  constructor(
    private readonly invoke: Complete = complete,
    private readonly sessions = new GuardianReviewSessionManager(),
    private readonly sleep: Sleep = sleepWithAbort,
    private readonly createTools: GuardianToolRuntimeFactory = createGuardianToolRuntime,
  ) {}

  invalidateSession(): void {
    this.sessions.invalidate();
  }

  async review(
    request: AutoReviewRequest,
    context: AutoReviewerContext,
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
    const guardianIdentity: GuardianReviewIdentity = {
      provider: model.provider,
      model: model.id,
      source: guardian.source,
      ...(guardian.fallbackNotice === undefined ? {} : { fallbackNotice: guardian.fallbackNotice }),
    };

    let auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
    try {
      auth = await context.modelRegistry.getApiKeyAndHeaders(model);
    } catch {
      throw new AutoReviewerFailure(
        "unavailable",
        "No usable Guardian or active Pi model is available",
        undefined,
        guardianIdentity,
      );
    }
    if (!auth.ok) {
      throw new AutoReviewerFailure(
        "unavailable",
        "No usable Guardian or active Pi model is available",
        undefined,
        guardianIdentity,
      );
    }
    if (callerSignal?.aborted) {
      throw cancelledFailure();
    }

    const toolRuntime = this.createTools(context.guardianSession.cwd);
    const systemPrompt = renderGuardianSystemPrompt(context.guardianPolicy);
    const lease = this.sessions.open(
      {
        cwd: context.guardianSession.cwd,
        configFingerprint: context.guardianSession.configFingerprint,
        provider: model.provider,
        model: model.id,
      },
      renderAutoReviewPrompt(request),
      toolRuntime.tools,
      systemPrompt,
    );
    const deadline = Date.now() + GUARDIAN_REVIEW_TIMEOUT_MS;
    try {
      for (let attempt = 1; attempt <= GUARDIAN_REVIEW_MAX_ATTEMPTS; attempt += 1) {
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
            this.invoke(model, lease.context, {
              apiKey: auth.apiKey,
              headers: auth.headers,
              env: auth.env,
              reasoningEffort: context.reviewer?.reasoningEffort ?? DEFAULT_REVIEW_REASONING,
              timeoutMs: remainingMs,
              maxRetries: 0,
              cacheRetention: "none",
              signal,
              sessionId: lease.sessionId,
            }),
            signal,
          );
        } catch (error) {
          if (callerSignal?.aborted) throw cancelledFailure();
          if (deadlineSignal.aborted || Date.now() >= deadline) {
            throw timeoutFailure(guardianIdentity);
          }
          if (attempt >= GUARDIAN_REVIEW_MAX_ATTEMPTS || !isTransientProviderFailure(error)) {
            throw new AutoReviewerFailure(
              "provider",
              "Auto reviewer request failed",
              {
                cause: error,
              },
              guardianIdentity,
            );
          }
          await waitBeforeRetry(this.sleep, attempt, deadline, guardianIdentity, callerSignal);
          continue;
        }

        if (callerSignal?.aborted) throw cancelledFailure();
        if (deadlineSignal.aborted || Date.now() >= deadline) {
          throw timeoutFailure(guardianIdentity);
        }
        const toolCalls = assistantToolCalls(response);
        if (toolCalls.length > 0 || response.stopReason === "toolUse") {
          const toolUseResponse = response;
          if (response.stopReason !== "toolUse" || toolCalls.length === 0) {
            throw new AutoReviewerFailure(
              "provider",
              `Auto reviewer stopped with ${response.stopReason}`,
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

          const extendedContext = lease.extend([response, ...toolResults]);
          if (callerSignal?.aborted) throw cancelledFailure();
          const secondRemainingMs = deadline - Date.now();
          if (secondRemainingMs <= 0) throw timeoutFailure(guardianIdentity);
          const secondDeadlineSignal = AbortSignal.timeout(secondRemainingMs);
          const secondSignal = callerSignal
            ? AbortSignal.any([callerSignal, secondDeadlineSignal])
            : secondDeadlineSignal;

          try {
            response = await completeWithAbort(
              this.invoke(model, extendedContext, {
                apiKey: auth.apiKey,
                headers: auth.headers,
                env: auth.env,
                reasoningEffort: context.reviewer?.reasoningEffort ?? DEFAULT_REVIEW_REASONING,
                timeoutMs: secondRemainingMs,
                maxRetries: 0,
                cacheRetention: "none",
                signal: secondSignal,
                sessionId: lease.sessionId,
              }),
              secondSignal,
            );
          } catch (error) {
            if (callerSignal?.aborted) throw cancelledFailure();
            if (secondDeadlineSignal.aborted || Date.now() >= deadline) {
              throw timeoutFailure(guardianIdentity);
            }
            if (attempt >= GUARDIAN_REVIEW_MAX_ATTEMPTS || !isTransientProviderFailure(error)) {
              throw new AutoReviewerFailure(
                "provider",
                "Auto reviewer request failed",
                {
                  cause: error,
                },
                guardianIdentity,
              );
            }
            await waitBeforeRetry(this.sleep, attempt, deadline, guardianIdentity, callerSignal);
            continue;
          }

          if (callerSignal?.aborted) throw cancelledFailure();
          if (secondDeadlineSignal.aborted || Date.now() >= deadline) {
            throw timeoutFailure(guardianIdentity);
          }
          const finalToolCalls = assistantToolCalls(response);
          if (finalToolCalls.length > 0 || response.stopReason === "toolUse") {
            throw new AutoReviewerFailure(
              "provider",
              "Auto reviewer returned another tool-use response instead of a final assessment",
              undefined,
              guardianIdentity,
            );
          }

          if (response.stopReason !== "stop") {
            const failure = new AutoReviewerFailure(
              "provider",
              `Auto reviewer stopped with ${response.stopReason}`,
              undefined,
              guardianIdentity,
            );
            if (
              attempt >= GUARDIAN_REVIEW_MAX_ATTEMPTS ||
              response.stopReason !== "error" ||
              !isTransientProviderFailure(new Error(response.errorMessage ?? ""))
            ) {
              throw failure;
            }
            await waitBeforeRetry(this.sleep, attempt, deadline, guardianIdentity, callerSignal);
            continue;
          }

          const text = assistantText(response);
          try {
            const result = parseAutoReviewResult(text);
            if (
              result.decision === "approve" &&
              toolResults.some((toolResult) => toolResult.isError)
            ) {
              throw new AutoReviewerFailure(
                "provider",
                "Auto reviewer cannot approve after a read-only Guardian tool error",
                undefined,
                guardianIdentity,
              );
            }
            lease.commit([toolUseResponse, ...toolResults, response]);
            return {
              ...result,
              guardian: guardianIdentity,
            };
          } catch (error) {
            if (error instanceof AutoReviewerFailure) throw error;
            const failure = new AutoReviewerFailure(
              "parse",
              `Failed to parse Auto reviewer output: ${errorMessage(error)}`,
              { cause: error },
              guardianIdentity,
            );
            if (attempt >= GUARDIAN_REVIEW_MAX_ATTEMPTS) throw failure;
            await waitBeforeRetry(this.sleep, attempt, deadline, guardianIdentity, callerSignal);
          }
          continue;
        }
        if (response.stopReason !== "stop") {
          const failure = new AutoReviewerFailure(
            "provider",
            `Auto reviewer stopped with ${response.stopReason}`,
            undefined,
            guardianIdentity,
          );
          if (
            attempt >= GUARDIAN_REVIEW_MAX_ATTEMPTS ||
            response.stopReason !== "error" ||
            !isTransientProviderFailure(new Error(response.errorMessage ?? ""))
          ) {
            throw failure;
          }
          await waitBeforeRetry(this.sleep, attempt, deadline, guardianIdentity, callerSignal);
          continue;
        }

        const text = assistantText(response);
        try {
          const result = parseAutoReviewResult(text);
          lease.commit([response]);
          return {
            ...result,
            guardian: guardianIdentity,
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
        }
      }
      throw new AutoReviewerFailure(
        "provider",
        "Auto reviewer request failed",
        undefined,
        guardianIdentity,
      );
    } finally {
      lease.release();
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
