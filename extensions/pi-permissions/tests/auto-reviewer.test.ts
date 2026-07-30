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
        risk_level: "low",
        user_authorization: "high",
        outcome: "allow",
        rationale: "Authorized test command.",
      }),
    },
  ],
  stopReason: "stop",
} as any;

describe("PiAutoReviewer", () => {
  it("uses configured Guardian metadata and bounded options", async () => {
    const configuredModel = { provider: "openai-codex", id: "reviewer" } as any;
    const complete = vi.fn(async (_model: unknown, _context: unknown) => response);
    const reviewer = new PiAutoReviewer(complete as any);
    const modelRegistry = {
      find: vi.fn(() => configuredModel),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true })),
    } as any;

    await expect(
      reviewer.review(request, {
        modelRegistry,
        activeModel: { provider: "openai", id: "main" } as any,
        reviewer: {
          provider: "openai-codex",
          model: "reviewer",
          reasoningEffort: "medium",
        },
      }),
    ).resolves.toMatchObject({
      decision: "approve",
      guardian: {
        provider: "openai-codex",
        model: "reviewer",
        source: "configured",
      },
    });

    expect(modelRegistry.find).toHaveBeenCalledWith("openai-codex", "reviewer");
    expect(complete).toHaveBeenCalledWith(
      configuredModel,
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          "You are judging one planned coding-agent action.",
        ),
        messages: expect.any(Array),
      }),
      expect.objectContaining({
        reasoningEffort: "medium",
        maxRetries: 0,
        cacheRetention: "none",
        signal: expect.any(AbortSignal),
        sessionId: expect.any(String),
      }),
    );
    const reviewContext = complete.mock.calls[0]?.[1] as any;
    expect(reviewContext.systemPrompt).toContain("# Evidence Handling");
    expect(reviewContext.systemPrompt).toContain("# User Authorization Scoring");
    expect(reviewContext.systemPrompt).toContain("# Base Risk Taxonomy");
    expect(reviewContext.systemPrompt).toContain("# Outcome Policy");
    expect(reviewContext.systemPrompt).toContain(
      '"user_authorization": "unknown" | "low" | "medium" | "high"',
    );
    expect(reviewContext.systemPrompt).not.toContain(
      "{{ tenant_policy_config }}",
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

  it("stops after cancellation during Guardian selection before request auth", async () => {
    const controller = new AbortController();
    let resolveSelectionAuth: (auth: { ok: true }) => void;
    const selectionAuth = new Promise<{ ok: true }>((resolve) => {
      resolveSelectionAuth = resolve;
    });
    const complete = vi.fn(async () => response);
    const modelRegistry = {
      find: () => ({ provider: "deepseek", id: "reasoner" }),
      getApiKeyAndHeaders: vi.fn(() => selectionAuth),
    } as any;
    const reviewer = new PiAutoReviewer(complete as any);

    const pending = reviewer.review(
      request,
      {
        modelRegistry,
        activeModel: { provider: "openai", id: "main" } as any,
        reviewer: {
          provider: "deepseek",
          model: "reasoner",
          reasoningEffort: "medium",
        },
      },
      controller.signal,
    );
    controller.abort();
    resolveSelectionAuth!({ ok: true });

    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    expect(modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not fall back after selected Guardian request auth fails", async () => {
    const configuredModel = { provider: "deepseek", id: "reasoner" } as any;
    const activeModel = { provider: "openai", id: "main" } as any;
    const complete = vi.fn(async () => response);
    const modelRegistry = {
      find: () => configuredModel,
      getApiKeyAndHeaders: vi
        .fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, error: "unavailable" }),
    } as any;
    const reviewer = new PiAutoReviewer(complete as any);

    await expect(
      reviewer.review(request, {
        modelRegistry,
        activeModel,
        reviewer: {
          provider: "deepseek",
          model: "reasoner",
          reasoningEffort: "medium",
        },
      }),
    ).rejects.toMatchObject({
      kind: "unavailable",
      message: "No usable Guardian or active Pi model is available",
    });

    expect(modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledTimes(2);
    expect(modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalledWith(activeModel);
    expect(complete).not.toHaveBeenCalled();
  });

  it("enforces timeout when a provider ignores the abort signal", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    const reviewer = new PiAutoReviewer(
      vi.fn(
        async () =>
          new Promise<typeof response>(() => {}),
      ) as any,
    );

    const pending = reviewer.review(request, {
      modelRegistry: {
        find: () => ({ provider: "openai", id: "main" }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "token" }),
      } as any,
      activeModel: { provider: "openai", id: "main" } as any,
      reviewer: {
        provider: "openai",
        model: "main",
        reasoningEffort: "medium",
      },
    });
    timeout.abort();

    await expect(pending).rejects.toMatchObject({ kind: "timeout" });
    timeoutSpy.mockRestore();
  });

  it("exposes typed reviewer failures", () => {
    expect(new AutoReviewerFailure("timeout", "timed out")).toMatchObject({
      name: "AutoReviewerFailure",
      kind: "timeout",
    });
  });
});
