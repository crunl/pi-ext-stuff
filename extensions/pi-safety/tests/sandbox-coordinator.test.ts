import { describe, expect, it } from "vitest";
import { SandboxExecutionCoordinator } from "../src/sandbox-coordinator.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("SandboxExecutionCoordinator", () => {
  it("allows shared executions to overlap", async () => {
    const coordinator = new SandboxExecutionCoordinator();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const release = deferred();

    const first = coordinator.runShared(async () => {
      firstStarted.resolve();
      await release.promise;
    });
    const second = coordinator.runShared(async () => {
      secondStarted.resolve();
      await release.promise;
    });

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    release.resolve();
    await Promise.all([first, second]);
  });

  it("gives an exclusive mutation priority over later shared executions", async () => {
    const coordinator = new SandboxExecutionCoordinator();
    const releaseFirst = deferred();
    const writerStarted = deferred();
    const releaseWriter = deferred();
    const order: string[] = [];

    const first = coordinator.runShared(async () => {
      order.push("first");
      await releaseFirst.promise;
    });
    const writer = coordinator.runExclusive(async () => {
      order.push("writer");
      writerStarted.resolve();
      await releaseWriter.promise;
    });
    const second = coordinator.runShared(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first"]);
    releaseFirst.resolve();
    await writerStarted.promise;
    expect(order).toEqual(["first", "writer"]);
    releaseWriter.resolve();
    await Promise.all([first, writer, second]);
    expect(order).toEqual(["first", "writer", "second"]);
  });

  it("removes a cancelled waiter without blocking the queue", async () => {
    const coordinator = new SandboxExecutionCoordinator();
    const releaseWriter = deferred();
    const writerStarted = deferred();
    const controller = new AbortController();

    const writer = coordinator.runExclusive(async () => {
      writerStarted.resolve();
      await releaseWriter.promise;
    });
    await writerStarted.promise;

    const cancelled = coordinator.runShared(async () => "cancelled", controller.signal);
    const next = coordinator.runShared(async () => "next");
    controller.abort();

    await expect(cancelled).rejects.toThrow("aborted");
    releaseWriter.resolve();
    await expect(next).resolves.toBe("next");
    await writer;
  });
});
