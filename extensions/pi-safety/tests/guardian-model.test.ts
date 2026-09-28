import { describe, expect, it, vi } from "vitest";
import { AutoReviewerFailure } from "../src/auto-reviewer.ts";
import { resolveGuardianModel } from "../src/guardian-model.ts";

const preferredModel = { provider: "deepseek", id: "reasoner" } as any;
const activeModel = { provider: "openai", id: "main" } as any;
const configuredReviewer = {
  model: "deepseek/reasoner",
  reasoningEffort: "medium",
} as const;

describe("resolveGuardianModel", () => {
  it("selects a configured Guardian with usable Pi auth", async () => {
    const find = vi.fn(() => preferredModel);
    const selected = await resolveGuardianModel({
      modelRegistry: {
        find,
        getApiKeyAndHeaders: async () => ({ ok: true }),
      },
      activeModel,
      reviewer: configuredReviewer,
    });

    expect(selected).toMatchObject({
      model: preferredModel,
      source: "configured",
    });
    expect(find).toHaveBeenCalledWith("deepseek", "reasoner");
  });

  it("falls back to the active model when the configured Guardian is missing", async () => {
    const find = vi.fn(() => undefined);
    const selected = await resolveGuardianModel({
      modelRegistry: {
        find,
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
    expect(find).toHaveBeenCalledWith("deepseek", "reasoner");
  });

  it("anchors the split to the first slash, keeping slashes in the model id", async () => {
    const slashyModel = { provider: "openrouter", id: "stealth/space-bunny-alpha" } as any;
    const find = vi.fn(() => slashyModel);
    const selected = await resolveGuardianModel({
      modelRegistry: {
        find,
        getApiKeyAndHeaders: async () => ({ ok: true }),
      },
      activeModel,
      reviewer: { model: "openrouter/stealth/space-bunny-alpha", reasoningEffort: "medium" },
    });

    expect(selected).toMatchObject({ model: slashyModel, source: "configured" });
    expect(find).toHaveBeenCalledWith("openrouter", "stealth/space-bunny-alpha");
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

  it("falls back when configured Guardian registry lookup throws", async () => {
    const selected = await resolveGuardianModel({
      modelRegistry: {
        find: () => {
          throw new Error("registry backend failed");
        },
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

  it("falls back when a context bypasses config validation with a slashless reviewer model", async () => {
    const find = vi.fn(() => preferredModel);
    const selected = await resolveGuardianModel({
      modelRegistry: {
        find,
        getApiKeyAndHeaders: async () => ({ ok: true }),
      },
      activeModel,
      // Config load rejects this shape; a context built without it must fail
      // over to the active model rather than guess a provider.
      reviewer: { model: "reasoner", reasoningEffort: "medium" },
    });

    expect(selected).toMatchObject({
      model: activeModel,
      source: "active-fallback",
      fallbackNotice: "configured-reviewer-unavailable",
    });
    expect(find).not.toHaveBeenCalled();
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
      new AutoReviewerFailure(
        "unavailable",
        "No usable configured or active reviewer model is available",
      ),
    );
  });
});
