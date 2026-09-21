import { describe, expect, it, vi } from "vitest";
import {
  REVIEW_STATUS_ICON,
  ReviewPresenter,
  type ReviewPresenterEvent,
} from "../src/review-presenter.ts";

function ui() {
  return {
    setStatus: vi.fn((_: string, __: string | undefined): void => undefined),
    notify: vi.fn((_: string, __: "info" | "warning" | "error"): void => undefined),
  };
}

function binding() {
  return {
    setReviewStatus: vi.fn((_: string | undefined): void => undefined),
    notify: vi.fn((_: string, __: "info" | "warning" | "error"): void => undefined),
  };
}

function event(
  reviewId: string,
  status: ReviewPresenterEvent["status"],
  tool = "bash",
  input: Record<string, unknown> = { command: "npm test" },
  callId = `call-${reviewId}`,
  displaySummary?: string,
): ReviewPresenterEvent {
  const call = { id: callId, tool, input };
  if (status === "approved" || status === "denied") {
    return {
      reviewId,
      status,
      call,
      rationale: `${status} by reviewer`,
      ...(displaySummary === undefined ? {} : { displaySummary }),
    };
  }
  if (status === "failed") {
    return {
      reviewId,
      status,
      call,
      reason: "provider unavailable",
      ...(displaySummary === undefined ? {} : { displaySummary }),
    };
  }
  return {
    reviewId,
    status,
    call,
    ...(displaySummary === undefined ? {} : { displaySummary }),
  };
}

describe("ReviewPresenter", () => {
  it("shows the exact pending action and clears an approval silently", () => {
    const presenter = new ReviewPresenter();
    const target = ui();
    const row = binding();
    presenter.bind("call-a", row);
    row.setReviewStatus.mockClear();

    presenter.accept(event("a", "reviewing"), target);
    expect(row.setReviewStatus).toHaveBeenLastCalledWith(
      `${REVIEW_STATUS_ICON} Reviewing approval request · bash`,
    );

    presenter.accept(event("a", "approved"), target);
    expect(row.setReviewStatus).toHaveBeenLastCalledWith(undefined);
    expect(row.notify).not.toHaveBeenCalled();
    expect(target.setStatus).not.toHaveBeenCalled();
  });

  it("aggregates concurrent reviews and only notifies exceptional outcomes", () => {
    const presenter = new ReviewPresenter();
    const target = ui();
    const row = binding();
    presenter.bind("call-shared", row);
    row.setReviewStatus.mockClear();

    presenter.accept(
      event("a", "reviewing", "bash", { command: "npm test" }, "call-shared", "bash: npm test"),
      target,
    );
    presenter.accept(
      event(
        "b",
        "reviewing",
        "write",
        { path: "docs/notes.md" },
        "call-shared",
        "write: docs/notes.md",
      ),
      target,
    );
    expect(presenter.pendingCount).toBe(2);
    expect(row.setReviewStatus).toHaveBeenLastCalledWith(
      `${REVIEW_STATUS_ICON} Reviewing approval request · 2 requests · bash: npm test; write: docs/notes.md`,
    );

    presenter.accept(event("a", "approved", "bash", {}, "call-shared"), target);
    expect(row.setReviewStatus).toHaveBeenLastCalledWith(
      `${REVIEW_STATUS_ICON} Reviewing approval request · write: docs/notes.md`,
    );
    expect(row.notify).not.toHaveBeenCalled();

    presenter.accept(
      event("b", "denied", "write", { path: "docs/notes.md" }, "call-shared"),
      target,
    );
    expect(presenter.pendingCount).toBe(0);
    expect(row.setReviewStatus).toHaveBeenLastCalledWith(undefined);
    expect(row.notify).toHaveBeenCalledWith("Permission denied", "warning");
  });

  it("clears pending status and ignores delayed terminal events after reset", () => {
    const presenter = new ReviewPresenter();
    const target = ui();
    const row = binding();
    presenter.bind("call-old", row);
    row.setReviewStatus.mockClear();

    presenter.accept(event("old", "reviewing"), target);
    presenter.reset();
    expect(row.setReviewStatus).toHaveBeenLastCalledWith(undefined);
    row.setReviewStatus.mockClear();
    target.notify.mockClear();

    presenter.accept(event("old", "failed"), target);

    expect(presenter.pendingCount).toBe(0);
    expect(row.setReviewStatus).not.toHaveBeenCalled();
    expect(target.notify).not.toHaveBeenCalled();
  });

  it("isolates UI failures while preserving lifecycle state", () => {
    const presenter = new ReviewPresenter();
    const broken = ui();
    broken.setStatus.mockImplementation(() => {
      throw new Error("status unavailable");
    });
    broken.notify.mockImplementation(() => {
      throw new Error("notification unavailable");
    });
    const brokenRow = binding();
    brokenRow.setReviewStatus.mockImplementation(() => {
      throw new Error("status unavailable");
    });
    presenter.bind("call-a", brokenRow);

    expect(() => {
      presenter.accept(event("a", "reviewing"), broken);
      presenter.accept(event("a", "failed"), broken);
    }).not.toThrow();
    expect(presenter.pendingCount).toBe(0);

    const healthy = ui();
    const healthyRow = binding();
    presenter.bind("call-b", healthyRow);
    healthyRow.setReviewStatus.mockClear();
    presenter.accept(event("b", "reviewing"), healthy);
    expect(healthyRow.setReviewStatus).toHaveBeenLastCalledWith(
      `${REVIEW_STATUS_ICON} Reviewing approval request · bash`,
    );
  });
});
