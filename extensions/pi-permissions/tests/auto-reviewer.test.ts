import { describe, expect, it, vi } from "vitest";
import { AutoReviewerFailure, PiAutoReviewer } from "../src/auto-reviewer.ts";

const request = {
  toolCallId: "review-1",
  tool: "bash",
  input: { command: "npm test" },
  cwd: "/workspace",
  sandboxProfile: "workspace-write",
  defaultRisk: "REVIEW",
  defaultReason: "REVIEW operation",
  networkHosts: [],
  filesystemWriteRoots: [],
  userMessages: ["run the tests"],
} as any;

const response = {
  role: "assistant",
  content: [
    {
      type: "text",
      text: JSON.stringify({
        decision: "approve",
        risk: "low",
        rationale: "Authorized test command.",
      }),
    },
  ],
  stopReason: "stop",
} as any;

describe("PiAutoReviewer", () => {
  it("uses the configured model, Pi credentials, and bounded options", async () => {
    const configuredModel = { provider: "openai-codex", id: "reviewer" } as any;
    const complete = vi.fn(async () => response);
    const reviewer = new PiAutoReviewer(complete as any);
    const modelRegistry = {
      find: vi.fn(() => configuredModel),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: "token",
        headers: { "x-test": "yes" },
        env: { TEST_ENV: "yes" },
      })),
    } as any;

    await expect(
      reviewer.review(request, {
        modelRegistry,
        activeModel: { provider: "openai", id: "main" } as any,
        reviewer: {
          provider: "openai-codex",
          model: "reviewer",
          reasoningEffort: "medium",
          timeoutMs: 60_000,
          maxConsecutiveDenials: 3,
        },
      }),
    ).resolves.toMatchObject({ decision: "approve" });

    expect(modelRegistry.find).toHaveBeenCalledWith("openai-codex", "reviewer");
    expect(complete).toHaveBeenCalledWith(
      configuredModel,
      expect.objectContaining({ messages: expect.any(Array) }),
      expect.objectContaining({
        apiKey: "token",
        headers: { "x-test": "yes" },
        env: { TEST_ENV: "yes" },
        reasoningEffort: "medium",
        timeoutMs: 60_000,
        maxRetries: 0,
        cacheRetention: "none",
        signal: expect.any(AbortSignal),
        sessionId: expect.any(String),
      }),
    );
  });

  it("uses the active model when reviewer config is absent", async () => {
    const activeModel = { provider: "openai", id: "main" } as any;
    const complete = vi.fn(async () => response);
    const reviewer = new PiAutoReviewer(complete as any);
    const modelRegistry = {
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "token" })),
    } as any;

    await reviewer.review(request, { modelRegistry, activeModel });
    expect(complete).toHaveBeenCalledWith(
      activeModel,
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("classifies missing models and malformed output as typed failures", async () => {
    const reviewer = new PiAutoReviewer(vi.fn() as any);
    await expect(
      reviewer.review(request, {
        modelRegistry: { find: () => undefined } as any,
        activeModel: undefined,
        reviewer: {
          provider: "missing",
          model: "missing",
          reasoningEffort: "medium",
          timeoutMs: 1000,
          maxConsecutiveDenials: 3,
        },
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });

    const malformed = new PiAutoReviewer(
      vi.fn(async () => ({
        ...response,
        content: [{ type: "text", text: "approve" }],
      })) as any,
    );
    await expect(
      malformed.review(request, {
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "token" }),
        } as any,
        activeModel: { provider: "openai", id: "main" } as any,
      }),
    ).rejects.toMatchObject({ kind: "parse" });
  });

  it("reports caller cancellation without converting it to a timeout", async () => {
    const controller = new AbortController();
    const complete = vi.fn(async (_model, _context, options) => {
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        );
      });
    });
    const reviewer = new PiAutoReviewer(complete as any);
    const pending = reviewer.review(
      request,
      {
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "token" }),
        } as any,
        activeModel: { provider: "openai", id: "main" } as any,
      },
      controller.signal,
    );
    controller.abort(new Error("turn aborted"));

    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("exposes typed reviewer failures", () => {
    expect(new AutoReviewerFailure("timeout", "timed out")).toMatchObject({
      name: "AutoReviewerFailure",
      kind: "timeout",
    });
  });
});
