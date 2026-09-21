import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createApproveForMeEngine,
  type ExecutionAttempt,
  type GuardianDecision,
  type GuardianReviewInput,
  type Invocation,
  type NativeActionFailure,
  type RuntimeOutcome,
  type TurnSnapshot,
} from "../src/approve-for-me-engine.ts";
import { PiSafetyRuntime } from "../src/pi-safety.ts";

const snapshot = (): TurnSnapshot => ({
  sessionId: "native",
  turnId: 1,
  cwd: "/workspace",
  mode: "auto",
  configFingerprint: "native",
  sandboxReady: true,
  baseSandboxPolicy: {
    filesystem: {
      allowWrite: ["/workspace"],
      denyRead: ["/read-secret"],
      denyWrite: ["/write-secret"],
    },
    network: { allowedDomains: ["example.com"], deniedDomains: ["denied.example"] },
  },
});
const failed = (
  path = "/outside/ file ",
  operation: "mkdir" | "access" | "read" | "write" = "mkdir",
): NativeActionFailure => ({
  kind: "native-action-failed",
  error: new Error("host-facing original"),
  mkdirScopeSupported: true,
  failure: {
    operation,
    path: operation === "mkdir" ? dirname(path) : path,
    cwd: "/workspace",
    contentWriteStarted: false,
    exitCode: 1,
    error: "EACCES: helper original; unrelated /do/not/grant",
  },
});
function invocation(
  executor: Invocation<string>["executor"],
  path = "/outside/ file ",
  tool = "write",
): Invocation<string> {
  return {
    call: {
      id: "native",
      tool,
      input: {
        path,
        content: "original complete content",
        edits: [{ oldText: "before", newText: "after" }],
      },
      cwd: "/workspace",
    },
    ownership: "sandbox-owned",
    admission: { kind: "allow" },
    runtimeDenialPolicy: "review-and-retry",
    executor,
    reviewContext: undefined,
  };
}
const approved = (): GuardianDecision => ({ kind: "approve", rationale: "approved" });

