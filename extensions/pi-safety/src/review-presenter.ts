import { projectReviewEvent, type ReviewPresentationEvent } from "./permission-copy.ts";

export interface ReviewPresenterEvent extends Omit<ReviewPresentationEvent, "reviewId"> {
  readonly reviewId: string;
  readonly call: {
    readonly id: string;
    readonly tool: string;
    readonly input: unknown;
  };
  /** A domain-owned, already bounded label for the operation under review. */
  readonly displaySummary?: string;
}

export interface ReviewUi {
  /** Retained for host compatibility; review status no longer uses the footer. */
  setStatus(key: string, text: string | undefined): void;
  notify(message: string, severity: "info" | "warning" | "error"): void;
}

export interface ReviewStatusBinding {
  setReviewStatus(status: string | undefined): void;
  notify?(message: string, severity: "info" | "warning" | "error"): void;
}

/** Kept as a stable compatibility export for integrations that used the key. */
export const REVIEW_STATUS_KEY = "pi-safety-review";

export const REVIEW_STATUS_ICON = "\u{F105E}";
const MAX_STATUS_DETAIL_LENGTH = 96;

function compact(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_STATUS_DETAIL_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_STATUS_DETAIL_LENGTH - 1)}…`;
}

export function reviewStatusText(detail: string): string {
  return `${REVIEW_STATUS_ICON} Reviewing approval request · ${compact(detail)}`;
}

/**
 * Owns review lifecycle, while the tool adapter owns the actual row projection.
 * A review never writes to the footer: bindings receive a transient status and
 * clear it on every terminal event. Only exceptional outcomes notify.
 */
export class ReviewPresenter {
  private readonly pending = new Map<string, { callId: string; detail: string }>();
  private readonly bindings = new Map<string, Set<ReviewStatusBinding>>();

  get pendingCount(): number {
    return this.pending.size;
  }

  hasPending(reviewId: string): boolean {
    return this.pending.has(reviewId);
  }

  bind(callId: string, binding: ReviewStatusBinding): () => void {
    const entries = this.bindings.get(callId) ?? new Set<ReviewStatusBinding>();
    entries.add(binding);
    this.bindings.set(callId, entries);
    this.safeSetReviewStatus(binding, this.statusForCall(callId));
    return () => {
      const current = this.bindings.get(callId);
      if (!current) return;
      this.safeSetReviewStatus(binding, undefined);
      current.delete(binding);
      if (current.size === 0) this.bindings.delete(callId);
    };
  }

  accept(event: ReviewPresenterEvent, ui?: ReviewUi): void {
    if (event.status === "reviewing") {
      const detail = compact(event.displaySummary?.trim() || event.call.tool);
      this.pending.set(event.reviewId, { callId: event.call.id, detail });
      this.projectCall(event.call.id);
      return;
    }

    const entry = this.pending.get(event.reviewId);
    if (!entry) return;
    this.pending.delete(event.reviewId);
    this.projectCall(entry.callId);

    const presentation = projectReviewEvent(event);
    if (presentation.kind === "notify") {
      const notified = this.notifyBound(entry.callId, presentation.label, presentation.severity);
      if (!notified) this.safeNotify(ui, presentation.label, presentation.severity);
    }
  }

  reset(_ui?: ReviewUi): void {
    const callIds = new Set([...this.pending.values()].map((entry) => entry.callId));
    this.pending.clear();
    for (const callId of callIds) this.projectCall(callId);
  }

  private statusForCall(callId: string): string | undefined {
    const details = [...this.pending.values()]
      .filter((entry) => entry.callId === callId)
      .map((entry) => entry.detail);
    if (details.length === 0) return undefined;
    if (details.length === 1) return reviewStatusText(details[0] ?? "tool");
    return reviewStatusText(`${details.length} requests · ${details.slice(0, 2).join("; ")}`);
  }

  private projectCall(callId: string): void {
    const status = this.statusForCall(callId);
    for (const binding of this.bindings.get(callId) ?? []) {
      this.safeSetReviewStatus(binding, status);
    }
  }

  private notifyBound(
    callId: string,
    message: string,
    severity: "info" | "warning" | "error",
  ): boolean {
    const bindings = this.bindings.get(callId);
    let notified = false;
    for (const binding of bindings ?? []) {
      if (typeof binding.notify !== "function") continue;
      notified = true;
      try {
        binding.notify(message, severity);
      } catch {
        // TUI reporting is observational.
      }
    }
    return notified;
  }

  private safeSetReviewStatus(binding: ReviewStatusBinding, status: string | undefined): void {
    try {
      binding.setReviewStatus(status);
    } catch {
      // TUI output is observational and must not affect authorization.
    }
  }

  private safeNotify(
    ui: ReviewUi | undefined,
    message: string,
    severity: "info" | "warning" | "error",
  ): void {
    if (!ui || message.length === 0) return;
    try {
      ui.notify(message, severity);
    } catch {
      // TUI output is observational and must not affect authorization.
    }
  }
}
