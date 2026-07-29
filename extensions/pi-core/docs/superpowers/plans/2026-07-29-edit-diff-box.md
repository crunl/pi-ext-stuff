# Edit Diff Box Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render successful `edit` results inside an Edit-only `pi-tui` `Box` with aligned old/new line numbers when `Ctrl+O` is expanded, while keeping the existing one-line Header when collapsed.

**Architecture:** Keep lifecycle and Header rendering in `createCodexToolRendering`, but replace the Edit-specific string hook with a narrow Component factory hook. A new `EditDiffBox` parses Pi's display diff (`marker + line number + content`), wraps only the content column, and composes a `Box` with a width-aware child `Component`. `pi-permissions` only wires this component into its existing sandboxed `edit` tool.

**Tech Stack:** TypeScript 5.9, `@earendil-works/pi-coding-agent` 0.82.1, `@earendil-works/pi-tui` 0.82.1, Vitest 4.1.

## Global Constraints

- Do not modify the installed Pi or Pi TUI packages.
- Do not add syntax highlighting or any new runtime dependency in this iteration.
- Keep the Header outside the Box and visible in both collapsed and expanded states.
- Collapsed successful Edit output is Header-only; `Ctrl+O` expands the Box in place.
- Preserve the colored Header summary: additions use `success`, deletions use `error`.
- Added rows use `toolDiffAdded`, removed rows use `toolDiffRemoved`, and context rows use `toolDiffContext`.
- Use `Box` as a background/padding panel, not as a four-sided border.
- Use `paddingX = 1` and `paddingY = 0`; do not add `Spacer` or blank separator rows.
- Preserve dynamic Output padding and ANSI/CJK-aware terminal-width handling.
- Preserve existing Bash, Write, Read, Grep, Find, and Ls rendering.
- Preserve unrelated dirty changes in both repositories.
- Before feature commits, checkpoint the current `pi-core` repository, which currently has no initial commit, and intentionally resolve the existing dirty `pi-permissions` worktree. Do not stage unrelated changes implicitly.
- Run Task 1 and Task 2 `npm` commands from `/Users/x1a2h1/.pi/agent/extensions/pi-core`.
- Run Task 3 `npm` commands from `/Users/x1a2h1/.pi/agent/extensions/pi-permissions`.
- Run every repository-spanning `rg` command and every `git -C agent/extensions/...` command from `/Users/x1a2h1/.pi`.

---

## File Structure

- Create `agent/extensions/pi-core/src/tui/edit-diff.ts`
  - Parse Pi display-diff rows.
  - Render aligned marker, old/new line number, separator, and wrapped content.
  - Own the Edit-only `Box`.
- Create `agent/extensions/pi-core/tests/edit-diff.test.ts`
  - Unit-test parsing, alignment, wrapping, colors, Box padding, and Output padding.
- Modify `agent/extensions/pi-core/src/tui/tool-renderer.ts`
  - Add a Component-level expanded-result hook.
  - Keep generic text rendering as the fallback for all other tools.
- Modify `agent/extensions/pi-core/index.ts`
  - Export the Edit Box factory and its public types.
- Modify `agent/extensions/pi-core/tests/tool-renderer.test.ts`
  - Verify the Component hook is used only for successful expanded results.
- Modify `agent/extensions/pi-permissions/src/register.ts`
  - Wire the Edit Box factory into the sandboxed `edit` tool.
- Modify `agent/extensions/pi-permissions/tests/register.test.ts`
  - Verify Header-only collapse and full Box expansion through the registered tool.

---

### Task 1: Parse and Render the Edit Diff Box

**Files:**
- Create: `agent/extensions/pi-core/src/tui/edit-diff.ts`
- Create: `agent/extensions/pi-core/tests/edit-diff.test.ts`

**Interfaces:**
- Consumes: Pi `EditToolDetails.diff`, whose verified display format is `" 1 context\n-2 old\n+2 new"`.
- Produces:

```ts
export type EditDiffKind = "context" | "added" | "removed";

export interface EditDiffRow {
  kind: EditDiffKind;
  lineNumber?: number;
  content: string;
}

export function parseEditDiff(diff: string): EditDiffRow[];

export interface EditDiffBoxOptions {
  outputPad: 0 | 1;
}

export function createEditDiffBox(
  diff: string,
  theme: Theme,
  options: EditDiffBoxOptions,
): Component;
```

