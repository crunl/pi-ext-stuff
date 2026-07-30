import { afterEach, describe, expect, it } from "vitest";
import {
  CORE_EXECUTION_ABORT_GATE_SYMBOL,
  hasCoreExecutionAbortGate,
} from "../src/core-capability.ts";

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[CORE_EXECUTION_ABORT_GATE_SYMBOL];
});

describe("core execution abort gate capability", () => {
  it("is absent unless the patched core publishes the exact capability marker", () => {
    expect(hasCoreExecutionAbortGate()).toBe(false);
    (globalThis as Record<symbol, unknown>)[CORE_EXECUTION_ABORT_GATE_SYMBOL] = "wrong";
    expect(hasCoreExecutionAbortGate()).toBe(false);
  });

  it("is present when the patched core publishes version 1", () => {
    (globalThis as Record<symbol, unknown>)[CORE_EXECUTION_ABORT_GATE_SYMBOL] = 1;
    expect(hasCoreExecutionAbortGate()).toBe(true);
  });
});
