# pi-core architecture

Navigation map for contributors. Keep this file in sync when the module
layout or cross-extension contract changes.

## Entry points

| File | Role |
| --- | --- |
| `index.ts` | Package entry (`package.json` `pi.extensions`). Loads the register graph. |
| `standalone.ts` | **Side-effect-free** cross-extension surface. Other extensions (pi-safety, statusline) must import from here — never from `src/**` deep paths and never from `index.ts` (that pulls the register graph into their jiti instance and can double-register). |
| `src/register.ts` | Pure orchestration facade: calls every `register*` once, in order. |
| `src/tui/*` | All rendering and UI state. Modules are named by concern; pure factories use `create*`, host patches use `apply*`/`install*`, extension hooks use `register*`. |

## Who registers what (tool registration is first-wins)

| Tool | Registered by | Why |
| --- | --- | --- |
| read / grep / find / ls | pi-core `src/tui/built-in-tools.ts` (`registerCodexToolRendering`) | Wraps the built-in tools with Codex-style rendering. |
| bash / write / edit (canonical builtin owner) | pi-core `src/tui/canonical-tool-fallback.ts` (`registerCanonicalBuiltinFallback`) | In interactive TUI only, when the complete public metadata and synthetic builtin source match Pi's canonical definitions. The `core-builtin-presentation` flag supports `auto` (default) or `off`. |
| bash / write / edit (extension owner) | pi-safety | Permission extensions retain execution ownership and may apply pi-core's side-effect-free presentation decorator. First registration per name remains authoritative. |

## standalone.ts surface

Exports (no side effects on import):

- `applyAutocompleteAbove` — statusline
- `withCodexToolPresentation` — pi-safety; decorates a complete tool definition while preserving its execution and metadata
- `createEditDiffBox` — pi-safety
- `createCodexToolRendering` — pi-safety
- `codexBashToolSpec` / `codexEditToolSpec` / `codexWriteToolSpec` and `colorizeEditDiffSummary` / `compactBashStatusSpacing` / `summarizeEditDiff` — pi-safety migration compatibility; marked `@deprecated` in `standalone.ts`, prefer `withCodexToolPresentation` for new code

Adding an export here is the only supported way to widen the contract.

## TUI module map

- `codex-tool-presentation.ts` — side-effect-free decorator seam. It maps the
  complete seven-tool definition to an internal spec and replaces only
  `renderShell`/`renderCall`/`renderResult`; unsupported names fail fast.
- `built-in-tools.ts` — registers Codex rendering on read/grep/find/ls.
  Presentation only: since Pi 0.85.0 the factories' execute() honors
  `ctx.cwd` natively, so the definitions register as-is through one shared
  helper. The four call sites cannot be table-driven: `registerTool` infers
  the schema from the spread argument, so each tool needs its own call site.
- `canonical-tool-fallback.ts` — TUI-only adapter for canonical bash/write/edit.
  It snapshots `getAllTools()` before registering anything, skips extension/SDK
  owners, reconstructs definitions with Pi's public factories, and never calls
  `setActiveTools`. Validation pin 0.86.0 still cannot expose the actual definition or host
  `SettingsManager` through the extension context, so an SDK
  `baseToolsOverride`, custom/non-file-backed shell settings, and a later
  dynamic same-name registration cannot be distinguished safely. Those SDK
  configurations should use the `off` flag; these remain documented
  compatibility boundaries rather than private-registry patch points.
- Validation pin 0.86.0 still has no public renderer-only registration API: execution and
  rendering are combined in `ToolDefinition`. If a future Pi release exposes
  an API such as `registerToolRenderer(name, renderer)`, replace this Adapter
  with that host integration while keeping `withCodexToolPresentation` as the
  compatibility Seam for permission-owned definitions.
- `codex-tool-specs.ts` — 7 tool render specs (icon, verbs, collapsed summary)
  plus the per-tool summary helpers (bash status spacing compaction, edit-diff
  count/colorize, write line-count colorize). **Bash glance header (design B)**:
  `singleLineHeader`, command first line capped at `BASH_GLANCE_BUDGET` + `…`,
  dim `· N output lines` / `· no output` on the same row, host-driven
  `▶`/`▼` expand chevron (`showExpandIndicator`, **bash only**). Failed bash uses the default verb `Failed`.
  Settled success + collapsed = header-only body; failed collapsed shows the last output line.
  **Read**: header `path[:range] · N lines` (no expand chevron); expand only shows
  file evidence via `read-evidence.ts` (never bash `└` stdout rail).
- `bash-evidence.ts` — `commandGlance` + expanded bash evidence
  (`$ ` full command under `  │ `, then full output). Imports command caps from
  `shell-command-highlight.ts`, not from reserved wrap header.
- `read-evidence.ts` — expanded file evidence: absolute line numbers + dim
  `│` gutter + `getLanguageFromPath`/`highlightCode`; caps
  `READ_EVIDENCE_MAX_LINES`/`CHARS`; no wrap (1 line number ↔ 1 logical line).
