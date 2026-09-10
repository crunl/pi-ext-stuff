// Testable child-process boundary; no process is created here.
export async function terminateOnCancellation(child, cancelled, closed) {
  const first = await Promise.race([
    cancelled.then(() => "cancelled"),
    closed.then(() => "closed"),
  ]);
  if (first === "closed" || child.exitCode !== null || child.signalCode !== null) {
    throw Object.assign(new Error("Child exited before cooperative cancellation"), {
      code: "COOPERATIVE_CHILD_EXITED",
    });
  }
  // Use the tracked ChildProcess handle, not a numeric PID that may be stale.
  if (!child.kill("SIGTERM")) {
    throw Object.assign(new Error("Cooperative cancellation signal was not delivered"), {
      code: "COOPERATIVE_SIGNAL_FAILED",
    });
  }
  return closed;
}
