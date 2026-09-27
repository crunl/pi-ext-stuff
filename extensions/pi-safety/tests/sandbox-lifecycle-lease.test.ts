import { describe, expect, it } from "vitest";
import { SandboxLifecycleLease } from "../src/sandbox-lifecycle-lease.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("SandboxLifecycleLease", () => {
  it("allows shared executions to overlap", async () => {
    const lease = new SandboxLifecycleLease();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const release = deferred();

    const first = lease.runShared(async () => {
      firstStarted.resolve();
      await release.promise;
    });
    const second = lease.runShared(async () => {
      secondStarted.resolve();
      await release.promise;
    });

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    release.resolve();
    await Promise.all([first, second]);
  });

  it("gives an exclusive mutation priority over later shared executions", async () => {
    const lease = new SandboxLifecycleLease();
    const releaseFirst = deferred();
    const writerStarted = deferred();
    const releaseWriter = deferred();
    const order: string[] = [];

    const first = lease.runShared(async () => {
      order.push("first");
      await releaseFirst.promise;
    });
    const writer = lease.runExclusive(async () => {
      order.push("writer");
      writerStarted.resolve();
      await releaseWriter.promise;
    });
    const second = lease.runShared(async () => {
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
    const lease = new SandboxLifecycleLease();
    const releaseWriter = deferred();
    const writerStarted = deferred();
    const controller = new AbortController();

    const writer = lease.runExclusive(async () => {
      writerStarted.resolve();
      await releaseWriter.promise;
    });
    await writerStarted.promise;

    const cancelled = lease.runShared(async () => "cancelled", controller.signal);
    const next = lease.runShared(async () => "next");
    controller.abort();

    await expect(cancelled).rejects.toThrow("aborted");
    releaseWriter.resolve();
    await expect(next).resolves.toBe("next");
    await writer;
  });
});
