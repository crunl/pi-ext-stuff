# pi-core & pi-tool-render — architecture and module map

`pi-core` owns editor chrome (the boxed editor carrying the permissions-mode
badge), the working token-rate indicator, and `/effort` + `/exit` slash commands.
`pi-tool-render` (extracted from `pi-core`) owns Codex-style tool presentation,
`codemode` clickable tree rendering, and output-padding sync.
Pure presentation specs and renderers live in `packages/shared-tool-presentation`
(single source of truth; the former 12 duplicate re-export shims in
`pi-core/src/tui/*` were removed).
Neither extension imports back from `pi-safety`, `statusline`, or each other.

Everything ships as `.ts` sources loaded directly by pi through jiti; there is no
build step.

## Entry points

| Path | Role |
| --- | --- |
| `extensions/pi-core/index.ts` | Package entry named by `package.json` `pi.extensions`. Default-exports `piCore(pi)` which calls `registerExtension(pi)` (`extensions/pi-core/src/register.ts`). |
| `extensions/pi-core/src/register.ts` | Orchestration facade for `registerEditorChrome`, `registerEffortCommand`, `registerExitCommand`, and `registerWorkingTokenRate`. |
| `extensions/pi-core/src/tui/*` | 8 modules for editor box/badge chrome, `/effort`, `/exit`, and working token rate. |
| `extensions/pi-tool-render/index.ts` | Package entry for tool presentation. Default-exports `piToolRender(pi)` which calls `registerExtension(pi)` (`extensions/pi-tool-render/src/register.ts`). |
| `extensions/pi-tool-render/src/register.ts` | Orchestration facade for `registerOutputPaddingSync`, `registerCodexToolRendering`, `registerCodemodeTreeTool`, and `registerCanonicalBuiltinFallback`. |
| `extensions/pi-tool-render/standalone.ts` | Side-effect-free cross-extension surface re-exporting `packages/shared-tool-presentation` and `markToolCall`. |
| `extensions/pi-tool-render/src/*` | 7 modules for read-only tool registration, canonical fallback, `codemode` contract/tree/registration, and `markToolCall`. |
| `packages/shared-tool-presentation/src/*` | Canonical single source of truth for pure Codex tool specs, renderers, diff/evidence modules, badge, and output-padding controller. |

### Registration order

In `extensions/pi-tool-render/src/register.ts`:

```text
registerOutputPaddingSync        packages/shared-tool-presentation/src/output-padding.ts:137
registerCodexToolRendering       extensions/pi-tool-render/src/built-in-tools.ts:35
registerCodemodeTreeTool         extensions/pi-tool-render/src/codemode-tool.ts:54
registerCanonicalBuiltinFallback extensions/pi-tool-render/src/canonical-tool-fallback.ts:51
```

Order is load-bearing in two places:

- `registerOutputPaddingSync` must precede `registerCodexToolRendering`, because
  `createCodexToolRendering` reads the shared padding controller on every render
  (`packages/shared-tool-presentation/src/tool-renderer.ts:349`, `:351`).
- `registerCanonicalBuiltinFallback` must follow the read-only registration so its
  `session_start` snapshot sees all effective tool owners before it registers
  anything (`extensions/pi-tool-render/src/canonical-tool-fallback.ts:71-75`).

In `extensions/pi-core/src/register.ts`:

```text
registerEditorChrome             extensions/pi-core/src/tui/editor-chrome.ts:171
registerEffortCommand            extensions/pi-core/src/tui/effort-command.ts:28
registerExitCommand              extensions/pi-core/src/tui/exit-command.ts:4
registerWorkingTokenRate         extensions/pi-core/src/tui/working-token-rate.ts:52
```

Everything goes through public Pi API surface only — tool/command registration,
`setWidget`/`setWorkingMessage`, settings watching, and
`ctx.ui.setEditorComponent`.

## Cross-extension surface

### `packages/shared-tool-presentation` and `pi-tool-render/standalone.ts`

`packages/shared-tool-presentation` is the single source of truth for pure
presentation primitives (`withCodexToolPresentation`, `codex*ToolSpec`,
`createCodexToolRendering`, `createEditDiffBox`, `badge.ts`,
`permissions-mode.ts`, `output-padding.ts`, `ui-guard.ts`, etc.).

| Consumer | Actual import |
| --- | --- |
| `pi-tool-render` | Imports `withCodexToolPresentation`, `registerOutputPaddingSync`, and `isInteractiveTui` from `../../../packages/shared-tool-presentation/src/*`. |
| `pi-core` | Imports `makeModeBadgeDecorator`, `BADGE_CAP_WIDTH`, `PermissionsModeState`, `isPermissionsModeEvent`, and `isInteractiveTui` from `../../../../packages/shared-tool-presentation/src/*`. |
| `pi-safety` | `extensions/pi-safety/src/register.ts:27` imports `codexBashToolSpec`, `codexEditToolSpec`, `codexWriteToolSpec`, `createCodexToolRendering` from `../../../packages/shared-tool-presentation/src/index.ts`. |
| `statusline` | `extensions/statusline/src/palette.ts:23` and `extensions/statusline/src/status-mode.ts:1` import from `../../../packages/shared-tool-presentation/src/badge.ts`. |

`extensions/pi-tool-render/standalone.ts` re-exports the shared presentation
surface plus `markToolCall` (`extensions/pi-tool-render/src/tool-call-mark.ts`).

### Cross-jiti singletons