- `shell-command-highlight.ts` — command-position shell highlight +
  `MAX_COMMAND_CHARS`.
- `bash-command-header.ts` — **reserved** Codex ExecCell wrap layout
  (`headerLayout: "wrap-command"`). No production spec uses it; renderer still
  routes the layout for tests/opt-in.
- `tool-output.ts` — collapsed preview builders, `countMeaningfulBashLines` /
  `isNoOutputPlaceholder` (Pi `(no output)` single source).
- `tool-renderer.ts` — generic `createCodexToolRendering(spec)` with lifecycle
  colors and renderer-owned shared state. Default header path is
  `singleLineHeader`/`single`; optional `headerLayout: "wrap-command"` routes
  through reserved `WrappedCommandHeader`. Peer extensions may stamp a permanent
  leading glyph badge via `context.state.leadingIconOverride` (plain string).
  When set, the icon color is pinned to warning; verb still follows status.
  Codex-header tools (bash/write/edit) use this slot; tools without a Codex
  header (e.g. request_permissions) keep the overlay status row.
- `output-padding.ts` — watches effective settings only in TUI mode. Shared
  through `globalThis`/`Symbol.for` so renderers imported by pi-safety
  through a separate jiti instance see the same value. **Internal only** (not
  exported from `standalone.ts`); statusline reads `settings.outputPad` itself.
- `write-preview.ts` — streaming write preview; `edit-diff.ts` — diff box.
- `thinking-glance.ts` / `thinking-timing.ts` — patch
  `AssistantMessageComponent.updateContent` so hidden thinking runs show
  MiniMax-style glance (`└ Thought for 1.4s` / `└ Thinking…`, **no `▶`**).
  Duration is a memory side-channel from `thinking_start`/`thinking_delta`;
  resume degrades to `Thought`. Expand remains host-owned (click / ctrl+t).
  Not exported from `standalone.ts`.
- Floating overlay chain (call order): `autocomplete-above.ts` installs the
  autocomplete provider and the editor float panel
  (`editor-float-panel.ts`); `selector-float.ts` marks floatable selectors and
  `selector-tab-nav.ts` anchors Shift+Tab navigation into them. Placement uses
  public `TUI.mode`, `children`, `showOverlay`, and the regular renderer's
  `captureRenderState()`; fullscreen autocomplete uses the bottom dock while
  fullscreen selectors retain Pi's native inline layout. The active panel and
  selector anchor use shared symbols so statusline's isolated jiti copy can
  replace the editor without leaking an overlay.
- `token-rate.ts` (pure tracker) / `working-token-rate.ts` (indicator adapter):
  the rate is shown as part of the footer working line
  (`setWorkingMessage`, `⠋ Working  50 tok/s`), cleared at `agent_end`; while
  blocked on a `ctx.ui` prompt (`ui_prompt_start/end`) it shows `Waiting for
  input` instead of a frozen rate, then restores. It does
  not overwrite spinner frames potentially owned by another extension. The
  legacy `setWidget("pi-core:working-token-rate")` above the editor is only
  cleared, never populated.
- `ui-guard.ts` — shared `isInteractiveTui()` guard for terminal-only hooks;
  `hasUI` alone is insufficient because it is also true in RPC mode.
- `effort-command.ts`, `exit-command.ts`, `output-padding.ts`, `markdown-code-frame.ts`, `user-message-bar.ts` — smaller,
  single-purpose patches (effort/exit register slash commands `/effort` and `/exit` (alias for `/quit`);
  `/effort` hosts pi's own `ThinkingSelectorComponent` with pi-ai level filtering, so no local copy can drift). (`startup-header.ts` was removed — it rendered a
  logo via the external `chafa` binary.) Pi 0.85's
  `registerMarkdownTransformer()` can rewrite source text but cannot replace a
  themed token renderer, so framed code blocks remain a guarded prototype seam.
  `user-message-bar.ts` likewise patches `UserMessageComponent.prototype.render`:
  it unwraps the Box, prefixes a 1-column `borderAccent` bar, re-applies
  `userMessageBg` to the content columns, and restores one blank banded row
  above and below (min 3 rows for a 1-line message). Content starts at column
  1, which matches assistant text at the default `outputPad=1`; `outputPad=0`
  shifts user content one column right.

## Testing

Flat `tests/*.test.ts` mirror `src/tui/*` by basename. Every module with
logic has a direct test; the only exception is the trivial `frame.ts`
geometry helper, covered through the overlay and markdown renderer tests.
`pi-api-compat.test.ts` intentionally pins the remaining private runtime seams:
the Editor autocomplete fields and `getPaddingX` used for above-editor
placement, Markdown's code-token renderer/theme used for framed code blocks,
the settings-selector constructor identity used by the selector allowlist,
the `SettingsManager.create` shape used by the canonical bash fallback, and
the `<builtin:name>` source marker format emitted by the host.
