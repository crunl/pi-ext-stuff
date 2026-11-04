import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  countStepGroupItems,
  createSettledStepGroupComponent,
  createUnsettledToolStepComponent,
  formatStepGroupHeader,
  formatStepGroupSummaryText,
  isStepGroupToolName,
  type RenderableStepGroupItem,
  renderThoughtStepLines,
  type StepGroupTheme,
} from "../src/index.ts";

const plainTheme: StepGroupTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
};

describe("step-group pure presentation", () => {
  it("recognizes only the 7 built-in tools in step-group scope", () => {
    for (const name of ["edit", "write", "bash", "read", "grep", "find", "ls"]) {
      expect(isStepGroupToolName(name)).toBe(true);
    }
    expect(isStepGroupToolName("codemode")).toBe(false);
    expect(isStepGroupToolName("subagent")).toBe(false);
    expect(isStepGroupToolName("mcp__github__search")).toBe(false);
  });

  it("counts and formats summary clauses in canonical order omitting zero categories", () => {
    const counts = countStepGroupItems([
      { kind: "thought" },
      { kind: "tool", toolName: "read" },
      { kind: "tool", toolName: "grep" },
      { kind: "tool", toolName: "find" },
      { kind: "tool", toolName: "ls" },
      { kind: "thought" },
      { kind: "tool", toolName: "edit" },
      { kind: "tool", toolName: "write" },
      { kind: "tool", toolName: "write" },
      { kind: "tool", toolName: "bash" },
    ]);

    expect(counts).toEqual({
      edit: 1,
      write: 2,
      read: 1,
      search: 3,
      bash: 1,
      thought: 2,
    });
    expect(formatStepGroupSummaryText(counts)).toBe(
      "Edited 1 file · Wrote 2 files · Read 1 file · Searched 3 · Ran 1 command · 2 thoughts",
    );
    expect(formatStepGroupHeader(counts, false, plainTheme)).toBe(
      "▸ Edited 1 file · Wrote 2 files · Read 1 file · Searched 3 · Ran 1 command · 2 thoughts",
    );
    expect(formatStepGroupHeader(counts, true, plainTheme)).toBe(
      "▾ Edited 1 file · Wrote 2 files · Read 1 file · Searched 3 · Ran 1 command · 2 thoughts",
    );
  });

  it("renders collapsed and expanded thought lines", () => {
    const collapsed = renderThoughtStepLines("First line\nSecond line", false, 80, 1, plainTheme);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.trim()).toBe("Thinking...");

    const expanded = renderThoughtStepLines("First line\nSecond line", true, 80, 1, plainTheme);
    expect(expanded).toHaveLength(3);
    expect(expanded[0]?.trim()).toBe("Thinking");
    expect(expanded[1]).toBe("   First line");
    expect(expanded[2]).toBe("   Second line");
  });

  it("supports two-level click expansion in createSettledStepGroupComponent", () => {
    let groupExpanded = false;
    const expandedIds = new Set<string>();

    const steps = (): RenderableStepGroupItem[] => [
      {
        kind: "thought",
        id: "thought-1",
        text: "Analyzing files",
        expanded: expandedIds.has("thought-1"),
      },
      {
        kind: "tool",
        id: "tool-1",
        toolName: "read",
        expanded: expandedIds.has("tool-1"),
        renderLines: (_width, expanded) =>
          expanded
            ? ["Read src/a.ts · 10 lines ▼", "  1 | const a = 1;"]
            : ["Read src/a.ts · 10 lines ▶"],
      },
      {
        kind: "tool",
        id: "tool-2",
        toolName: "edit",
        expanded: expandedIds.has("tool-2"),
        renderLines: (_width, expanded) =>
          expanded
            ? ["Edited src/a.ts · +1 -1 ▼", "  - const a = 1;", "  + const a = 2;"]
            : ["Edited src/a.ts · +1 -1 ▶"],
      },
    ];

    const component = createSettledStepGroupComponent({
      getGroupExpanded: () => groupExpanded,
      onToggleGroup: () => {
        groupExpanded = !groupExpanded;
      },
      getSteps: steps,
      onToggleStep: (stepId) => {
        if (expandedIds.has(stepId)) expandedIds.delete(stepId);
        else expandedIds.add(stepId);
      },
      theme: plainTheme,
      getOutputPad: () => 0,
    });

    // State 0: collapsed 1-line summary
    const state0Lines = component.render(100);
    expect(state0Lines).toHaveLength(1);
    expect(state0Lines[0]?.trim()).toBe("▸ Edited 1 file · Read 1 file · 1 thought");

    // Click y=0 -> State 1 (list of collapsed child steps under │ gutter)
    expect(component.handleMouse({ type: "click", button: "left", y: 0 })).toEqual({
      handled: true,
    });
    expect(groupExpanded).toBe(true);
    const state1Lines = component.render(100);
    expect(state1Lines).toHaveLength(4);
    expect(state1Lines[0]?.trim()).toBe("▾ Edited 1 file · Read 1 file · 1 thought");
    expect(state1Lines[1]?.trimEnd()).toBe("│ Thinking...");
    expect(state1Lines[2]).toBe("│ Read src/a.ts · 10 lines ▶");
    expect(state1Lines[3]).toBe("│ Edited src/a.ts · +1 -1 ▶");

    // Click y=3 (tool-2) -> State 2 (tool-2 expanded in-place with ├─ and │ rail)
    expect(component.handleMouse({ type: "click", button: "left", y: 3 })).toEqual({
      handled: true,
    });
    const state2Lines = component.render(100);
    expect(state2Lines).toHaveLength(6);
    expect(state2Lines[3]).toBe("├─Edited src/a.ts · +1 -1 ▼");
    expect(state2Lines[4]).toBe("│   - const a = 1;");
    expect(state2Lines[5]).toBe("│   + const a = 2;");

    // Click y=1 (thought-1) -> expands thought-1 too with ├─ and │ rail
    expect(component.handleMouse({ type: "click", button: "left", y: 1 })).toEqual({
      handled: true,
    });
    const state2WithThought = component.render(100);
    expect(state2WithThought).toHaveLength(7);
    expect(state2WithThought[1]?.trimEnd()).toBe("├─Thinking");
    expect(state2WithThought[2]).toBe("│   Analyzing files");

    // Click y=0 -> collapses back to State 0
    expect(component.handleMouse({ type: "click", button: "left", y: 0 })).toEqual({
      handled: true,
    });
    expect(groupExpanded).toBe(false);
    expect(component.render(100)).toHaveLength(1);
  });

  it("renders leading and trailing thoughts on unsettled tools and routes clicks accurately", () => {
    const toggledThoughts: string[] = [];
    let leadingExpanded = false;

    const component = createUnsettledToolStepComponent({
      getLeadingThoughts: () => [
        { id: "t-lead", text: "Checking imports", expanded: leadingExpanded },
      ],
      getTrailingThoughts: () => [{ id: "t-trail", text: "Done checking", expanded: false }],
      renderToolLines: () => ["Read src/a.ts · 10 lines ▶"],
      onToggleThought: (id) => {
        toggledThoughts.push(id);
        if (id === "t-lead") leadingExpanded = !leadingExpanded;
      },
      theme: plainTheme,
      getOutputPad: () => 0,
    });

    const lines = component.render(80);
    // y=0: leading thought ("Thinking...")
    // y=1: spacer ("")
    // y=2: tool ("Read src/a.ts · 10 lines ▶")
    // y=3: spacer ("")
    // y=4: trailing thought ("Thinking...")
    expect(lines).toHaveLength(5);
    expect(lines[0]?.trim()).toBe("Thinking...");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("Read src/a.ts · 10 lines ▶");
    expect(lines[3]).toBe("");
    expect(lines[4]?.trim()).toBe("Thinking...");

    // Clicking leading thought (y=0) toggles thought and returns { handled: true }
    expect(component.handleMouse({ type: "click", button: "left", y: 0 })).toEqual({
      handled: true,
    });
    expect(toggledThoughts).toEqual(["t-lead"]);

    // Clicking spacer (y=1) is swallowed so it does not toggle the tool
    const expandedLines = component.render(80);
    expect(expandedLines).toHaveLength(6); // leading thought now takes 2 lines (y=0, y=1), spacer at y=2
    expect(component.handleMouse({ type: "click", button: "left", y: 2 })).toEqual({
      handled: true,
    });

    // Clicking the tool line itself (y=3) returns undefined so host MouseRegion handles it
    const onHostClick = vi.fn();
    const res = component.handleMouse({ type: "click", button: "left", y: 3 });
    if (!res) onHostClick();
    expect(res).toBeUndefined();
    expect(onHostClick).toHaveBeenCalledTimes(1);
  });

  it("handles narrow widths (width <= 0 and width <= 2) and empty toolLines without overflow or double spacers", () => {
    expect(renderThoughtStepLines("Hello world", true, 0, 1, plainTheme)).toEqual([]);
    const narrowThought = renderThoughtStepLines("Hello\n\nWorld", true, 2, 1, plainTheme);
    for (const line of narrowThought) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(2);
    }

    const settled = createSettledStepGroupComponent({
      getGroupExpanded: () => true,
      onToggleGroup: () => {},
      getSteps: () => [
        { kind: "thought", id: "t1", text: "Note", expanded: true },
        {
          kind: "tool",
          id: "c1",
          toolName: "read",
          expanded: false,
          renderLines: (w) => ["x".repeat(w)],
        },
      ],
      onToggleStep: () => {},
      theme: plainTheme,
      getOutputPad: () => 0,
    });
    expect(settled.render(0)).toEqual([]);
    for (const line of settled.render(2)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(2);
    }

    const unsettledEmptyTool = createUnsettledToolStepComponent({
      getLeadingThoughts: () => [{ id: "t1", text: "First", expanded: false }],
      getTrailingThoughts: () => [{ id: "t2", text: "Second", expanded: false }],
      renderToolLines: () => [],
      onToggleThought: () => {},
      theme: plainTheme,
      getOutputPad: () => 0,
    });
    expect(unsettledEmptyTool.render(0)).toEqual([]);
    const lines = unsettledEmptyTool.render(80).map((line) => line.trimEnd());
    // Only 1 spacer between t1 and t2, and no trailing blank line
    expect(lines).toEqual(["Thinking...", "", "Thinking..."]);
  });
});
