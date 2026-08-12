import { SettingsSelectorComponent } from "@earendil-works/pi-coding-agent";
import { Editor, Markdown } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

/**
 * Pi 0.84.1 has no public hook for moving the built-in autocomplete list,
 * replacing only fenced-code token rendering, or identifying the active host
 * selector. Keep these deliberate runtime seams loud: a future Pi upgrade
 * should fail here instead of degrading later in an interactive session.
 */
describe("Pi 0.84.1 compatibility seams", () => {
  it("retains the Editor autocomplete fields used for above-editor placement", () => {
    const editor = new Editor(
      { requestRender: () => {}, terminal: { rows: 24, columns: 80 } } as never,
      { borderColor: (text: string) => text, selectList: {} } as never,
    );
    const runtime = editor as unknown as Record<string, unknown>;

    expect(typeof editor.isShowingAutocomplete).toBe("function");
    expect(Object.hasOwn(runtime, "autocompleteList")).toBe(true);
  });

  it("retains Markdown's token renderer and instance theme", () => {
    const markdown = new Markdown("", 0, 0, {} as never);
    const runtime = markdown as unknown as Record<string, unknown>;
    const prototype = Markdown.prototype as unknown as Record<string, unknown>;

    expect(typeof prototype.renderToken).toBe("function");
    expect(Object.hasOwn(runtime, "theme")).toBe(true);
  });

  it("retains the exported settings-selector constructor identity", () => {
    expect(SettingsSelectorComponent.name).toBe("SettingsSelectorComponent");
  });
});