- [ ] **Step 1: Write failing parser tests**

Add literal expectations that independently describe Pi's display-diff format:

```ts
it("parses context, removed, and added rows with their old/new line numbers", () => {
  expect(parseEditDiff([
    " 9 before",
    "-10 old value",
    "+10 new value",
    "+11 added value",
  ].join("\n"))).toEqual([
    { kind: "context", lineNumber: 9, content: "before" },
    { kind: "removed", lineNumber: 10, content: "old value" },
    { kind: "added", lineNumber: 10, content: "new value" },
    { kind: "added", lineNumber: 11, content: "added value" },
  ]);
});

it("preserves an unrecognized display-diff row as context content", () => {
  expect(parseEditDiff("\\ No newline at end of file")).toEqual([
    {
      kind: "context",
      lineNumber: undefined,
      content: "\\ No newline at end of file",
    },
  ]);
});

it("returns no rows for an empty diff", () => {
  expect(parseEditDiff("")).toEqual([]);
});
```

- [ ] **Step 2: Run parser tests and verify RED**

Run:

```bash
rtk npm test -- tests/edit-diff.test.ts
```

Expected: FAIL because `edit-diff.ts` and `parseEditDiff` do not exist.

- [ ] **Step 3: Implement the minimal parser**

Use Pi's verified row grammar rather than recomputing line numbers:

```ts
const DISPLAY_DIFF_ROW = /^([ +\-])(\s*\d*)\s(.*)$/;

export function parseEditDiff(diff: string): EditDiffRow[] {
  if (diff.length === 0) return [];
  return diff.split(/\r?\n/).map((line) => {
    const match = DISPLAY_DIFF_ROW.exec(line);
    if (!match) {
      return {
        kind: "context",
        lineNumber: undefined,
        content: line,
      };
    }
    return {
      kind: match[1] === "+"
        ? "added"
        : match[1] === "-"
          ? "removed"
          : "context",
      lineNumber: match[2].trim()
        ? Number.parseInt(match[2], 10)
        : undefined,
      content: match[3],
    };
  });
}
```

- [ ] **Step 4: Run parser tests and verify GREEN**

Run:

```bash
rtk npm test -- tests/edit-diff.test.ts
```

Expected: parser tests PASS.

- [ ] **Step 5: Write failing component tests**

Use an ANSI-producing fake theme so terminal width excludes color escapes. Cover:

