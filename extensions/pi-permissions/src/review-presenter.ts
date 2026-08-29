import { markToolCall } from "../../pi-core/standalone.ts";
import { projectReviewEvent, type ReviewPresentationEvent } from "./permission-copy.ts";

export interface ReviewPresenterEvent extends Omit<ReviewPresentationEvent, "reviewId"> {
  readonly reviewId: string;
  readonly call: {
    readonly id: string;
  };
}

export interface ReviewUi {
  notify(message: string, severity: "info" | "warning" | "error"): void;
  markToolCall?: (
    toolCallId: string,
    mark: { readonly icon: string; readonly color: "warning" },
  ) => void;
}

export interface ReviewPresenterOptions {
  icon?: string;
}

const DEFAULT_REVIEW_ICON = "\u{F105E}";

/**
 * Tracks review lifecycle identity and projects only exceptional terminal
 * outcomes into TUI notifications. In-progress and approved reviews remain
 * silent, so routine approval work never occupies the footer.
 */
export class ReviewPresenter {
  private readonly pending = new Map<string, true>();
  private readonly icon: string;

  constructor(options: ReviewPresenterOptions = {}) {
    this.icon = options.icon ?? DEFAULT_REVIEW_ICON;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  hasPending(reviewId: string): boolean {
    return this.pending.has(reviewId);
  }

  /**
   * Accept one lifecycle event.  Rendering is best effort: a broken UI must
   * never change the authorization result or prevent cleanup of state.
   */
  accept(event: ReviewPresenterEvent, ui?: ReviewUi): void {
    if (event.status === "reviewing") {
      this.pending.set(event.reviewId, true);
      if (ui) {
        markToolCall(ui, event.call.id, { icon: this.icon, color: "warning" });
      }
      return;
    }

    // Ignore terminal events for a review that was reset or already finished.
    // This is what keeps delayed events from an old turn from resurfacing.
    if (!this.pending.delete(event.reviewId)) return;

    const presentation = projectReviewEvent(event);
    if (presentation.kind === "notify") {
      this.safeNotify(ui, `${this.icon} ${presentation.label}`, presentation.severity);
    }
  }

  reset(): void {
    this.pending.clear();
  }

  private safeNotify(
    ui: ReviewUi | undefined,
    message: string,
    severity: "info" | "warning" | "error",
  ): void {
    if (!ui) return;
    try {
      ui.notify(message, severity);
    } catch {
      // TUI output is observational and must not affect authorization.
    }
  }
}
