// Fake only the external ChildProcess boundary. No processes, signals or sockets.
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { terminateOnCancellation } from "./cooperative-cancellation.mjs";

function fixture() {
  const cancellation = Promise.withResolvers();
  const closure = Promise.withResolvers();
  const signals = [];
  const child = {
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push(signal);
      child.signalCode = signal;
      closure.resolve({ code: null, signal });
      return true;
    },
  };
  return { child, cancellation, closure, signals };
}

test("expiry settles promptly; later cancellation cannot signal a reaped child", async () => {
  const f = fixture();
  const outcome = terminateOnCancellation(f.child, f.cancellation.promise, f.closure.promise).then(
    (status) => ({ status }),
    (error) => ({ error }),
  );
  f.child.exitCode = 124;
  f.closure.resolve({ code: 124, signal: null });
  const first = await Promise.race([outcome, setImmediate("still-pending")]);
  f.cancellation.resolve();
  const final = await outcome;
  assert.notEqual(first, "still-pending", "closure must settle without a cancellation message");
  assert.equal(final.error?.code, "COOPERATIVE_CHILD_EXITED");
  assert.deepEqual(f.signals, []);
});

test("recorded exit wins even when cancellation is already queued", async () => {
  const f = fixture();
  f.child.signalCode = "SIGKILL";
  f.cancellation.resolve();
  f.closure.resolve({ code: null, signal: "SIGKILL" });
  await assert.rejects(
    terminateOnCancellation(f.child, f.cancellation.promise, f.closure.promise),
    { code: "COOPERATIVE_CHILD_EXITED" },
  );
  assert.deepEqual(f.signals, []);
});

test("live cancellation signals the owned child handle once and awaits closure", async () => {
  const f = fixture();
  const result = terminateOnCancellation(f.child, f.cancellation.promise, f.closure.promise);
  f.cancellation.resolve();
  assert.deepEqual(await result, { code: null, signal: "SIGTERM" });
  assert.deepEqual(f.signals, ["SIGTERM"]);
});

test("failed signal delivery is not successful cancellation", async () => {
  const f = fixture();
  f.child.kill = () => false;
  f.cancellation.resolve();
  // Resolve only for the old implementation's completion; no owned exit is recorded.
  f.closure.resolve({ code: 124, signal: null });
  await assert.rejects(
    terminateOnCancellation(f.child, f.cancellation.promise, f.closure.promise),
    { code: "COOPERATIVE_SIGNAL_FAILED" },
  );
});
