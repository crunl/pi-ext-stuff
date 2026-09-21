import { describe, expect, it } from "vitest";
import type { AutoReviewResult } from "../src/auto-review-request.ts";
import { AutoReviewerFailure } from "../src/guardian/errors.ts";
import {
  classifyGuardianDiagnosticFailure,
  type GuardianDiagnosticEvent,
  runGuardianSrtDiagnostic,
  serializeGuardianDiagnosticEvent,
} from "../src/guardian-diagnostic.ts";
import {
  GuardianWorkerAbortError,
  type GuardianWorkerFailure,
  GuardianWorkerInfrastructureError,
  GuardianWorkerProtocolError,
  GuardianWorkerTimeoutError,
} from "../src/guardian-worker-client.ts";

const APPROVED: AutoReviewResult = {
  decision: "approve",
  risk: "low",
  userAuthorization: "high",
  rationale: "Diagnostic fixture approved.",
};

function failingReviewer(error: Error) {
  return {
    review: async (): Promise<AutoReviewResult> => {
      throw error;
    },
  };
}

describe("Guardian SRT diagnostic", () => {
  it("emits bounded correlation metadata without the working directory", async () => {
    const events: GuardianDiagnosticEvent[] = [];
    const result = await runGuardianSrtDiagnostic({
      cwd: process.cwd(),
      emit: (event) => events.push(event),
      reviewer: { review: async () => APPROVED },
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(events.map((event) => event.phase)).toEqual([
      "diagnostic.start",
      "guardian.cleanup-complete",
      "diagnostic.complete",
    ]);
    const output = events.map(serializeGuardianDiagnosticEvent).join("\n");
    expect(output).not.toContain(process.cwd());
    expect(output).toContain("guardian-diagnostic-call-1");
    expect(output).toContain("guardian-diagnostic-review-1");
    expect(
      events.every((event) => Buffer.byteLength(serializeGuardianDiagnosticEvent(event)) <= 512),
    ).toBe(true);
  });

  it.each([
    { stage: "bootstrap", code: "failed" },
    { stage: "initialization", code: "failed" },
    { stage: "initialization", code: "poisoned" },
    { stage: "initialization", code: "unsupported" },
    { stage: "execution", code: "failed" },
    { stage: "cleanup", code: "failed" },
    { stage: "cleanup", code: "timeout" },
    { stage: "transport", code: "protocol" },
  ] satisfies GuardianWorkerFailure[])(
    "reports $stage/$code without error text",
    async (failure) => {
      const events: GuardianDiagnosticEvent[] = [];
      const error = new GuardianWorkerInfrastructureError(
        "initialization cleanup timed out: token=diagnostic-secret",
        undefined,
        failure,
      );
      const result = await runGuardianSrtDiagnostic({
        cwd: process.cwd(),
        emit: (event) => events.push(event),
        reviewer: failingReviewer(
          new AutoReviewerFailure("provider", "outer wrapper", { cause: error }),
        ),
      });

      expect(result).toEqual({ exitCode: 1, failure });
      const event = events.at(-1) as GuardianDiagnosticEvent;
      expect(event).toMatchObject({
        schemaVersion: 2,
        phase: "diagnostic.failed",
        status: "fail",
        failedAt: "diagnostic.start",
        failure,
      });
      const output = serializeGuardianDiagnosticEvent(event);
      expect(output).not.toContain("diagnostic-secret");
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(512);
    },
  );

  it("classifies malformed JSON as protocol, not initialization", () => {
    expect(
      classifyGuardianDiagnosticFailure(
        new GuardianWorkerProtocolError("worker returned malformed JSON"),
      ),
    ).toEqual({ stage: "transport", code: "protocol" });
  });

  it("uses owned deadlines and preserves cancellation", () => {
    expect(classifyGuardianDiagnosticFailure(new GuardianWorkerTimeoutError(100))).toEqual({
      stage: "transport",
      code: "timeout",
    });
    expect(classifyGuardianDiagnosticFailure(new GuardianWorkerAbortError())).toEqual({
      stage: "transport",
      code: "cancelled",
    });
    expect(
      classifyGuardianDiagnosticFailure(new AutoReviewerFailure("timeout", "deadline")),
    ).toEqual({ stage: "review", code: "timeout" });
  });

  it("does not infer failure metadata from names, prose or untrusted objects", () => {
    const error = new Error("worker sandbox cleanup timed out");
    error.name = "GuardianWorkerTimeoutError";
    Object.assign(error, {
      cause: error,
      failure: { stage: "cleanup", code: "timeout" },
    });
    expect(classifyGuardianDiagnosticFailure(error)).toEqual({ stage: "review", code: "failed" });
    expect(
      classifyGuardianDiagnosticFailure(
        new AutoReviewerFailure("provider", "initialization failed", { cause: error }),
      ),
    ).toEqual({ stage: "review", code: "provider" });
  });
});
