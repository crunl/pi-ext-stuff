import { describe, expect, it, vi } from "vitest";
import {
  availableThinkingLevels,
  EffortSelectorComponent,
  registerEffortCommand,
  THINKING_DESCRIPTIONS,
} from "../src/tui/effort-command.ts";
import {
  fakeSelectListTheme as selectListTheme,
  fakeTheme as theme,
} from "./helpers/effort-fixtures.ts";

describe("availableThinkingLevels", () => {
  it("returns only off when the model has no reasoning", () => {
    expect(availableThinkingLevels(undefined)).toEqual(["off"]);
    expect(availableThinkingLevels({ reasoning: false })).toEqual(["off"]);
  });

  it("includes base levels for a reasoning model without a map", () => {
    expect(availableThinkingLevels({ reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("hides levels mapped to null and only shows xhigh/max when mapped", () => {
    expect(
      availableThinkingLevels({
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          xhigh: "xhigh",
          max: "max",
        },
      }),
    ).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("THINKING_DESCRIPTIONS", () => {
  it("matches settings-selector copy for every extended level", () => {
    expect(THINKING_DESCRIPTIONS.off).toBe("No reasoning");
    expect(THINKING_DESCRIPTIONS.high).toContain("~16k");
    expect(THINKING_DESCRIPTIONS.max).toBe("Maximum reasoning");
  });
});

describe("EffortSelectorComponent", () => {
  it("forwards input to the select list and reports selection", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const panel = new EffortSelectorComponent(
      theme,
      "high",
      ["off", "low", "high"],
      onSelect,
      onCancel,
      selectListTheme,
    );

    // Enter confirms the preselected "high" (index of high in list).
    panel.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith("high");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("renders title and level labels", () => {
    const panel = new EffortSelectorComponent(
      theme,
      "low",
      ["off", "low", "high"],
      vi.fn(),
      vi.fn(),
      selectListTheme,
    );
    const lines = panel.render(80).join("\n");
    expect(lines).toContain("Thinking Level");
    expect(lines).toContain("Select reasoning depth");
    expect(lines).toContain("low");
    expect(lines).toContain("high");
  });
});

describe("registerEffortCommand", () => {
  it("registers /effort and opens the panel for reasoning models", async () => {
    const commands = new Map<string, any>();
    const setThinkingLevel = vi.fn();
    const getThinkingLevel = vi.fn(() => "medium");
    const notify = vi.fn();
    const custom = vi.fn(async (_factory: any) => "high");

    registerEffortCommand({
      registerCommand: (name: string, opts: any) => commands.set(name, opts),
      getThinkingLevel,
      setThinkingLevel,
    } as any);

    expect(commands.has("effort")).toBe(true);
    await commands.get("effort").handler("", {
      hasUI: true,
      mode: "tui",
      model: { reasoning: true },
      ui: { custom, notify },
    });

    expect(custom).toHaveBeenCalled();
    expect(setThinkingLevel).toHaveBeenCalledWith("high");
    expect(notify).toHaveBeenCalledWith("Thinking level: high", "info");
  });

  it("warns and skips the panel when the model cannot think", async () => {
    const commands = new Map<string, any>();
    const notify = vi.fn();
    const custom = vi.fn();

    registerEffortCommand({
      registerCommand: (name: string, opts: any) => commands.set(name, opts),
      getThinkingLevel: () => "off",
      setThinkingLevel: vi.fn(),
    } as any);

    await commands.get("effort").handler("", {
      hasUI: true,
      mode: "tui",
      model: { reasoning: false },
      ui: { custom, notify },
    });

    expect(custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Current model does not support thinking", "warning");
  });

  it("does nothing outside tui", async () => {
    const commands = new Map<string, any>();
    const custom = vi.fn();
    registerEffortCommand({
      registerCommand: (name: string, opts: any) => commands.set(name, opts),
      getThinkingLevel: () => "high",
      setThinkingLevel: vi.fn(),
    } as any);

    await commands.get("effort").handler("", {
      hasUI: true,
      mode: "rpc",
      model: { reasoning: true },
      ui: { custom, notify: vi.fn() },
    });
    expect(custom).not.toHaveBeenCalled();
  });
});