```ts
const BG_START = "\u001b[48;5;22m";
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (text: string): string => text.replace(ANSI, "");
const theme = {
  fg: (color: string, text: string) => {
    if (color === "toolDiffAdded") return `\u001b[32m${text}\u001b[0m`;
    if (color === "toolDiffRemoved") return `\u001b[31m${text}\u001b[0m`;
    return `\u001b[90m${text}\u001b[0m`;
  },
  bg: (_color: string, text: string) =>
    `${BG_START}${text}\u001b[0m`,
} as Theme;

it("aligns old and new line numbers inside an Edit-only Box", () => {
  const component = createEditDiffBox(
    " 9 before\n-10 old value\n+10 new value",
    theme,
    { outputPad: 1 },
  );
  const rendered = component.render(40);

  expect(stripAnsi(rendered.join("\n"))).toContain("   9 │ before");
  expect(stripAnsi(rendered.join("\n"))).toContain("- 10 │ old value");
  expect(stripAnsi(rendered.join("\n"))).toContain("+ 10 │ new value");
  expect(rendered.some((line) => line.includes(BG_START))).toBe(true);
});

it("uses an empty gutter when a long CJK diff row wraps", () => {
  const component = createEditDiffBox(
    "+120 新增内容需要在狭窄终端正确换行",
    theme,
    { outputPad: 0 },
  );
  const rendered = component.render(18).map(stripAnsi);

  expect(rendered[0]).toContain("+ 120 │");
  expect(rendered[1]).toContain("      │");
  expect(rendered.every((line) => visibleWidth(line) <= 18)).toBe(true);
});
```

- [ ] **Step 6: Run component tests and verify RED**

Run:

```bash
rtk npm test -- tests/edit-diff.test.ts
```

Expected: FAIL because `createEditDiffBox` is not implemented.

- [ ] **Step 7: Implement the width-aware Box**

Implementation requirements:

```ts
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

class EditDiffRows implements Component {
  constructor(
    private readonly rows: readonly EditDiffRow[],
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const numberWidth = Math.max(
      1,
      ...this.rows.map((row) => String(row.lineNumber ?? "").length),
    );
    const gutterWidth = 2 + numberWidth + 3; // marker, space, number, " │ "
    const contentWidth = Math.max(1, width - gutterWidth);
    const output: string[] = [];

    for (const row of this.rows) {
      const marker = row.kind === "added"
        ? "+"
        : row.kind === "removed"
          ? "-"
          : " ";
      const number = row.lineNumber === undefined
        ? " ".repeat(numberWidth)
        : String(row.lineNumber).padStart(numberWidth);
      const contentRows = wrapTextWithAnsi(row.content, contentWidth);
      const logicalRows = contentRows.length > 0 ? contentRows : [""];
      const color = row.kind === "added"
        ? "toolDiffAdded"
        : row.kind === "removed"
          ? "toolDiffRemoved"
          : "toolDiffContext";

      logicalRows.forEach((content, index) => {
        const gutter = index === 0
          ? `${marker} ${number} │ `
          : `${" ".repeat(2 + numberWidth)} │ `;
        output.push(this.theme.fg(color, `${gutter}${content}`));
      });
    }
    return output;
  }

  invalidate(): void {}
}
```

Compose it with a real `pi-tui` Box:

```ts
class IndentedComponent implements Component {
  constructor(
    private readonly child: Component,
    private readonly padding: number,
  ) {}

  render(width: number): string[] {
    const prefix = " ".repeat(this.padding);
    return this.child
      .render(Math.max(1, width - this.padding))
      .map((line) => `${prefix}${line}`);
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

export function createEditDiffBox(
  diff: string,
  theme: Theme,
  options: EditDiffBoxOptions,
): Component {
  if (diff.length === 0) return new Container();

  const box = new Box(
    1,
    0,
    (line) => theme.bg("toolSuccessBg", line),
  );
  box.addChild(new EditDiffRows(parseEditDiff(diff), theme));
  return new IndentedComponent(box, options.outputPad);
}
```

`IndentedComponent` keeps the panel aligned with the dynamic Header padding
without coloring the outside margin.

- [ ] **Step 8: Run Edit Box tests and verify GREEN**

Run:

```bash
rtk npm test -- tests/edit-diff.test.ts
rtk npm run check
```

Expected: all Edit Box tests PASS and TypeScript exits 0.

- [ ] **Step 9: Commit the focused pi-core component**

Prerequisite: the existing uncommitted `pi-core` baseline has been intentionally checkpointed.

```bash
rtk git -C agent/extensions/pi-core add \
  src/tui/edit-diff.ts \
  tests/edit-diff.test.ts
rtk git -C agent/extensions/pi-core commit \
  -m "feat: add edit diff box component"
```

---

### Task 2: Add a Component-Level Expanded Result Hook

**Files:**
- Modify: `agent/extensions/pi-core/src/tui/tool-renderer.ts`
- Modify: `agent/extensions/pi-core/tests/tool-renderer.test.ts`
- Modify: `agent/extensions/pi-core/index.ts`

**Interfaces:**
- Consumes: `Component`, `AgentToolResult`, `Theme`, `OutputPad`.
- Produces:

```ts
export type ExpandedResultRenderer = (
  result: AgentToolResult<unknown>,
  args: Record<string, unknown>,
  theme: Theme,
  outputPad: OutputPad,
) => Component;

export interface CodexToolRendererSpec {
  // Existing fields remain unchanged.
  renderExpandedResult?: ExpandedResultRenderer;
}
```

- [ ] **Step 1: Write failing renderer-hook tests**

Add tests for all three branches:

```ts
it("uses a custom component for a successful expanded result", () => {
  const custom = new Text("custom diff", 0, 0);
  const renderExpandedResult = vi.fn(() => custom);
  const rendering = createCodexToolRendering({
    runningVerb: "Editing",
    completedVerb: "Edited",
    argument: () => "file.ts",
    collapsed: summarizeEditDiff,
    renderExpandedResult,
  });

  const result = rendering.renderResult!(
    {
      content: [{ type: "text", text: "Successfully replaced..." }],
      details: { diff: "+1 added" },
    } as any,
    { expanded: true, isPartial: false },
    theme,
    context({}, { args: { path: "file.ts" } }),
  );

  expect(result).toBe(custom);
  expect(renderExpandedResult).toHaveBeenCalledOnce();
});

it("does not call the custom expanded renderer while collapsed", () => {
  const renderExpandedResult = vi.fn(() => new Text("unexpected", 0, 0));
  const rendering = createCodexToolRendering({
    runningVerb: "Editing",
    completedVerb: "Edited",
    argument: () => "file.ts",
    collapsed: summarizeEditDiff,
    renderExpandedResult,
  });

  const result = rendering.renderResult!(
    {
      content: [{ type: "text", text: "Successfully replaced..." }],
      details: { diff: "+1 added" },
    } as any,
    { expanded: false, isPartial: false },
    theme,
    context({}, { args: { path: "file.ts" } }),
  );

  expect(result.render(80)).toEqual([]);
  expect(renderExpandedResult).not.toHaveBeenCalled();
});

it("keeps failed results on the existing error-text path", () => {
  const renderExpandedResult = vi.fn(() => new Text("unexpected", 0, 0));
  const rendering = createCodexToolRendering({
    runningVerb: "Editing",
    completedVerb: "Edited",
    argument: () => "file.ts",
    collapsed: summarizeEditDiff,
    renderExpandedResult,
  });

  const result = rendering.renderResult!(
    {
      content: [{ type: "text", text: "oldText did not match" }],
    } as any,
    { expanded: true, isPartial: false },
    theme,
    context({}, {
      args: { path: "file.ts" },
      isError: true,
    }),
  );

  expect(result.render(80).join("\n")).toContain("oldText did not match");
  expect(renderExpandedResult).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run renderer tests and verify RED**

Run:

```bash
rtk npm test -- tests/tool-renderer.test.ts
```

Expected: FAIL because `renderExpandedResult` is not part of the spec and is never called.

- [ ] **Step 3: Implement the minimal hook**

Insert the hook before generic expanded text rendering:

```ts
if (
  options.expanded &&
  !options.isPartial &&
  !context.isError &&
  spec.renderExpandedResult
) {
  return spec.renderExpandedResult(
    result,
    context.args,
    theme,
    outputPad,
  );
}
```

Keep the existing `expandedOutput` field temporarily so the currently loaded
`pi-permissions` source remains valid between Task 2 and Task 3. Keep generic
`ToolOutputComponent` behavior unchanged for Bash and other tools.

- [ ] **Step 4: Export the new hook and Edit Box factory**

Update `index.ts`:

```ts
export {
  createEditDiffBox,
  parseEditDiff,
  type EditDiffBoxOptions,
  type EditDiffKind,
  type EditDiffRow,
} from "./src/tui/edit-diff.ts";

export {
  type ExpandedResultRenderer,
} from "./src/tui/tool-renderer.ts";
```

- [ ] **Step 5: Run pi-core verification**

Run:

```bash
rtk npm test
rtk npm run check
```

Expected: 4 existing test files plus the new Edit Box suite PASS; TypeScript exits 0.

- [ ] **Step 6: Commit the focused pi-core renderer API**

```bash
rtk git -C agent/extensions/pi-core add \
  src/tui/tool-renderer.ts \
  tests/tool-renderer.test.ts \
  index.ts
rtk git -C agent/extensions/pi-core commit \
  -m "feat: support custom expanded tool components"
```

---

### Task 3: Wire the Sandboxed Edit Tool to the Box

**Files:**
- Modify: `agent/extensions/pi-core/src/tui/tool-renderer.ts`
- Modify: `agent/extensions/pi-core/index.ts`
- Modify: `agent/extensions/pi-permissions/src/register.ts`
- Modify: `agent/extensions/pi-permissions/tests/register.test.ts`

**Interfaces:**
- Consumes: `createEditDiffBox`, `renderExpandedResult`.
- Produces: Edit-only Box rendering through the existing sandboxed `edit` registration.

- [ ] **Step 1: Update the existing integration test first**

Change the current Edit rendering test to use an ANSI-producing foreground and
background theme:

```ts
const BG_START = "\u001b[48;5;22m";
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (text: string): string => text.replace(ANSI, "");
const theme = {
  fg: (color: string, text: string) => {
    if (color === "success" || color === "toolDiffAdded") {
      return `\u001b[32m${text}\u001b[0m`;
    }
    if (color === "error" || color === "toolDiffRemoved") {
      return `\u001b[31m${text}\u001b[0m`;
    }
    return text;
  },
  bg: (_color: string, text: string) =>
    `${BG_START}${text}\u001b[0m`,
  bold: (text: string) => text,
};
```

Then verify:

```ts
const collapsed = tool.renderResult(
  editResult,
  { expanded: false, isPartial: false },
  theme,
  context,
);
const expanded = tool.renderResult(
  editResult,
  { expanded: true, isPartial: false },
  theme,
  context,
);

expect(header.render(100).join("\n")).toContain(
  "\u001b[32m+2\u001b[0m \u001b[31m-1\u001b[0m",
);
expect(collapsed.render(100)).toEqual([]);
expect(stripAnsi(expanded.render(100).join("\n"))).toContain("- 11 │ old value");
expect(stripAnsi(expanded.render(100).join("\n"))).toContain("+ 11 │ new value");
expect(expanded.render(100).some((line) => line.includes(BG_START))).toBe(true);
expect(expanded.render(100).join("\n")).not.toContain("Successfully replaced");
```

- [ ] **Step 2: Run the integration test and verify RED**

Run:

```bash
rtk npm test -- tests/register.test.ts \
  -t "keeps the edit header collapsed and expands the complete line diff"
```

Expected: FAIL because the Edit renderer still returns the generic prefixed output rather than a Box with a structured gutter.

- [ ] **Step 3: Wire only Edit to the custom component**

Replace:

```ts
expandedOutput: renderEditDiff,
```

with:

```ts
renderExpandedResult: (result, _args, theme, outputPad) => {
  const details = result.details as { diff?: unknown } | undefined;
  return createEditDiffBox(
    typeof details?.diff === "string" ? details.diff : "",
    theme,
    { outputPad },
  );
},
```

Keep:

```ts
collapsed: summarizeEditDiff,
formatSummary: colorizeEditDiffSummary,
```

Delete `renderEditDiff` only after `rg` confirms there are no remaining callers.

- [ ] **Step 4: Retire the superseded text-only Edit hook**

After the registration uses `renderExpandedResult`, run:

```bash
rtk rg -n "expandedOutput|renderEditDiff" \
  agent/extensions/pi-core \
  agent/extensions/pi-permissions
```

If the only `expandedOutput` definition is the now-unused generic field and
the only `renderEditDiff` entries are its definition/export/tests, remove:

- `CodexToolRendererSpec.expandedOutput`;
- the `expandedText` selection branch;
- `renderEditDiff`;
- the `renderEditDiff` export.

Restore generic expansion to use the existing transformed text directly:

```ts
if (options.expanded && text.length > 0) {
  return new ToolOutputComponent(
    text,
    true,
    spec.maxOutputRows ?? 5,
    (line) => theme.fg(context.isError ? "error" : "toolOutput", line),
    outputPad,
  );
}
```

- [ ] **Step 5: Run the focused integration test and verify GREEN**

Run:

```bash
rtk npm test -- tests/register.test.ts \
  -t "keeps the edit header collapsed and expands the complete line diff"
rtk npm run check
```

Expected: focused test PASS and TypeScript exits 0.

- [ ] **Step 6: Verify and commit the pi-core cleanup**

Run the first two commands from
`/Users/x1a2h1/.pi/agent/extensions/pi-core`, then run the `git -C` commands
from `/Users/x1a2h1/.pi`:

```bash
rtk npm test
rtk npm run check
rtk git -C agent/extensions/pi-core add \
  src/tui/tool-renderer.ts \
  index.ts
rtk git -C agent/extensions/pi-core commit \
  -m "refactor: retire text-only edit diff rendering"
```

- [ ] **Step 7: Commit only the intended pi-permissions hunks**

The worktree already contains unrelated modifications. Review and stage only the Edit Box hunks after the existing dirty changes have been checkpointed:

```bash
rtk git -C agent/extensions/pi-permissions diff -- \
  src/register.ts \
  tests/register.test.ts
rtk git -C agent/extensions/pi-permissions add \
  src/register.ts \
  tests/register.test.ts
rtk git -C agent/extensions/pi-permissions diff --cached --check
rtk git -C agent/extensions/pi-permissions commit \
  -m "feat: render expanded edits in a diff box"
```

Do not run this commit step while unrelated changes still overlap either file.

---

### Task 4: Full Verification and Interactive Check

**Files:**
- No production files.

**Interfaces:**
- Consumes: completed pi-core and pi-permissions implementation.
- Produces: verification evidence and a short manual TUI checklist.

- [ ] **Step 1: Run complete pi-core checks**

```bash
rtk npm test
rtk npm run check
```

Working directory:

```text
/Users/x1a2h1/.pi/agent/extensions/pi-core
```

Expected: all tests PASS and TypeScript exits 0.

- [ ] **Step 2: Run complete pi-permissions checks**

```bash
rtk npm test
rtk npm run check
```

Working directory:

```text
/Users/x1a2h1/.pi/agent/extensions/pi-permissions
```

The full `filtering-proxy` tests need permission to listen on temporary `127.0.0.1` ports. If a sandboxed run fails with `listen EPERM`, rerun the same command with the required host permission; do not classify that environment error as a product regression.

Expected: 14 test files and 224 or more tests PASS; TypeScript exits 0.

- [ ] **Step 3: Inspect the final diff**

```bash
rtk git -C agent/extensions/pi-core diff --check
rtk git -C agent/extensions/pi-permissions diff --check
rtk git -C agent/extensions/pi-core status --short
rtk git -C agent/extensions/pi-permissions status --short
```

Expected: no whitespace errors; every remaining dirty file is identified as intended or pre-existing.

- [ ] **Step 4: Reload Pi and perform the manual TUI check**

Run `/reload`, then make one successful Edit with:

- at least one removed line;
- at least two added lines;
- a line number of at least three digits;
- one long CJK line that wraps at the current terminal width.

Verify:

```text
Collapsed:
 Edited path/to/file.ts · +2 -1

Expanded with Ctrl+O:
[Box background begins at Output padding]
   99 │ context
- 100 │ removed content
+ 100 │ replacement content
+ 101 │ long CJK content
      │ wrapped continuation
```

Also verify:

- Header remains visible while expanded.
- A second `Ctrl+O` returns to Header-only display.
- There is no `Successfully replaced...` line.
- No blank row appears between Header and Box.
- Bash and Read output remain visually unchanged.

- [ ] **Step 5: Record verification without committing generated or unrelated files**

Report exact test counts, TypeScript results, manual observations, and any limitation. Do not claim syntax highlighting, a four-sided border, scrolling, or zero regressions.

---

## Self-Review

- Spec coverage: Edit-only Box, line numbers, Header retention, colored summary, diff colors, `Ctrl+O`, dynamic Output padding, long-line wrapping, and no syntax highlighting are each covered by a task and a test.
- Scope: no Pi core edits, no highlighter, no dependency changes, no changes to other Tool renderers.
- Data contract: the parser consumes Pi's verified `generateDiffString()` display format and does not invent or recompute line numbers.
- Type consistency: `createEditDiffBox(diff, theme, { outputPad })` is defined in Task 1, exported in Task 2, and consumed with the same signature in Task 3.
- Fallback behavior: successful Edit results with an empty/missing diff return an empty `Container` and keep the Header; failed Edit results remain on the existing error-text path.
- Working-tree safety: commit steps are gated on intentional baseline/checkpoint work because `pi-core` has no initial commit and `pi-permissions` is already dirty.
