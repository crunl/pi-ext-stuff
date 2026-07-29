import type {
  AutoReviewRequest,
  AutoReviewResult,
} from "./auto-review-request.ts";
import {
  type AutoReviewer,
  type AutoReviewerContext,
  AutoReviewerFailure,
} from "./auto-reviewer.ts";
import {
  type AutoState,
  recordAutoApproval,
  recordAutoDenial,
} from "./modes/auto.ts";

export type AutoPolicyResult =
  | { action: "approve"; review: AutoReviewResult; state: AutoState }
  | { action: "deny"; review: AutoReviewResult; state: AutoState }
  | { action: "error"; error: AutoReviewerFailure; state: AutoState };

export async function reviewAutoPrompt(
  reviewer: AutoReviewer,
  request: AutoReviewRequest,
  context: AutoReviewerContext,
  state: AutoState,
  limit: number,
  signal?: AbortSignal,
): Promise<AutoPolicyResult> {
  try {
    const review = await reviewer.review(request, context, signal);
    if (review.decision === "approve") {
      return {
        action: "approve",
        review,
        state: recordAutoApproval(state),
      };
    }
    return {
      action: "deny",
      review,
      state: recordAutoDenial(state, limit),
    };
  } catch (error) {
    if (error instanceof AutoReviewerFailure) {
      if (error.kind === "cancelled") throw error;
      return { action: "error", error, state };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      action: "error",
      error: new AutoReviewerFailure(
        "provider",
        `Auto reviewer failed: ${message}`,
        { cause: error },
      ),
      state,
    };
  }
}
