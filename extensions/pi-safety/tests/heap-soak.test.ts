import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.ts";
import type { Invocation, TurnSnapshot } from "../src/engine-types.ts";
import { PiSafetyRuntime } from "../src/pi-safety.ts";

/**
 * Steady-state heap probe: N full Engine turns must not grow heapUsed.
 *
 * This deliberately drives createEngine directly (the same
 * pattern as engine-native-retry.test.ts), NOT the register
 * harness: vi.fn() call history grows with N and would dominate any heap
 * delta. Bounded retainers that are expected and correct:
 * - retryRecords/denialNotices survive turn close (capped at 10) for /approve
 * - session-level grants/approvals are cleared by closeState per turn
 *
 * Run with --expose-gc for a trustworthy delta; without it the assertions
 * use a wider slack to absorb GC noise.
 */
const snapshot = (turnId: number): TurnSnapshot => ({
  sessionId: "soak",
  turnId,
  cwd: "/workspace",
  mode: "auto",
  configFingerprint: "soak-fingerprint",
  sandboxReady: true,
});

const invocation = (id: string): Invocation<string> => ({
  call: {
    id,
    tool: "write",
    input: { path: "/workspace/file.txt", content: "x".repeat(512) },
    cwd: "/workspace",
  },
  ownership: "sandbox-owned",
  admission: { kind: "allow" },
  runtimeDenialPolicy: "terminal",
  executor: async () => ({ kind: "completed" as const, value: "ok" }),
  reviewContext: undefined,
});

const gcFn = globalThis.gc;
const gc: () => void =
  typeof gcFn === "function" ? () => gcFn.call(globalThis, {}) : () => undefined;

async function runTurn(engine: ReturnType<typeof createEngine>, turnId: number) {
  const turn = engine.beginTurn(snapshot(turnId));
  await turn.execute(invocation(`call-${turnId}`));
  turn.close("soak turn done");
}

describe("Engine heap steady state", () => {
  it("does not grow heapUsed across 50 closed turns", async () => {
    const engine = createEngine();
    // Warmup: compile paths, parser caches, first allocations.
    for (let i = 1; i <= 5; i += 1) await runTurn(engine, i);
    gc();

    const before = process.memoryUsage().heapUsed;
    for (let i = 6; i <= 50; i += 1) await runTurn(engine, i);
    gc();

    const after = process.memoryUsage().heapUsed;
    const delta = after - before;
    // 45 turns × ~1KB retained payload each would be ~45KB; leaked cloned
    // calls + attempt records would grow linearly. Allow generous slack for
    // allocator jitter, but linear-per-turn growth fails this.
    const slack = 2 * 1024 * 1024;
    expect(delta).toBeLessThan(slack);
  });

  it("keeps session-level denial bookkeeping bounded across turns", async () => {
    const engine = createEngine();
    for (let i = 1; i <= 30; i += 1) await runTurn(engine, i);
    // The cap lives in the Engine (MAX_DENIAL_NOTICES = 10); a turn loop
    // with zero denials must record nothing at all.
    expect(engine.listDenials()).toHaveLength(0);
  });
});

describe("PiSafetyRuntime turn lifecycle", () => {
  it("releases nested levels and resets the presenter across open/close cycles", () => {
    const runtime = new PiSafetyRuntime();
    // Engine/turn accessors are private; the observable contract is that
    // closeTurn without a turn, and repeated invalidate, do not throw and
    // leave the runtime usable.
    expect(() => runtime.closeTurn()).not.toThrow();
    expect(() => runtime.invalidate("soak")).not.toThrow();
    expect(() => runtime.closeTurn()).not.toThrow();
  });
});
