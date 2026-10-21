// Failure vocabulary shared by every guardian subsystem. Lives apart from
// auto-reviewer.ts so lower layers (model selection, session management) can
// signal failures without importing the reviewer implementation — this breaks
// the auto-reviewer <-> guardian-model dependency cycle reported by madge.
import type { AutoReviewResult } from "../auto-review-request.ts";

export type GuardianReviewIdentity = NonNullable<AutoReviewResult["guardian"]>;

const AUTO_REVIEWER_FAILURE_KINDS = [
  "unavailable",
  "timeout",
  "cancelled",
  "provider",
  "parse",
] as const;
export type AutoReviewerFailureKind = (typeof AUTO_REVIEWER_FAILURE_KINDS)[number];

export class AutoReviewerFailure extends Error {
  constructor(
    readonly kind: AutoReviewerFailureKind,
    message: string,
    options?: ErrorOptions,
    readonly guardian?: GuardianReviewIdentity,
  ) {
    super(message, options);
    this.name = "AutoReviewerFailure";
  }
}
