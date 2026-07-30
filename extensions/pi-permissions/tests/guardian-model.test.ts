import { describe, expect, it, vi } from "vitest";
import { AutoReviewerFailure } from "../src/auto-reviewer.ts";
import { resolveGuardianModel } from "../src/guardian-model.ts";

const preferredModel = { provider: "deepseek", id: "reasoner" } as any;
const activeModel = { provider: "openai", id: "main" } as any;
const configuredReviewer = {
  provider: "deepseek",
  model: "reasoner",
  reasoningEffort: "medium",
} as const;

describe("resolveGuardianModel", () => {
  it("selects a configured Guardian with usable Pi auth", async () => {
    const selected = await resolveGuardianModel({
      modelRegistry: {
        find: () => preferredModel,
        getApiKeyAndHeaders: async () => ({ ok: true }),
      },
      activeModel,
      reviewer: configuredReviewer,
    });

    expect(selected).toMatchObject({
      model: preferredModel,
      source: "configured",
    });
  });

  it("falls back to the active model when the configured Guardian is missing", async () => {
    const selected = await resolveGuardianModel({
      modelRegistry: {
        find: () => undefined,
        getApiKeyAndHeaders: async () => ({ ok: true }),
      },
      activeModel,
      reviewer: configuredReviewer,
    });

    expect(selected).toMatchObject({
      model: activeModel,
      source: "active-fallback",
      fallbackNotice: "configured-reviewer-unavailable",
    });
  });

  it("falls back when configured Guardian auth is unavailable", async () => {
    const selected = await resolveGuardianModel({
      modelRegistry: {
        find: () => preferredModel,
        getApiKeyAndHeaders: vi.fn(async (model) =>
          model === preferredModel
            ? ({ ok: false, error: "unavailable" } as const)
            : ({ ok: true } as const),
        ),
      },
      activeModel,
      reviewer: configuredReviewer,
    });

    expect(selected).toMatchObject({
      model: activeModel,
      source: "active-fallback",
      fallbackNotice: "configured-reviewer-unavailable",
    });
  });

  it("falls back when configured Guardian auth lookup throws", async () => {
    const selected = await resolveGuardianModel({
      modelRegistry: {
        find: () => preferredModel,
        getApiKeyAndHeaders: vi.fn(async (model) => {
          if (model === preferredModel) throw new Error("credential backend failed");
          return { ok: true } as const;
        }),
      },
      activeModel,
      reviewer: configuredReviewer,
    });

    expect(selected).toMatchObject({
      model: activeModel,
      source: "active-fallback",
      fallbackNotice: "configured-reviewer-unavailable",
    });
  });

  it("rechecks auth when configured and active models are the same object", async () => {
    const modelRegistry = {
      find: () => preferredModel,
      getApiKeyAndHeaders: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: "unavailable" })
        .mockResolvedValueOnce({ ok: true }),
    };

    const selected = await resolveGuardianModel({
      modelRegistry,
      activeModel: preferredModel,
      reviewer: configuredReviewer,
    });

    expect(selected).toMatchObject({
      model: preferredModel,
      source: "active-fallback",
      fallbackNotice: "configured-reviewer-unavailable",
    });
  });

  it("uses the active model directly when no Guardian is configured", async () => {
    const selected = await resolveGuardianModel({
      modelRegistry: {
        find: () => preferredModel,
        getApiKeyAndHeaders: async () => ({ ok: true }),
      },
      activeModel,
    });

    expect(selected).toMatchObject({ model: activeModel, source: "active" });
  });

  it("rejects with a non-secret unavailable failure when the active model cannot authenticate", async () => {
    const failure = resolveGuardianModel({
      modelRegistry: {
        find: () => undefined,
        getApiKeyAndHeaders: async () => ({ ok: false, error: "secret provider detail" }),
      },
      activeModel,
      reviewer: configuredReviewer,
    });

    await expect(failure).rejects.toEqual(
      new AutoReviewerFailure("unavailable", "No usable Guardian or active Pi model is available"),
    );
  });
});
