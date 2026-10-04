import { describe, expect, it, vi } from "vitest";
import { PL_LEFT, PL_RIGHT } from "../../../packages/shared-tool-presentation/src/badge.ts";
import { registerEditorChrome } from "../src/tui/editor-chrome.ts";

function fakeEditor() {
  return {
    borderColor: (s: string) => s,
    render: (width: number) => {
      const border = "─".repeat(width);
      return [border, "input", border];
    },
  };
}

function sessionStartContext() {
  let editorFactory: unknown;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      getEditorComponent: () => editorFactory,
      setEditorComponent: (factory: unknown) => {
        editorFactory = factory;
      },
    },
  };
  return { ctx, getFactory: () => editorFactory };
}

function fakePi() {
  const sessionHandlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const busHandlers = new Map<string, (data: unknown) => void>();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
      sessionHandlers.set(name, handler);
    },
    events: {
      on: (name: string, handler: (data: unknown) => void) => {
        busHandlers.set(name, handler);
      },
    },
  };
  return {
    pi,
    sessionHandlers,
    busHandlers,
    emitMode: (data: unknown) => busHandlers.get("pi-safety:mode")?.(data),
  };
}

function install(pi: ReturnType<typeof fakePi>, uiTheme?: unknown) {
  registerEditorChrome(pi.pi as never);
  const { ctx, getFactory } = sessionStartContext();
  if (uiTheme !== undefined) {
    (ctx.ui as { theme?: unknown }).theme = uiTheme;
  }
  // Seed a previous factory so the chrome wraps a fake editor
  // instead of constructing a real CustomEditor against mock deps.
  ctx.ui.setEditorComponent(() => fakeEditor());
  pi.sessionHandlers.get("session_start")?.({}, ctx);
  return { ctx, getFactory };
}

describe("registerEditorChrome", () => {
  it("installs an editor factory carrying both chrome layers", () => {
    const pi = fakePi();
    const { getFactory } = install(pi);

    const factory = getFactory() as {
      __editorChrome?: boolean;
    };
    expect(typeof factory).toBe("function");
    expect(factory.__editorChrome).toBe(true);

    const editor = (getFactory() as unknown as (t: unknown, th: unknown, k: unknown) => unknown)(
      {},
      {},
      {},
    );
    // Autocomplete-above applied last (outer), box chrome inner.
    expect((editor as { __autocompleteAbove?: boolean }).__autocompleteAbove).toBe(true);
  });

  it("composes the previous editor factory instead of discarding it", () => {
    const pi = fakePi();
    registerEditorChrome(pi.pi as never);
    const inner = fakeEditor();
    const previous = vi.fn(() => inner);
    const { ctx, getFactory } = sessionStartContext();
    ctx.ui.setEditorComponent(previous);
    pi.sessionHandlers.get("session_start")?.({}, ctx);

    const produced = (getFactory() as unknown as (t: unknown, th: unknown, k: unknown) => unknown)(
      {},
      {},
      {},
    );
    expect(previous).toHaveBeenCalledOnce();
    expect(produced).toBe(inner);
  });

  it("does not re-wrap its own factory on repeated session_start", () => {
    const pi = fakePi();
    const { getFactory } = install(pi);
    const first = getFactory();
    pi.sessionHandlers.get("session_start")?.({}, sessionStartContext().ctx);
    pi.sessionHandlers.get("session_start")?.({}, sessionStartContext().ctx);

    expect(getFactory()).toBe(first);
  });

  it("does not install in RPC mode", () => {
    const pi = fakePi();
    registerEditorChrome(pi.pi as never);
    const ctx = { hasUI: true, mode: "rpc", ui: { setEditorComponent: vi.fn() } };
    pi.sessionHandlers.get("session_start")?.({}, ctx);

    expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();
  });

  it("shows the mode badge after a pi-safety:mode event and repaints", async () => {
    const pi = fakePi();
    const { getFactory } = install(pi);
    const requestRender = vi.fn();
    const editor = (getFactory() as unknown as (t: unknown, th: unknown, k: unknown) => unknown)(
      { requestRender },
      {},
      {},
    ) as { render: (w: number) => string[] };

    // No mode yet — plain top border, no badge.
    expect(editor.render(30)[0]).not.toContain("Auto");

    pi.emitMode({ mode: "auto", label: "Auto", severity: "warning" });
    await Promise.resolve(); // coalesced repaint microtask
    expect(requestRender).toHaveBeenCalledOnce();

    const top = editor.render(30)[0];
    expect(top).toContain("Auto");
    expect(top).toContain(PL_LEFT);
    expect(top).toContain(PL_RIGHT);

    // Unchanged state does not repaint.
    pi.emitMode({ mode: "auto", label: "Auto", severity: "warning" });
    await Promise.resolve();
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("paints the badge with the context theme color, not the editor theme", () => {
    const pi = fakePi();
    // The factory's `theme` param is pi-tui's EditorTheme subset
    // (no color accessors); the badge color must come from
    // ctx.ui.theme — the full Theme.
    const uiTheme = {
      getFgAnsi: (color: string) =>
        color === "warning" ? "\x1b[38;2;229;200;144m" : "\x1b[38;2;210;15;57m",
    };
    const { getFactory } = install(pi, uiTheme);
    const editor = (getFactory() as unknown as (t: unknown, th: unknown, k: unknown) => unknown)(
      { requestRender: vi.fn() },
      {},
      {},
    ) as { render: (w: number) => string[] };

    pi.emitMode({ mode: "auto", label: "Auto", severity: "warning" });

    const top = editor.render(30)[0];
    // Warning color becomes the pill background with contrasting text.
    expect(top).toContain("\x1b[48;2;229;200;144m");
    expect(top).not.toContain("\x1b[48;2;210;15;57m");
    expect(top).not.toContain("\x1b[7m"); // no inverse fallback
  });

  it("hides the badge for severity none", () => {
    const pi = fakePi();
    const { getFactory } = install(pi);
    const editor = (getFactory() as unknown as (t: unknown, th: unknown, k: unknown) => unknown)(
      { requestRender: vi.fn() },
      {},
      {},
    ) as { render: (w: number) => string[] };

    pi.emitMode({ mode: "auto", label: "Auto", severity: "warning" });
    expect(editor.render(30)[0]).toContain("Auto");

    pi.emitMode({ mode: "default", label: "", severity: "none" });
    expect(editor.render(30)[0]).not.toContain("Auto");
  });
});