Pi loads each extension with its own jiti instance and `moduleCache: false`, so a
module-level `let` is **not** shared across extensions. `output-padding.ts` uses
`Symbol.for("@x1a2h1/pi-core:output-padding-controller")` on `globalThis` so
`pi-tool-render` and `pi-safety` observe the same `OutputPaddingController`
instance.

## Tool rendering pipeline (`pi-tool-render` + `shared-tool-presentation`)

A tool call becomes a rendered row in four stages:

1. **Registration (`extensions/pi-tool-render/src/`).** Tool registration is
   first-wins:
   - `read` / `grep` / `find` / `ls` are built from pi's public factories and
     decorated in `built-in-tools.ts`.
   - `bash` / `write` / `edit` are handled by `canonical-tool-fallback.ts` only
     when Pi's canonical definition is still the effective owner on
     `session_start` in interactive TUI and `--core-builtin-presentation` is
     `auto`.
   - When `pi-safety` is installed it registers `bash` / `write` / `edit` first
     with its permission-gated definitions and applies the same decorator.
2. **Decoration (`packages/shared-tool-presentation/src/codex-tool-presentation.ts`).**
   `withCodexToolPresentation` looks up the tool name in the 7-entry spec map and
   merges `createCodexToolRendering(spec)`.
3. **Spec (`packages/shared-tool-presentation/src/codex-tool-specs.ts`).**
   Defines icon, running/completed/failed verbs, argument formatter, collapsed
   summary, and expanded evidence builder (`read-evidence.ts`, `bash-evidence.ts`,
   `write-preview.ts`, `edit-diff.ts`).
4. **Render (`packages/shared-tool-presentation/src/tool-renderer.ts`).**
   `createCodexToolRendering` returns `{ renderShell: "self", renderCall, renderResult }`
   backed by `tool-output.ts` and live `outputPaddingController` tracking.

## Codemode (`extensions/pi-tool-render/src/`)

Three modules in `extensions/pi-tool-render/src/`:

- **`codemode-contract.ts`** is the payload mapping seam. `toTreeView` maps an
  unknown payload to a stable `TreeView` fail-soft.
- **`codemode-tree.ts`** is UI only. `createCodemodeTreeRendering` renders a
  single `└ Execute` glance line when collapsed and a clickable section tree
  when expanded.
- **`codemode-tool.ts`** shadow-registers `codemode` by running Pi's public
  `createCodemodeExtension` factory against a `Proxy` that captures the tool
  definition and splices in tree renderers while keeping `execute` and
  `prepareLoadout` verbatim.

## Editor and input surface (`extensions/pi-core/src/tui/`)

- **`editor-chrome.ts`** (`ModeBadgeEditor`, `chromeEditorLines`,
  `registerEditorChrome`) + **`border-labels.ts`** + **`box-editor.ts`**: wraps
  the editor in a rounded box and splices the `pi-safety:mode` badge into the
  top border via `ctx.ui.setEditorComponent`, and bypasses `shift+tab` extension
  shortcuts while autocomplete is open.
- **`effort-command.ts`** (`/effort`) and **`exit-command.ts`** (`/exit`).
- **`token-rate.ts`** + **`working-token-rate.ts`**: tracks streaming decode
  throughput and the request's time-to-first-token, and updates
  `ctx.ui.setWorkingMessage` (`Working  50 tok/s · TTFT 1.2s`). TTFT is measured
  from pi's own `AssistantMessage.timestamp` (the request start) to the first
  content token, captured once per `message_start` and frozen for that message;
  it is shown on the first token even when the decode is too short for an
  honest rate (`Working TTFT 0.9s`), and a segment that begins anywhere else
  (tool phase, mid-turn model switch) reports a rate but no TTFT rather than a
  borrowed one.

## Testing

- `packages/shared-tool-presentation/tests/*.test.ts` (16 files, 169 tests):
  covers all pure specs, renderers, diff/evidence builders, badge, permissions
  mode, output padding, step-group summary/layout, and `ui-guard`.
- `extensions/pi-tool-render/tests/*.test.ts` (9 files, 55 tests): covers
  `built-in-tools`, `canonical-tool-fallback`, `codemode-contract`,
  `codemode-tree`, `pi-api-compat`, `register`, `review-icon-e2e`,
  `step-group-fold`, and `tool-call-mark`.
- `extensions/pi-core/tests/*.test.ts` (7 files, 76 tests): covers `box-editor`,
  `editor-chrome`, `effort-command`, `exit-command`, `register`, `token-rate`
  (rate math, decode-throughput alignment, TTFT, stream health), and
  `working-token-rate` (working-line formatting and lifecycle).

## Where to change what

| You want to… | Start at |
| --- | --- |
| Change a tool's header copy, icon, or verbs | `packages/shared-tool-presentation/src/codex-tool-specs.ts` |
| Change how any tool row is composed | `packages/shared-tool-presentation/src/tool-renderer.ts` |
| Change expanded output shape or preview rows | `packages/shared-tool-presentation/src/tool-output.ts` |
| Add a tool to the Codex presentation | `packages/shared-tool-presentation/src/codex-tool-specs.ts` and `codex-tool-presentation.ts` |
| Change built-in tool registration, canonical fallback, or codemode tree | `extensions/pi-tool-render/src/` |
| Change editor chrome or the mode badge | `extensions/pi-core/src/tui/editor-chrome.ts`, `border-labels.ts`, `box-editor.ts` |
| Change the token rate math or footer working message | `extensions/pi-core/src/tui/token-rate.ts` and `working-token-rate.ts` |