describe("Engine native preparation recovery", () => {
  it.each(["mkdir", "access", "read"] as const)(
    "reviews the complete action for %s, grants only one attempt, and preserves policy",
    async (operation) => {
      const review = vi.fn(async (input: GuardianReviewInput) => {
        expect(input.call.input).toMatchObject({
          content: "original complete content",
          path: "/outside/ file ",
        });
        expect(input.reason).toContain("partial directory effects");
        expect(input.reason).toContain("not a proven sandbox denial");
        expect(input.requested).toEqual([
          {
            kind: "filesystem",
            operation: "write",
            path: operation === "mkdir" ? "/outside" : "/outside/ file ",
          },
        ]);
        return approved();
      });
      const turn = createApproveForMeEngine({ guardian: { review } }).beginTurn(snapshot());
      const leases: ExecutionAttempt["lease"][] = [];
      const execute = vi.fn(async (attempt: ExecutionAttempt): Promise<RuntimeOutcome<string>> => {
        leases.push(attempt.lease);
        return leases.length === 1
          ? failed(undefined, operation)
          : { kind: "completed", value: "ok" };
      });
      expect(
        await turn.execute(
          invocation(execute, undefined, operation === "mkdir" ? "write" : "edit"),
        ),
      ).toEqual({ kind: "completed", value: "ok" });
      expect(execute).toHaveBeenCalledTimes(2);
      expect(review).toHaveBeenCalledOnce();
      expect(leases[1].policy).toEqual({
        ...leases[0].policy,
        filesystem: {
          ...leases[0].policy?.filesystem,
          allowWrite: ["/workspace", operation === "mkdir" ? "/outside" : "/outside/ file "],
        },
      });
      await turn.execute({
        ...invocation(async (attempt) => {
          expect(attempt.lease.policy?.filesystem.allowWrite).toEqual(["/workspace"]);
          return { kind: "completed", value: "next" };
        }),
        call: {
          id: "next",
          tool: "write",
          input: { path: "/workspace/next", content: "next" },
          cwd: "/workspace",
        },
      });
    },
  );

  it.each([
    ["ENOENT", "EACCES.txt"],
    ["ENOENT", "permission denied.txt"],
    ["ENOENT", "EPERM.txt"],
    ["EEXIST", "EROFS.txt"],
    ["EEXIST", "operation not permitted.txt"],
    ["EEXIST", "read-only file system.txt"],
  ])(
    "does not treat permission keywords in a %s filename as an access errno: %s",
    async (code, filename) => {
      const mkdir = code === "EEXIST";
      const path = `/outside/${filename}${mkdir ? "/file" : ""}`;
      const outcome = failed(path, mkdir ? "mkdir" : "access");
      outcome.failure.error = `${code}: ${mkdir ? "file already exists" : "no such file or directory"}, ${outcome.failure.operation} '${outcome.failure.path}'`;
      const review = vi.fn(async () => approved());
      const turn = createApproveForMeEngine({ guardian: { review } }).beginTurn(snapshot());
      const execute = vi.fn(async () => outcome);
      expect(await turn.execute(invocation(execute, path, mkdir ? "write" : "edit"))).toMatchObject(
        {
          kind: "blocked",
          error: { reason: expect.stringContaining(outcome.failure.error) },
        },
      );
      expect(review).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["write begun", { failure: { ...failed().failure, contentWriteStarted: true } }],
    ["write stage", { failure: { ...failed().failure, operation: "write" } }],
    ["unrelated path", { failure: { ...failed().failure, path: "/unrelated" } }],
    ["wrong cwd", { failure: { ...failed().failure, cwd: "/other" } }],
    ["null exit", { failure: { ...failed().failure, exitCode: null } }],
    ["successful exit", { failure: { ...failed().failure, exitCode: 0 } }],
    ["non-access failure", { failure: { ...failed().failure, error: "ENOENT" } }],
    ["malformed", { failure: null }],
    ["missing Linux root", { mkdirScopeSupported: false }],
  ])("does not review or replay %s", async (_name, overrides) => {
    const review = vi.fn(async () => approved());
    const turn = createApproveForMeEngine({ guardian: { review } }).beginTurn(snapshot());
    const execute = vi.fn(async () => ({ ...failed(), ...overrides }) as NativeActionFailure);
    const result = await turn.execute(invocation(execute));
    expect(result).toMatchObject({
      kind: "blocked",
      error: {
        effectsMayHaveOccurred: true,
        reason: expect.stringContaining("host-facing original"),
      },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(review).not.toHaveBeenCalled();
  });

  it.each([
    "/file",
    `${homedir()}/file`,
    `${dirname(homedir())}/file`,
    `${homedir()}/Library/file`,
    "/outside/[literal]/file",
    "/workspace/file",
    "/write-secret/file",
  ])("rejects broad, denied, covered or glob root for %s", async (path) => {
    const review = vi.fn(async () => approved());
    const turn = createApproveForMeEngine({ guardian: { review } }).beginTurn(snapshot());
    const execute = vi.fn(async () => failed(path));
    expect(await turn.execute(invocation(execute, path))).toMatchObject({ kind: "blocked" });
    expect(execute).toHaveBeenCalledOnce();
    expect(review).not.toHaveBeenCalled();
  });

  it.each(["access", "read"] as const)("preserves denyRead for Edit %s", async (operation) => {
    const review = vi.fn(async () => approved());
    const turn = createApproveForMeEngine({ guardian: { review } }).beginTurn(snapshot());
    const execute = vi.fn(async () => failed("/read-secret/file", operation));
    expect(await turn.execute(invocation(execute, "/read-secret/file", "edit"))).toMatchObject({
      kind: "blocked",
      error: { code: "policy-denied" },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(review).not.toHaveBeenCalled();
  });

  it.each(["bash", "host", "undeclared"])(
    "rejects unsupported native ownership/declaration %s",
    async (kind) => {
      const review = vi.fn(async () => approved());
      const turn = createApproveForMeEngine({ guardian: { review } }).beginTurn(snapshot());
      const execute = vi.fn(async () => failed());
      const action = invocation(execute);
      if (kind === "bash") action.call.tool = "bash";
      if (kind === "host") action.ownership = "host-admission";
      if (kind === "undeclared") action.runtimeDenialPolicy = undefined;
      expect(await turn.execute(action)).toMatchObject({ kind: "blocked" });
      expect(execute).toHaveBeenCalledTimes(kind === "host" ? 0 : 1);
      expect(review).not.toHaveBeenCalled();
    },
  );

  it.each(["deny", "failure", "cancel", "stale", "ceiling-change"])(
    "stays closed across review %s and preserves original evidence",
    async (kind) => {
      const controller = new AbortController();
      let ceiling = true;
      const review = vi.fn(async (): Promise<GuardianDecision> => {
        if (kind === "cancel") controller.abort();
        if (kind === "stale") turn.close();
        if (kind === "ceiling-change") ceiling = false;
        if (kind === "failure") throw new Error("review infrastructure failed");
        return kind === "deny" ? { kind: "deny", rationale: "refused" } : approved();
      });
      const engine = createApproveForMeEngine({
        guardian: { review },
        policy: {
          check: () =>
            ceiling ? { kind: "allow" } : { kind: "deny", reason: "live ceiling changed" },
        },
      });
      const turn = engine.beginTurn(snapshot());
      const execute = vi.fn(async () => failed());
      const result = await turn.execute({ ...invocation(execute), signal: controller.signal });
      expect(result).toMatchObject({
        kind: "blocked",
        error: {
          effectsMayHaveOccurred: true,
          reason: expect.stringContaining("host-facing original"),
        },
      });
      expect(result).not.toHaveProperty("retryHandle");
      expect(execute).toHaveBeenCalledOnce();
      expect(review).toHaveBeenCalledOnce();
    },
  );

  it.each(["cancel", "stale"])(
    "preserves failure evidence when %s happens before outcome handling",
    async (kind) => {
      const controller = new AbortController();
      const review = vi.fn(async () => approved());
      const turn = createApproveForMeEngine({ guardian: { review } }).beginTurn(snapshot());
      const execute = vi.fn(async () => {
        if (kind === "cancel") controller.abort();
        else turn.close();
        return failed();
      });
      expect(
        await turn.execute({ ...invocation(execute), signal: controller.signal }),
      ).toMatchObject({
        kind: "blocked",
        error: {
          reason: expect.stringMatching(/host-facing original[\s\S]*helper original/),
          effectsMayHaveOccurred: true,
        },
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(review).not.toHaveBeenCalled();
    },
  );

  it("counts refused native reviews toward the Auto circuit without capability-only retry handles", async () => {
    const review = vi.fn(
      async (): Promise<GuardianDecision> => ({
        kind: "deny",
        rationale: "refused preparation re-entry",
      }),
    );
    const stateChanged = vi.fn();
    const turn = createApproveForMeEngine({
      guardian: { review },
      maxConsecutiveDenials: 2,
      onAutoStateChange: stateChanged,
    }).beginTurn(snapshot());
    const execute = vi.fn(async () => failed());
    for (const id of ["denied-one", "denied-two"]) {
      const action = invocation(execute);
      action.call.id = id;
      const result = await turn.execute(action);
      expect(result).toMatchObject({
        kind: "blocked",
        error: { code: "review-denied", reason: expect.stringContaining("helper original") },
      });
      expect(result).not.toHaveProperty("retryHandle");
    }
    expect(stateChanged).toHaveBeenLastCalledWith({
      paused: true,
      consecutiveDenials: 2,
      recentDenials: 2,
    });
    const action = invocation(execute);
    action.call.id = "paused-third";
    expect(await turn.execute(action)).toMatchObject({
      kind: "blocked",
      error: { code: "circuit-open" },
    });
    expect(review).toHaveBeenCalledTimes(2);
    // LOW first attempts remain permitted; the circuit prevents review and replay.
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("checks the proposed parent against the policy before review", async () => {
    const review = vi.fn(async () => approved());
    const check = vi.fn(({ phase, requested }) =>
      phase === "runtime" && requested.some((item: { path?: string }) => item.path === "/outside")
        ? { kind: "deny" as const, reason: "file-only ceiling" }
        : { kind: "allow" as const },
    );
    const turn = createApproveForMeEngine({ guardian: { review }, policy: { check } }).beginTurn(
      snapshot(),
    );
    const execute = vi.fn(async () => failed());
    expect(await turn.execute(invocation(execute))).toMatchObject({
      kind: "blocked",
      error: { code: "policy-denied", reason: expect.stringContaining("file-only ceiling") },
    });
    expect(review).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("terminates the second failure and preserves both errors", async () => {
    const review = vi.fn(async () => approved());
    const turn = createApproveForMeEngine({ guardian: { review } }).beginTurn(snapshot());
    const execute = vi.fn(
      async (): Promise<RuntimeOutcome<string>> =>
        execute.mock.calls.length === 1
          ? failed()
          : { kind: "failed", error: new Error("second write may have truncated") },
    );
    expect(await turn.execute(invocation(execute))).toMatchObject({
      kind: "blocked",
      error: {
        retryAttempted: true,
        reason: expect.stringMatching(
          /second write may have truncated[\s\S]*host-facing original[\s\S]*helper original/,
        ),
      },
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(review).toHaveBeenCalledOnce();
  });

  it("keeps concurrent invocation evidence and roots separate", async () => {
    const review = vi.fn(async () => approved());
    const turn = createApproveForMeEngine({ guardian: { review } }).beginTurn(snapshot());
    const actions = ["/one/file", "/two/file"].map((path) => {
      let ordinal = 0;
      const action = invocation(async (attempt) => {
        ordinal++;
        if (ordinal === 1) return failed(path);
        expect(attempt.lease.policy?.filesystem.allowWrite).toEqual(["/workspace", dirname(path)]);
        return { kind: "completed", value: path };
      }, path);
      action.call.id = path;
      return action;
    });
    expect(await Promise.all(actions.map((action) => turn.execute(action)))).toEqual(
      actions.map((action) => ({
        kind: "completed",
        value: (action.call.input as { path: string }).path,
      })),
    );
    expect(review).toHaveBeenCalledTimes(2);
  });
});

describe("Pi facade native preparation recovery", () => {
  it("submits the explicit failed-action contract without turning it into a denied capability", async () => {
    const review = vi.fn(async () => approved());
    const runtime = new PiSafetyRuntime({ guardian: { review } });
    runtime.beginTurn(snapshot(), { hasUI: false } as ExtensionContext);
    let executions = 0;
    const result = await runtime.submit({
      captured: runtime.captureAction({
        id: "facade",
        tool: "write",
        input: { path: "/outside/ file ", content: "frozen" },
        cwd: "/workspace",
      }),
      kind: "sandbox",
      risk: { action: "allow", risk: "LOW", reason: "test" },
      runtimeDenialPolicy: "review-and-retry",
      reviewContext: undefined,
      execute: async () => (++executions === 1 ? failed() : { kind: "completed", value: "ok" }),
    });
    expect(result).toEqual({ kind: "completed", value: "ok" });
    expect(executions).toBe(2);
    expect(review).toHaveBeenCalledOnce();
  });
});
