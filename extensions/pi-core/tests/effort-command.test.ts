import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerEffortCommand } from "../src/tui/effort-command.ts";
import { isAllowlistedSelector } from "../src/tui/selector-float.ts";
import { fakeTheme as theme } from "./helpers/effort-fixtures.ts";

interface TuiContextDouble {
  hasUI: boolean;
  mode: string;
  model: unknown;
  ui: { custom: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
}

function register(commands = new Map<string, any>(), pi: any = {}) {
  registerEffortCommand({
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    getThinkingLevel: () => "medium",
    setThinkingLevel: vi.fn(),
    ...pi,
  } as any);
  return commands;
}

function tuiContext(overrides: Partial<TuiContextDouble> = {}): TuiContextDouble {
  return {
    hasUI: true,
    mode: "tui",
    model: { reasoning: true },
    ui: { custom: vi.fn(), notify: vi.fn() },
    ...overrides,
  };
}

describe("registerEffortCommand", () => {
  it("registers /effort and applies the chosen level for the session", async () => {
    const commands = new Map<string, any>();
    const setThinkingLevel = vi.fn();
    const notify = vi.fn();
    const custom = vi.fn(async (_factory: any) => ({ level: "high", asDefault: false }));
    register(commands, { setThinkingLevel });

    expect(commands.has("effort")).toBe(true);
    await commands.get("effort").handler("", { ...tuiContext(), ui: { custom, notify } });

    expect(custom).toHaveBeenCalled();
    expect(setThinkingLevel).toHaveBeenCalledWith("high");
    expect(notify).toHaveBeenCalledWith("Thinking level: high", "info");
  });

  it("points at /settings when the save-key choice is used", async () => {
    const commands = new Map<string, any>();
    const setThinkingLevel = vi.fn();
    const notify = vi.fn();
    const custom = vi.fn(async (_factory: any) => ({ level: "max", asDefault: true }));
    register(commands, { setThinkingLevel });

    await commands.get("effort").handler("", { ...tuiContext(), ui: { custom, notify } });

    // Extensions cannot persist the default; the level still applies to the
    // session and the notice stays honest about where defaults live.
    expect(setThinkingLevel).toHaveBeenCalledWith("max");
    expect(notify).toHaveBeenCalledWith(
      "Thinking level: max (this session; change the default in /settings)",
      "info",
    );
  });

  it("does nothing when the panel is dismissed", async () => {
    const commands = new Map<string, any>();
    const setThinkingLevel = vi.fn();
    const notify = vi.fn();
    const custom = vi.fn(async (_factory: any) => undefined);
    register(commands, { setThinkingLevel });

    await commands.get("effort").handler("", { ...tuiContext(), ui: { custom, notify } });

    expect(setThinkingLevel).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("warns and skips the panel when the model cannot think", async () => {
    const commands = new Map<string, any>();
    const notify = vi.fn();
    const custom = vi.fn();
    register(commands);

    await commands.get("effort").handler("", {
      ...tuiContext(),
      model: { reasoning: false },
      ui: { custom, notify },
    });

    expect(custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Current model does not support thinking", "warning");
  });

  it("does nothing outside tui", async () => {
    const commands = new Map<string, any>();
    const custom = vi.fn();
    register(commands);

    await commands.get("effort").handler("", {
      ...tuiContext(),
      mode: "rpc",
      ui: { custom, notify: vi.fn() },
    });
    expect(custom).not.toHaveBeenCalled();
  });

  it("composes the host panel as a floatable component wired to done()", async () => {
    const commands = new Map<string, any>();
    let factory: any;
    const custom = vi.fn(async (f: any) => {
      factory = f;
      return undefined;
    });
    register(commands);

    await commands.get("effort").handler("", { ...tuiContext(), ui: { custom, notify: vi.fn() } });
    expect(factory).toBeDefined();

    // The host panel reads the theme singleton at construction.
    initTheme();
    const done = vi.fn();
    const component = factory({}, theme, {}, done);
    expect(isAllowlistedSelector(component)).toBe(true);

    // Drive the host panel's own select/cancel outlets: our closures must
    // translate them into the EffortChoice the handler understands.
    // getSelectList() is the component's public accessor — do not reach
    // into its private field.
    const selectList = component.getSelectList() as unknown as {
      onSelect: ((item: { value: string }) => void) | undefined;
      onCancel: (() => void) | undefined;
    };
    selectList.onSelect?.({ value: "high" });
    expect(done).toHaveBeenCalledWith({ level: "high", asDefault: false });
    selectList.onCancel?.();
    expect(done).toHaveBeenCalledWith(undefined);
  });
});
