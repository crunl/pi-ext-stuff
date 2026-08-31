import { describe, expect, it } from "vitest";
import {
  permissionModeLabel,
  projectReviewEvent,
  renderPermissionErrorForAgent,
  renderPermissionNotice,
  renderPermissionSummary,
} from "../src/permission-copy.ts";

describe("permission copy", () => {
  it("uses the Codex permission labels", () => {
    expect(permissionModeLabel("auto")).toBe("Approve for me");
    expect(permissionModeLabel("yolo")).toBe("Full access");
  });

  it("renders an explicit denial with the Codex no-circumvention instruction", () => {
    const message = renderPermissionErrorForAgent({
      code: "review-denied",
      reason: "The requested destination is not authorized.",
    });

    expect(message).toContain("This action was rejected due to unacceptable risk.");
    expect(message).toContain("Reason: The requested destination is not authorized.");
    expect(message).toContain("must not attempt to achieve the same outcome through a workaround");
    expect(message).toContain("materially safer alternative");
    expect(message).toContain("stop and ask the user");
    expect(message).not.toContain("review-denied");
    expect(message).not.toContain("Guardian");
  });

  it("renders timeout as an inconclusive review rather than a denial", () => {
    const message = renderPermissionErrorForAgent({
      code: "review-timeout",
      reason: "internal timeout detail",
    });

    expect(message).toContain("did not finish before its deadline");
    expect(message).toContain("Do not assume the action is unsafe");
    expect(message).toContain("retry once");
    expect(message).not.toContain("rejected due to unacceptable risk");
    expect(message).not.toContain("review-timeout");
  });

  it("distinguishes review failure from an explicit denial", () => {
    const message = renderPermissionErrorForAgent({
      code: "review-unavailable",
      reason: "The configured reviewer is unavailable.",
    });

    expect(message).toContain("could not produce a decision");
    expect(message).toContain("The action was not run");
    expect(message).not.toContain("unacceptable risk");
  });

  it("does not suggest a blind retry after an inline review timeout", () => {
    const message = renderPermissionErrorForAgent({
      code: "review-timeout",
      reason: "Automatic approval review timed out",
      effectsMayHaveOccurred: true,
    });

    expect(message).toContain("after execution had started");
    expect(message).toMatch(/earlier effects may have occurred/i);
    expect(message).toContain("Do not replay it blindly");
    expect(message).not.toContain("retry once");
    expect(message).not.toContain("The action was not run");
  });

  it("distinguishes a runtime denial from a preflight denial", () => {
    const message = renderPermissionErrorForAgent({
      code: "runtime-denied",
      reason: "The requested write was denied",
      effectsMayHaveOccurred: true,
    });

    expect(message).toContain("during execution");
    expect(message).toMatch(/earlier effects may have occurred/i);
    expect(message).toContain("Do not replay it blindly");
    expect(message).not.toContain("The action was not run");
  });

  it("reports that a reviewed runtime retry was already attempted", () => {
    const message = renderPermissionErrorForAgent({
      code: "runtime-denied",
      reason: "The second write was denied",
      effectsMayHaveOccurred: true,
      retryAttempted: true,
    });

    expect(message).toContain("One reviewed retry already ran and was also denied");
    expect(message).toContain("no further automatic replay is available");
    expect(message).not.toContain("action was not replayed");
  });

  it("does not present a post-start execution failure as safe to blindly retry", () => {
    const message = renderPermissionErrorForAgent({
      code: "execution-failed",
      reason: "write interrupted",
      effectsMayHaveOccurred: true,
    });

    expect(message).toContain("Earlier effects may have occurred");
    expect(message).toContain("inspect the result before considering any retry");
  });

  it("turns sandbox deadline codes into user-facing timeout reasons", () => {
    expect(renderPermissionErrorForAgent({ code: "execution-failed", reason: "timeout:120" })).toBe(
      "The permitted action failed during execution.\nReason: Timed out after 120 seconds.",
    );
    expect(
      renderPermissionNotice({
        kind: "sandbox-activation-failed",
        reason: "timeout:5",
        recovery: "unavailable",
      }),
    ).toContain("Reason: Timed out after 5 seconds.");
  });

  it("projects review lifecycle into concise UI instructions", () => {
    expect(projectReviewEvent({ status: "reviewing" })).toEqual({ kind: "silent" });
    expect(projectReviewEvent({ status: "approved", rationale: "Approved." })).toEqual({
      kind: "silent",
    });
    expect(projectReviewEvent({ status: "aborted" })).toEqual({ kind: "silent" });
    expect(projectReviewEvent({ status: "denied", rationale: "The action is too broad." })).toEqual(
      {
        kind: "notify",
        label: "Permission denied",
        severity: "warning",
      },
    );
    expect(projectReviewEvent({ status: "timed-out" })).toEqual({
      kind: "notify",
      label: "Review timed out",
      severity: "warning",
    });
    expect(projectReviewEvent({ status: "failed", reason: "Provider unavailable." })).toEqual({
      kind: "notify",
      label: "Review failed",
      severity: "warning",
    });
    expect(
      renderPermissionNotice({
        kind: "review-circuit-interrupted",
        consecutiveDenials: 3,
        recentDenials: 4,
        windowSize: 50,
      }),
    ).toBe(
      "Automatic approval review rejected too many approval requests for this turn (3 consecutive, 4 in the last 50 reviews); interrupting the turn.",
    );
  });

  it("describes configured and active reviewers without claiming preference is resolved", () => {
    expect(
      renderPermissionSummary({
        mode: "auto",
        sandbox: "workspace-write sandbox",
        reviewer: {
          kind: "preference",
          provider: "google",
          model: "gemini-3.5-flash-lite",
        },
        autoReviewAvailable: true,
        ruleCount: 2,
        writeRoots: ["/workspace"],
      }),
    ).toContain("reviewer preference: google/gemini-3.5-flash-lite");

    expect(
      renderPermissionSummary({
        mode: "yolo",
        sandbox: "sandbox off",
        autoReviewAvailable: false,
        ruleCount: 0,
        writeRoots: [],
      }),
    ).toBe("Full access · sandbox off · approvals off");
  });
});
