import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AutoReviewerContext } from "./auto-review-request.ts";
import { AutoReviewerFailure } from "./guardian/errors.ts";

export interface GuardianModelSelection {
  model: Model<Api>;
  source: "configured" | "active" | "active-fallback";
  fallbackNotice?: "configured-reviewer-unavailable";
}

type GuardianModelContext = Pick<AutoReviewerContext, "modelRegistry" | "activeModel" | "reviewer">;

async function hasUsablePiAuth(
  model: Model<Api>,
  modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders">,
): Promise<boolean> {
  try {
    return (await modelRegistry.getApiKeyAndHeaders(model)).ok;
  } catch {
    return false;
  }
}

async function verifyActiveModel(
  context: GuardianModelContext,
  source: "active" | "active-fallback",
): Promise<GuardianModelSelection> {
  if (
    !context.activeModel ||
    !(await hasUsablePiAuth(context.activeModel, context.modelRegistry))
  ) {
    throw new AutoReviewerFailure(
      "unavailable",
      "No usable Guardian or active Pi model is available",
    );
  }

  return {
    model: context.activeModel,
    source,
    ...(source === "active-fallback"
      ? { fallbackNotice: "configured-reviewer-unavailable" as const }
      : {}),
  };
}

export async function resolveGuardianModel(
  context: GuardianModelContext,
): Promise<GuardianModelSelection> {
  if (!context.reviewer) return verifyActiveModel(context, "active");

  let preferred: Model<Api> | undefined;
  try {
    preferred = context.modelRegistry.find(context.reviewer.provider, context.reviewer.model);
  } catch {
    return verifyActiveModel(context, "active-fallback");
  }
  if (preferred && (await hasUsablePiAuth(preferred, context.modelRegistry))) {
    return { model: preferred, source: "configured" };
  }
  return verifyActiveModel(context, "active-fallback");
}
