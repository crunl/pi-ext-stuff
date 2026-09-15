import { describe, expect, it, vi } from "vitest";
import { REVIEW_STATUS_ICON } from "../src/review-presenter.ts";
import {
  createReviewResultRenderer,
  createReviewStatusBridge,
  decorateReviewDetails,
  plainReviewResultRenderer,
  reviewStatusFromDetails,
} from "../src/review-renderer.ts";

const partial = (details?: unknown) => ({
  content: [{ type: "text", text: "tool output" }],
  ...(details === undefined ? {} : { details }),
});

describe("review row renderer", () => {
  it("does not synthesize partial updates when no review is active", () => {
    const onUpdate = vi.fn();
    const bridge = createReviewStatusBridge(onUpdate);

    bridge.binding.setReviewStatus(undefined);
    expect(onUpdate).not.toHaveBeenCalled();

    bridge.onUpdate?.(partial());
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("keeps status transient in partial details and clears it", () => {
    const onUpdate = vi.fn();
    const bridge = createReviewStatusBridge(onUpdate);
    bridge.onUpdate?.(partial({ progress: 1 }));
    onUpdate.mockClear();

    bridge.binding.setReviewStatus("󱁞 Reviewing approval request · api.example.com:443");
    expect(onUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: [{ type: "text", text: "tool output" }],
        details: expect.anything(),
      }),
    );
    const tagged = onUpdate.mock.lastCall?.[0] as { details: unknown };
    expect(reviewStatusFromDetails(tagged.details)).toContain("api.example.com:443");
    bridge.binding.setReviewStatus(undefined);
    const cleared = onUpdate.mock.lastCall?.[0] as { details: unknown };
    expect(reviewStatusFromDetails(cleared.details)).toBeUndefined();
  });

  it("bounds the overlay warning row to the requested width", () => {
    const base = vi.fn(() => ({
      render: () => ["base"],
      invalidate: vi.fn(),
    }));
    const renderer = createReviewResultRenderer(base, "overlay");
    const theme = { fg: vi.fn((_color: string, text: string) => `<warning>${text}</warning>`) };
    const result = renderer(
      partial(
        decorateReviewDetails(undefined, "󱁞 Reviewing approval request · api.example.com:443"),
      ),
      undefined,
      theme,
      {},
    ) as { render(width: number): string[] };

    const lines = result.render(12);
    expect(lines).toHaveLength(2);
    const visible = theme.fg.mock.lastCall?.[1] ?? "";
    expect([...visible].length).toBeLessThanOrEqual(12);
    expect(lines[1]).toBe(`<warning>${visible}</warning>`);
  });

  it("stamps a permanent leadingIconOverride without overlaying a status row", () => {
    const base = vi.fn(() => ({
      render: () => ["base"],
      invalidate: vi.fn(),
    }));
    const renderer = createReviewResultRenderer(base, "header-icon");
    const state: { leadingIconOverride?: string } = {};
    const result = renderer(
      partial(decorateReviewDetails(undefined, "Reviewing approval request · bash")),
      undefined,
      {},
      { state },
    ) as { render(width: number): string[] };

    expect(state.leadingIconOverride).toBe(REVIEW_STATUS_ICON);
    expect(base).toHaveBeenCalledOnce();
    expect(result.render(80)).toEqual(["base"]);
  });

  it("does not clear leadingIconOverride when status disappears", () => {
    const base = vi.fn(() => ({
      render: () => ["base"],
      invalidate: vi.fn(),
    }));
    const renderer = createReviewResultRenderer(base, "header-icon");
    const state: { leadingIconOverride?: string } = {};

    renderer(partial(decorateReviewDetails(undefined, "Reviewing")), undefined, {}, { state });
    expect(state.leadingIconOverride).toBe(REVIEW_STATUS_ICON);

    renderer(partial(), undefined, {}, { state });
    expect(state.leadingIconOverride).toBe(REVIEW_STATUS_ICON);
  });

  it("skips stamping when context.state is missing", () => {
    const base = vi.fn(() => ({
      render: () => ["base"],
      invalidate: vi.fn(),
    }));
    const renderer = createReviewResultRenderer(base, "header-icon");
    expect(() =>
      renderer(partial(decorateReviewDetails(undefined, "Reviewing")), undefined, {}, {}),
    ).not.toThrow();
    expect(base).toHaveBeenCalledOnce();
  });

  it("never stamps when review status was never present", () => {
    const base = vi.fn(() => ({
      render: () => ["base"],
      invalidate: vi.fn(),
    }));
    const renderer = createReviewResultRenderer(base, "header-icon");
    const state: { leadingIconOverride?: string } = {};
    renderer(partial(), undefined, {}, { state });
    expect(state.leadingIconOverride).toBeUndefined();
  });

  it("keeps fallback permission results within a narrow viewport", () => {
    const result = plainReviewResultRenderer(partial({}), undefined, {}, {}) as {
      render(width: number): string[];
    };
    expect(result.render(4).every((line) => [...line].length <= 4)).toBe(true);
  });
});
