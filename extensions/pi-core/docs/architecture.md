# pi-core architecture

Navigation map for contributors. Keep this file in sync when the module
layout or cross-extension contract changes.

## Entry points

| File | Role |
|---|---|
| `index.ts` | Package entry (`package.json` `pi.extensions`). Loads the register graph. |
| `standalone.ts` | **Side-effect-free** cross-extension surface. Other extensions (pi-permissions, statusline) must import from here — never from `src/**` deep paths and never from `index.ts` (that pulls the register graph into their jiti instance and can double-register). |
| `src/register.ts` | Pure orchestration facade: calls every `register*` once, in order. |
| `src/tools/index.ts` | `registerBuiltInTools`: activates the built-in read-only tools (grep/find/ls) at session start. |
| `src/tui/*` | All rendering and UI state. Modules are named by concern; pure factories use `create*`, host patches use `apply*`/`install*`, extension hooks use `register*`. |

## Who registers what (tool registration is first-wins)

| Tool | Registered by | Why |
|---|---|---|
| read / grep / find / ls | pi-core `src/tui/built-in-tools.ts` (`registerCodexToolRendering`) | Wraps the built-in tools with Codex-style rendering. `write`/`edit`/`bash` are intentionally absent: pi-permissions registers them because their `execute` needs the permission gate; their rendering specs are applied there from pi-core's `standalone` exports. |

## standalone.ts surface

Exports (no side effects on import):

- `applyAutocompleteAbove` — statusline
- `codexBashToolSpec` / `codexEditToolSpec` / `codexWriteToolSpec` — pi-permissions
- `createEditDiffBox` — pi-permissions
- `colorizeEditDiffSummary` / `compactBashStatusSpacing` / `createCodexToolRendering` / `summarizeEditDiff` — pi-permissions
- widget key constant `TOKEN_RATE_WIDGET_KEY` (via `src/tui/working-token-rate.ts`)

Adding an export here is the only supported way to widen the contract.

## TUI module map

- `built-in-tools.ts` — registers Codex rendering on read/grep/find/ls. The four
  per-tool blocks cannot be table-driven: `registerTool` infers the schema from
  the spread argument, so each tool needs its own call site.
- `codex-tool-specs.ts` — 7 tool render specs (icon, verbs, collapsed summary).
- `tool-renderer.ts` — generic `createCodexToolRendering(spec)`.
- `write-preview.ts` — streaming write preview; `edit-diff.ts` — diff box.
- Floating overlay chain (call order): `autocomplete-above.ts` installs the
  autocomplete provider and the editor float panel
  (`editor-float-panel.ts`); `selector-float.ts` marks floatable selectors and
  `selector-tab-nav.ts` anchors Shift+Tab navigation into them.
- `token-rate.ts` (pure tracker) / `working-token-rate.ts` (widget adapter):
  the widget is `setWidget("pi-core:working-token-rate")`, shown while working,
  cleared at `agent_end`.
- `ui-guard.ts` — `isInteractiveTui()` shared by three modules.
- `startup-header.ts`, `effort-command.ts`, `output-padding.ts`,
  `markdown-code-frame.ts` — smaller, single-purpose patches.

## Testing

Flat `tests/*.test.ts` mirror `src/tui/*` by basename. Pure modules
(`token-rate`, `tool-renderer`, `edit-diff`) are tested directly; host-patch
modules (`built-in-tools`, `write-preview`, `ui-guard`, `tools/index`) are
covered indirectly via the renderer tests and `register.test.ts`.
