import { describe, expect, it, vi } from "vitest";
import { reviewAutoPrompt } from "../src/auto-policy.ts";
import { AutoReviewerFailure } from "../src/auto-reviewer.ts";

const request = { toolCallId: "x" } as any;
const context = {} as any;

describe("Auto review policy", () => {
  it("approves and resets consecutive denials", async () => {
    const reviewer = {
      review: vi.fn(async () => ({
        decision: "approve" as const,
        risk: "low" as const,
        rationale: "Authorized.",
      })),
    };
    await expect(
      reviewAutoPrompt(
        reviewer,
        request,
        context,
        { consecutiveDenials: 2, paused: false },
        3,
      ),
    ).resolves.toEqual({
      action: "approve",
      review: {
        decision: "approve",
        risk: "low",
        rationale: "Authorized.",
      },
      state: { consecutiveDenials: 0, paused: false },
    });
  });

  it("denies and pauses on the configured consecutive threshold", async () => {
    const reviewer = {
      review: vi.fn(async () => ({
        decision: "deny" as const,
        risk: "high" as const,
        rationale: "External publication was not requested.",
      })),
    };
    await expect(
      reviewAutoPrompt(
        reviewer,
        request,
        context,
        { consecutiveDenials: 2, paused: false },
        3,
      ),
    ).resolves.toMatchObject({
      action: "deny",
      state: { consecutiveDenials: 3, paused: true },
    });
  });

  it("returns fallback for reviewer failures without mutating denial state", async () => {
    const reviewer = {
      review: vi.fn(async () => {
        throw new AutoReviewerFailure("timeout", "review timed out");
      }),
    };
    const state = { consecutiveDenials: 1, paused: false };
    await expect(reviewAutoPrompt(reviewer, request, context, state, 3))
      .resolves.toMatchObject({ action: "fallback", state });
  });

  it("propagates caller cancellation instead of requesting fallback", async () => {
    const reviewer = {
      review: vi.fn(async () => {
        throw new AutoReviewerFailure("cancelled", "turn aborted");
      }),
    };
    await expect(
      reviewAutoPrompt(
        reviewer,
        request,
        context,
        { consecutiveDenials: 0, paused: false },
        3,
      ),
    ).rejects.toMatchObject({ kind: "cancelled" });
  });
});
