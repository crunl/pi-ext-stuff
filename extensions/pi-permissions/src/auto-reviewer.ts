import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderStreamOptions,
  TextContent,
} from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { PermissionsConfig } from "./config.ts";
import { resolveGuardianModel } from "./guardian-model.ts";
import { GUARDIAN_REVIEW_TIMEOUT_MS } from "./guardian-policy.ts";
import {
  AUTO_REVIEW_SYSTEM_PROMPT,
  type AutoReviewRequest,
  type AutoReviewResult,
  parseAutoReviewResult,
  renderAutoReviewPrompt,
} from "./auto-review-request.ts";

export interface AutoReviewerContext {
  modelRegistry: Pick<ModelRegistry, "find" | "getApiKeyAndHeaders">;
  activeModel?: Model<Api>;
  reviewer?: PermissionsConfig["reviewer"];
}

export interface AutoReviewer {
  review(
    request: AutoReviewRequest,
    context: AutoReviewerContext,
    signal?: AbortSignal,
  ): Promise<AutoReviewResult>;
}

export type AutoReviewerFailureKind =
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "provider"
  | "parse";

export class AutoReviewerFailure extends Error {
  constructor(
    readonly kind: AutoReviewerFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AutoReviewerFailure";
  }
}

type Complete = (
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions,
) => Promise<AssistantMessage>;

const DEFAULT_REVIEW_REASONING = "medium";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PiAutoReviewer implements AutoReviewer {
  constructor(private readonly invoke: Complete = complete) {}

  async review(
    request: AutoReviewRequest,
    context: AutoReviewerContext,
    callerSignal?: AbortSignal,
  ): Promise<AutoReviewResult> {
    if (callerSignal?.aborted) {
      throw new AutoReviewerFailure("cancelled", "Auto review was cancelled");
    }

    const guardian = await resolveGuardianModel(context);
    if (callerSignal?.aborted) {
      throw new AutoReviewerFailure("cancelled", "Auto review was cancelled");
    }
    const model = guardian.model;

    let auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
    try {
      auth = await context.modelRegistry.getApiKeyAndHeaders(model);
    } catch {
      throw new AutoReviewerFailure(
        "unavailable",
        "No usable Guardian or active Pi model is available",
      );
    }
    if (!auth.ok) {
      throw new AutoReviewerFailure(
        "unavailable",
        "No usable Guardian or active Pi model is available",
      );
    }
    if (callerSignal?.aborted) {
      throw new AutoReviewerFailure("cancelled", "Auto review was cancelled");
    }

    const timeoutMs = GUARDIAN_REVIEW_TIMEOUT_MS;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    const reviewContext: Context = {
      systemPrompt: AUTO_REVIEW_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: renderAutoReviewPrompt(request),
          timestamp: Date.now(),
        },
      ],
    };

    let response: AssistantMessage;
    const abortResponse = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("Auto review aborted"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    try {
      response = await Promise.race([
        this.invoke(model, reviewContext, {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          reasoningEffort:
            context.reviewer?.reasoningEffort ?? DEFAULT_REVIEW_REASONING,
          timeoutMs,
          maxRetries: 0,
          cacheRetention: "none",
          signal,
          sessionId: `pi-permissions-auto-${randomUUID()}`,
        }),
        abortResponse,
      ]);
    } catch {
      if (callerSignal?.aborted) {
        throw new AutoReviewerFailure("cancelled", "Auto review was cancelled");
      }
      if (timeoutSignal.aborted) {
        throw new AutoReviewerFailure("timeout", "Auto review timed out");
      }
      throw new AutoReviewerFailure("provider", "Auto reviewer request failed");
    }
    if (callerSignal?.aborted) {
      throw new AutoReviewerFailure("cancelled", "Auto review was cancelled");
    }
    if (timeoutSignal.aborted) {
      throw new AutoReviewerFailure("timeout", "Auto review timed out");
    }

    if (response.stopReason !== "stop") {
      throw new AutoReviewerFailure(
        "provider",
        `Auto reviewer stopped with ${response.stopReason}`,
      );
    }
    const text = response.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("");
    try {
      return {
        ...parseAutoReviewResult(text),
        guardian: {
          provider: model.provider,
          model: model.id,
          source: guardian.source,
          ...(guardian.fallbackNotice === undefined
            ? {}
            : { fallbackNotice: guardian.fallbackNotice }),
        },
      };
    } catch (error) {
      throw new AutoReviewerFailure(
        "parse",
        `Failed to parse Auto reviewer output: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}
