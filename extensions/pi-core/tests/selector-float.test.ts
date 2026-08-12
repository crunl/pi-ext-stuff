import { describe, expect, it, vi } from "vitest";
import type { FloatingTui } from "../src/tui/editor-float-panel.ts";
import { EffortSelectorComponent } from "../src/tui/effort-command.ts";
import { installSelectorFloat, isAllowlistedSelector } from "../src/tui/selector-float.ts";
import { fakeSelectListTheme, fakeTheme } from "./helpers/effort-fixtures.ts";

// Named class so constructor-name allowlisting matches the real host.
class SettingsSelectorComponent {
  render(_w: number): string[] {
    return ["Settings", "> Auto-compact  true", "  Theme  dark"];
  }
}

class ModelSelectorComponent {
  render(_w: number): string[] {
    return ["model list"];
  }
}

function fakeEditor() {
  return { render: (_w: number) => ["──", "> ", "──"] };
}

function fakeComponent(height: number) {
  return { render: (_w: number) => Array.from({ length: height }, () => "") };
}

function fakeTui(editor: unknown, { rows = 24, cols = 80 } = {}) {
  const overlays: any[] = [];
  const editorContainer: any = {
    children: [editor],
    render(width: number) {
      return (this.children[0] as { render(w: number): string[] }).render(width);
    },
  };
  const tui: FloatingTui & { overlays: any[]; editorContainer: any } = {
    mode: "regular",
    terminal: { rows, columns: cols },
    captureRenderState: () => ({ cursorRow: rows - 1 }),
    children: [fakeComponent(30), editorContainer, fakeComponent(2)],
    overlays,
    editorContainer,
    showOverlay: vi.fn((component: any, options: any) => {
      const entry = { component, options, hidden: false };
      overlays.push(entry);
      return {
        hide: () => overlays.splice(overlays.indexOf(entry), 1),
        setHidden: (hidden: boolean) => {
          entry.hidden = hidden;
        },
        isHidden: () => entry.hidden,
      };
    }),
  } as any;
  return tui;
}

describe("installSelectorFloat", () => {
  it("returns false when the editor is not inside a container", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    (tui.children as unknown[])[1] = editor; // mounted bare
    expect(installSelectorFloat(tui, editor)).toBe(false);
  });

  it("is idempotent per container", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    expect(installSelectorFloat(tui, editor)).toBe(true);
    expect(installSelectorFloat(tui, editor)).toBe(true);
    expect(tui.editorContainer.__selectorFloat).toBe(true);
  });

  it("renders the editor normally while no selector is open", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    installSelectorFloat(tui, editor);

    const lines = tui.editorContainer.render(80);

    expect(lines).toEqual(["──", "> ", "──"]);
    expect(tui.overlays).toHaveLength(0);
  });

  it("floats an allowlisted selector and collapses the container", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    installSelectorFloat(tui, editor);
    tui.editorContainer.children[0] = new SettingsSelectorComponent();

    const lines = tui.editorContainer.render(80);

    expect(lines).toEqual([]); // container collapsed
    expect(tui.overlays).toHaveLength(1);
    const panelLines = tui.overlays[0].component.render(0);
    expect(panelLines[0]).toContain("╭"); // rounded frame
    expect(panelLines[1]).toContain("Settings");
    expect(panelLines[1]).toContain("│");
    expect(tui.overlays[0].options.nonCapturing).toBe(true);
  });

  it("floats /effort via Symbol brand (not constructor.name)", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    installSelectorFloat(tui, editor);

    const effort = new EffortSelectorComponent(
      fakeTheme,
      "high",
      ["off", "high"],
      vi.fn(),
      vi.fn(),
      fakeSelectListTheme,
    );
    expect(isAllowlistedSelector(effort)).toBe(true);

    tui.editorContainer.children[0] = effort;
    const lines = tui.editorContainer.render(80);

    expect(lines).toEqual([]);
    expect(tui.overlays).toHaveLength(1);
    const panelLines = tui.overlays[0].component.render(0).join("\n");
    expect(panelLines).toContain("╭");
    expect(panelLines).toContain("Thinking Level");
  });

  it("leaves non-allowlisted selectors inline", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    installSelectorFloat(tui, editor);
    tui.editorContainer.children[0] = new ModelSelectorComponent();

    const lines = tui.editorContainer.render(80);

    expect(lines).toEqual(["model list"]); // untouched inline render
    expect(tui.overlays).toHaveLength(0);
  });

  it("falls back inline when floating placement is unavailable", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    installSelectorFloat(tui, editor);
    tui.editorContainer.children[0] = new SettingsSelectorComponent();
    tui.captureRenderState = () => ({ cursorRow: 5 }); // short session: top-aligned

    const lines = tui.editorContainer.render(80);

    expect(lines[0]).toContain("Settings"); // inline (unpatched) behavior
  });

  it("retains Pi's inline selector layout in fullscreen mode", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    (tui as any).mode = "fullscreen";
    tui.captureRenderState = undefined;
    installSelectorFloat(tui, editor);
    tui.editorContainer.children[0] = new SettingsSelectorComponent();

    expect(tui.editorContainer.render(80)).toEqual([
      "Settings",
      "> Auto-compact  true",
      "  Theme  dark",
    ]);
    expect(tui.overlays).toHaveLength(0);
  });

  it("conceals the panel when the selector closes", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    installSelectorFloat(tui, editor);
    tui.editorContainer.children[0] = new SettingsSelectorComponent();
    tui.editorContainer.render(80);
    expect(tui.overlays).toHaveLength(1);

    tui.editorContainer.children[0] = editor; // done() restores the editor
    const lines = tui.editorContainer.render(80);

    expect(lines).toEqual(["──", "> ", "──"]);
    expect(tui.overlays[0]?.hidden ?? true).toBe(true);
  });

  it("applies the border color to the frame", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    installSelectorFloat(tui, editor, () => (text) => `<b>${text}</b>`);
    tui.editorContainer.children[0] = new SettingsSelectorComponent();

    tui.editorContainer.render(80);

    const panelLines = tui.overlays[0].component.render(0);
    expect(panelLines[0]).toContain("<b>╭");
  });

  it("falls back inline when the selector render throws", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    installSelectorFloat(tui, editor);
    const broken = new SettingsSelectorComponent();
    broken.render = () => {
      throw new Error("boom");
    };
    tui.editorContainer.children[0] = broken;

    expect(() => tui.editorContainer.render(80)).toThrow("boom"); // original also throws
    expect(tui.overlays).toHaveLength(0);
  });
});
