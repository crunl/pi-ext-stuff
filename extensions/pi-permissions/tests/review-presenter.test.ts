import { describe, expect, it, vi } from "vitest";
import { ReviewPresenter } from "../src/review-presenter.ts";

function ui() {
  return {
    setStatus: vi.fn((_: string, __: string | undefined): void => undefined),
    notify: vi.fn((_: string, __: "info" | "warning" | "error"): void => undefined),
    markToolCall: vi.fn(),
  };
}

describe("ReviewPresenter", () => {
  it("tracks concurrent reviews without occupying the footer", () => {
    const presenter = new ReviewPresenter();
    const target = ui();

    presenter.accept({ reviewId: "review-a", status: "reviewing", call: { id: "call-a" } }, target);
    presenter.accept({ reviewId: "review-b", status: "reviewing", call: { id: "call-b" } }, target);
    expect(presenter.pendingCount).toBe(2);
    expect(target.setStatus).not.toHaveBeenCalled();
    expect(target.notify).not.toHaveBeenCalled();
    expect(target.markToolCall).toHaveBeenNthCalledWith(1, "call-a", {
      icon: "\u{F105E}",
      color: "warning",
    });
    expect(target.markToolCall).toHaveBeenNthCalledWith(2, "call-b", {
      icon: "\u{F105E}",
      color: "warning",
    });

    presenter.accept({ reviewId: "review-a", status: "approved", call: { id: "call-a" } }, target);
    expect(presenter.pendingCount).toBe(1);
    expect(target.notify).not.toHaveBeenCalled();
    expect(target.markToolCall).toHaveBeenCalledTimes(2);

    presenter.accept({ reviewId: "review-b", status: "denied", call: { id: "call-b" } }, target);
    expect(presenter.pendingCount).toBe(0);
    expect(target.setStatus).not.toHaveBeenCalled();
    expect(target.notify).toHaveBeenCalledWith("\u{F105E} Permission denied", "warning");
  });

  it("does not surface delayed terminal events after a reset", () => {
    const presenter = new ReviewPresenter();
    const target = ui();

    presenter.accept(
      { reviewId: "review-old", status: "reviewing", call: { id: "call-old" } },
      target,
    );
    presenter.reset();
    target.setStatus.mockClear();
    target.notify.mockClear();

    presenter.accept(
      {
        reviewId: "review-old",
        status: "failed",
        reason: "late",
        call: { id: "call-old" },
      },
      target,
    );

    expect(presenter.pendingCount).toBe(0);
    expect(target.setStatus).not.toHaveBeenCalled();
    expect(target.notify).not.toHaveBeenCalled();
  });

  it("isolates UI failures while preserving lifecycle state", () => {
    const presenter = new ReviewPresenter();
    const broken = ui();
    broken.notify.mockImplementation(() => {
      throw new Error("notification unavailable");
    });

    expect(() => {
      presenter.accept(
        { reviewId: "review-a", status: "reviewing", call: { id: "call-a" } },
        broken,
      );
      presenter.accept(
        {
          reviewId: "review-a",
          status: "failed",
          reason: "provider",
          call: { id: "call-a" },
        },
        broken,
      );
    }).not.toThrow();
    expect(presenter.pendingCount).toBe(0);

    const healthy = ui();
    presenter.accept(
      { reviewId: "review-b", status: "reviewing", call: { id: "call-b" } },
      healthy,
    );
    expect(healthy.setStatus).not.toHaveBeenCalled();
    expect(healthy.notify).not.toHaveBeenCalled();
  });
});
