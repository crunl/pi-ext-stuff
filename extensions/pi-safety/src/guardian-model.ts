import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AutoReviewerContext } from "./auto-review-request.ts";
import { parseReviewerModel } from "./config.ts";
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
      "No usable configured or active reviewer model is available",
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

  // `reviewer.model` is one merged reference; `find` takes the two parts
  // separately. Validation happens at config load, so an unparseable value
  // here means the context was built without going through it — fall back
  // rather than guess, which is the same outcome as an unknown model.
  const reference = parseReviewerModel(context.reviewer.model);
  if (reference === undefined) return verifyActiveModel(context, "active-fallback");

  let preferred: Model<Api> | undefined;
  try {
    preferred = context.modelRegistry.find(reference.provider, reference.model);
  } catch {
    return verifyActiveModel(context, "active-fallback");
  }
  if (preferred && (await hasUsablePiAuth(preferred, context.modelRegistry))) {
    return { model: preferred, source: "configured" };
  }
  return verifyActiveModel(context, "active-fallback");
}
