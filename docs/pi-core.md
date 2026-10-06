# pi-core — architecture and module map

`pi-core` is the presentation layer of this monorepo. It owns TUI rendering,
Codex-style tool presentation, floating overlays, the working token-rate widget,
and the text/chrome around the editor. It imports nothing back from the other
extensions (`extensions/pi-core/../pi-safety`, `../statusline`,
`../tool-result-budget` do not appear in its import graph).

Everything ships as `.ts` sources loaded directly by pi through jiti; there is no
build step (`extensions/pi-core/AGENTS.md:16-17`).

## Entry points

| Path | Role |
| --- | --- |
| `extensions/pi-core/index.ts` | Package entry named by `package.json` `pi.extensions` (`extensions/pi-core/package.json:20-24`). Default-exports `piCore(pi)` which calls `registerExtension(pi)` (`extensions/pi-core/index.ts:13-15`). |
| `extensions/pi-core/src/register.ts` | Orchestration facade. Calls every `register*` / `apply*` once, in a fixed order (`extensions/pi-core/src/register.ts:15-28`). |
| `extensions/pi-core/standalone.ts` | Side-effect-free cross-extension surface (see below). |
| `extensions/pi-core/src/tui/*` | 36 modules, 5,086 lines. Almost all real logic lives here. |

`index.ts` also re-exports `standalone.ts` so older `../../pi-core/index.ts`
imports keep working, but the comment there is explicit that new consumers should
import `standalone.ts` directly to avoid pulling the register graph into their own
jiti instance (`extensions/pi-core/index.ts:4-12`).

### Registration order

```text
registerOutputPaddingSync        extensions/pi-core/src/tui/output-padding.ts:137
registerCodexToolRendering       extensions/pi-core/src/tui/built-in-tools.ts:35
registerCodemodeTreeTool         extensions/pi-core/src/tui/codemode-tool.ts:54
registerCanonicalBuiltinFallback extensions/pi-core/src/tui/canonical-tool-fallback.ts:51
registerEditorChrome             extensions/pi-core/src/tui/editor-chrome.ts:28
registerSelectorTabNav           extensions/pi-core/src/tui/selector-tab-nav.ts:104
registerEffortCommand            extensions/pi-core/src/tui/effort-command.ts:30
registerExitCommand              extensions/pi-core/src/tui/exit-command.ts:4
registerWorkingTokenRate         extensions/pi-core/src/tui/working-token-rate.ts:41
registerThinkingGlance           extensions/pi-core/src/tui/thinking-glance.ts:253
applyMarkdownCodeFrame           extensions/pi-core/src/tui/markdown-code-frame.ts:63
registerUserMessageBar           extensions/pi-core/src/tui/user-message-bar.ts:152
```

Order is load-bearing in two places:

- `registerOutputPaddingSync` must precede `registerCodexToolRendering`, because
  `createCodexToolRendering` reads the shared padding controller on every render
  (`extensions/pi-core/src/tui/tool-renderer.ts:343`, `:351`).
- `registerCanonicalBuiltinFallback` must follow the read-only registration so its
  `session_start` snapshot sees all effective tool owners before it registers
  anything (`extensions/pi-core/src/tui/canonical-tool-fallback.ts:71-75`).

`registerThinkingGlance` and `applyMarkdownCodeFrame` are both prototype patches
and must run after the host classes exist; they are not ordered against each other.

## Module naming convention

`extensions/pi-core/AGENTS.md:30-34` states: `create*` = pure factories,
`apply*` / `install*` = host patches, `register*` = extension hooks. The convention
holds for the lifecycle-bearing modules, with these real deviations:

- `applyMarkdownCodeFrame()` is an `apply*` host patch with no `pi` argument; it
  patches `Markdown.prototype` directly and is invoked as a bare call from
  `register.ts:26`.
- `applyThinkingGlance(tracker)` (`thinking-glance.ts:115`) and
  `applyUserMessageBar(getTheme)` (`user-message-bar.ts:60`) are `apply*` patches
  that are *also* driven by a `register*` hook in the same module
  (`thinking-glance.ts:253`, `user-message-bar.ts:152`). The `apply*` half is
  separable so tests and `pi-api-compat.test.ts` can install and reset the patch in
  isolation (`resetThinkingGlance` `thinking-glance.ts:243`,
  `resetUserMessageBar` `user-message-bar.ts:142`).
- Most pure helpers are *not* named `create*`: `buildTopBorder`
  (`border-labels.ts:34`), `frameLines` (`frame.ts:32`), `boxEditorLines`
  (`box-editor.ts:40`), `parseEditDiff` (`edit-diff.ts:22`), `toTreeView`
  (`codemode-contract.ts:258`), `toolResultText` (`tool-output.ts:16`),
  `estimateTokensFromChars` (`token-rate.ts:73`), `streamHealth`
  (`token-rate.ts:104`), `highlightShellCommandLines`
  (`shell-command-highlight.ts:50`), and the `summarize*` / `colorize*` family in
  `codex-tool-specs.ts:21-71`. Read the convention as a naming preference for the
  three lifecycle roles, not as a rule over every export.
- `updateWriteHighlightCache` (`write-preview.ts:74`) mutates its cache argument
  in place and has no prefix at all. `markFloatableSelector`
  (`selector-float.ts:49`) and `markToolCall` (`tool-call-mark.ts:16`) mutate/act
  but use `mark*`.
- Reset helpers are `reset*` (`markdown-code-frame.ts:88`, `thinking-glance.ts:243`,
  `user-message-bar.ts:142`) — test/hot-reload escape hatches, not host patches.

## Cross-extension surface

### The declared contract: `standalone.ts`

`standalone.ts` is documented as the only supported widening point
(`extensions/pi-core/AGENTS.md:46-59`). It exports 11 names
(`extensions/pi-core/standalone.ts:15-27`):

- Re-exported from `packages/shared-tool-presentation/src/index.ts`:
  `codexBashToolSpec`, `codexEditToolSpec`, `codexWriteToolSpec`,
  `colorizeEditDiffSummary`, `compactBashStatusSpacing`,
  `createCodexToolRendering`, `createEditDiffBox`, `summarizeEditDiff`,
  `withCodexToolPresentation`.
- Local: `applyAutocompleteAbove` (`src/tui/autocomplete-above.ts:64`),
  `markToolCall` + `type ToolCallMark` (`src/tui/tool-call-mark.ts:16`).

The contract, restated from its own header (`standalone.ts:10-12`): importing the
module and everything it re-exports runs no host patching; patching happens only
when a `register*` / `apply*` / `install*` function is explicitly called.

Caveat worth knowing before you trust "side-effect-free" literally: importing
`standalone.ts` transitively imports `output-padding.ts`, whose module body
allocates the cross-jiti controller singleton and writes it to `globalThis`
(`output-padding.ts:131`, `:135`). A jiti probe confirms the symbol
`@x1a2h1/pi-core:output-padding-controller` appears on `globalThis` after importing
either the package index or `standalone.ts`, and does not appear before. No host
API is patched and no `pi.*` call is made, so the contract's intent holds, but the
import is not observationally inert.

### Who actually imports what (verified)

The declared consumers and the real import graph differ today. Grepping every
`.ts` in `extensions/` and `packages/` for a specifier containing `pi-core`
returns zero import statements. The real edges are:

| Consumer | Actual import |
| --- | --- |
| `pi-safety` | `extensions/pi-safety/src/register.ts:27` imports `codexBashToolSpec`, `codexEditToolSpec`, `codexWriteToolSpec`, `createCodexToolRendering as createPiCoreCodexToolRendering` from `../../../packages/shared-tool-presentation/src/index.ts`. |
| `statusline` | `extensions/statusline/src/palette.ts:21` and `extensions/statusline/src/status-mode.ts:1` import from `../../../packages/shared-tool-presentation/src/badge.ts`. |
| `tool-result-budget` | No cross-package imports; Node builtins and the extension API only (`extensions/tool-result-budget/index.ts:23-25`). |

`extensions/pi-safety/tests/structure-invariants.test.ts` pins both facts: the
host-package edges test asserts `sharedPresentation` has exactly
`["src/register.ts"]`, and a named invariant elsewhere asserts that `statusline`
contains zero static references to `pi-core`.

So: the contract that `standalone.ts` is the widening point is real and documented,
but the two in-repo consumers currently reach the same implementations through
`packages/shared-tool-presentation` deep paths instead. If you add a cross-extension
component, follow `AGENTS.md:92-93` and export it from `standalone.ts`; be aware that
doing so does not by itself make the other extensions pick it up.

`markToolCall` (`tool-call-mark.ts:16`) has no in-repo consumer today. `pi-safety`
implements its review badge by writing `context.state.leadingIconOverride` instead
(`extensions/pi-safety/src/review-renderer.ts:226-227`), which the renderer and the
codemode tree both honor (`tool-renderer.ts:228`, `codemode-tree.ts:67`).
The `AGENTS.md:55` row listing pi-safety as the `markToolCall` consumer is stale.

### `packages/shared-tool-presentation`

This workspace package (`packages/shared-tool-presentation/package.json`) is where
the presentation primitives live. 12 of its 15 `src/` modules are **byte-identical**
to the same-named module under `extensions/pi-core/src/tui/`
(`bash-command-header`, `bash-evidence`, `codex-tool-presentation`,
`codex-tool-specs`, `edit-diff`, `output-padding`, `read-evidence`,
`shell-command-highlight`, `tool-output`, `tool-renderer`, `ui-guard`,
`write-preview` — verified with `diff -q`). The package adds
`badge.ts`, `permissions-mode.ts`, and `index.ts`, which pi-core imports back via
relative deep paths:

- `extensions/pi-core/src/tui/model-editor.ts:26` → `badge.ts` (`makeModeBadgeDecorator`)
- `extensions/pi-core/src/tui/border-labels.ts:7` → `badge.ts` (`BADGE_CAP_WIDTH`)
- `extensions/pi-core/src/tui/editor-chrome.ts:18` → `permissions-mode.ts`
- `extensions/pi-core/standalone.ts:25` → the package index

Consequence for maintainers: a change to any of the 12 duplicated modules has to be
applied twice, in `extensions/pi-core/src/tui/<name>.ts` **and**
`packages/shared-tool-presentation/src/<name>.ts`. Nothing in the repo enforces that
sync; there is no sync script or equality test. The only guardrail is
`extensions/pi-safety/scripts/preflight-sibling.mjs`, which fails closed when the
shared package is missing or its subtree is dirty.

`packages/shared-tool-presentation` pins `@earendil-works/*` to `0.86.0` while
`pi-core` pins `1.0.0` (`packages/shared-tool-presentation/package.json:16-19`,
`extensions/pi-core/package.json:48-56`). Test suites in the two trees therefore run
against different host versions.

### Cross-jiti singletons

Pi loads each extension with its own jiti instance and `moduleCache: false`, so a
module-level `let` is **not** shared between pi-core and a consumer that imports a
copy. pi-core uses `Symbol.for(...)` keys on `globalThis` to bridge that gap. All
three are load-bearing:

| Symbol | Declared at | Why |
| --- | --- | --- |
| `@x1a2h1/pi-core:output-padding-controller` | `output-padding.ts:124` | Both the `standalone.ts` copy and pi-core's register graph must observe one controller, or the pad value diverges (comment `output-padding.ts:120-123`). |
| `@x1a2h1/pi-core:autocomplete-active-panel` | `autocomplete-above.ts:44` | A later extension replacing pi-core's editor must still be able to dispose the previous hidden overlay (`autocomplete-above.ts:39-43`). |
| `@x1a2h1/pi-core:selector-tab-nav-anchor` | `selector-tab-nav.ts:43` | Without it, the raw-input listener sees an empty anchor, `isSelectorOpen()` sticks true, and shift+tab is always rewritten to ↑ — which kills pi-safety mode cycling (`selector-tab-nav.ts:30-42`). |

`selector-tab-nav.ts:43` documents the rule the others follow: last writer wins;
whoever last called `applyAutocompleteAbove` holds the mounted editor.

## Tool rendering pipeline

A tool call becomes a rendered row in four stages.

**1. Registration — which definition owns the name.** Tool registration is
first-wins.

- `read` / `grep` / `find` / `ls` are built from pi's public factories and
  decorated: `registerCodexToolRendering` (`built-in-tools.ts:35`) calls
  `registerPresented` for each of the four (`:38-41`). They register the factory
  output as-is; since Pi 0.85.0 the factories resolve paths against `ctx.cwd`
  natively, so the old per-call rebuilds are gone (comment `built-in-tools.ts:19-21`).
  Each tool needs its own call site because `registerTool` infers the schema from
  the spread argument (`built-in-tools.ts:23-26`).
- `bash` / `write` / `edit` are handled by `canonical-tool-fallback.ts` **only when
  Pi's canonical definition is still the effective owner**. On `session_start` it
  bails unless `isInteractiveTui(ctx)` (`canonical-tool-fallback.ts:64`), reads the
  `core-builtin-presentation` flag (`:16`, `:55-59`, `:66`), snapshots every owner
  before registering anything (`:71-75`), and for each canonical name checks
  `isCanonicalBuiltin` — `sourceInfo.source === "builtin"` and path `builtin:<name>`
  or `<builtin:<name>>` (`:185-190`). It re-derives the definition and registers
  only if `matchesCanonicalMetadata` deep-compares name, description, parameters,
  and promptGuidelines (`:192-199`). Mismatch warns once and skips (`:171-179`).
  `bash` additionally needs the host `SettingsManager`, recreated via
  `SettingsManager.create` (`:135-137`) because `ExtensionContext` does not expose
  it; if settings cannot be loaded, bash is skipped with a warning (`:152-160`).
  This is the seam SDK hosts must disable with `core-builtin-presentation=off`
  (`extensions/pi-core/README.md:61-63`).
- When `pi-safety` is installed it registers `bash` / `write` / `edit` first with
  its own permission-gated definitions and applies the same decorator, so the
  canonical fallback finds a non-canonical owner and stays out of the way.

**2. Decoration — `withCodexToolPresentation`.** `codex-tool-presentation.ts:38`
looks the tool name up in a private 7-entry spec map (`:20-28`), throws if absent
(`:41-43`), and returns `{ ...definition, ...createCodexToolRendering(spec) }`
(`:47-51`). Only the three renderer fields change; execution, schema, prompt
metadata, and policy stay with the original definition (comment `:31-37`). Keeping
it a pure decorator is deliberate: a permission extension builds its secure
definition first and adds presentation last.

**3. Spec — the per-tool description.** `CodexToolRendererSpec`
(`tool-renderer.ts:39-113`) carries icon, running/completed/failed verbs, an
`argument(args, cwd)` formatter, optional `headerLayout`, `collapsed`,
`summarizeResult`, `renderCallPreview`, `renderExpandedResult`, expand-indicator and
row caps. The seven specs (`codex-tool-specs.ts:101`, `:121`, `:133`, `:145`,
`:176`, `:201`, `:222`):

| Tool | Icon | Verbs | Collapsed summary | Expanded body |
| --- | --- | --- | --- | --- |
| `read` | `\uF15C` | Reading / Read | hidden; header carries `N lines` | `createReadEvidence` |
| `grep` | `\uF0B0` | Searching / Searched | `N matches` | plain output preview |
| `find` | `\uF002` | Finding / Found | `N files` | plain output preview |
| `ls` | `\uF07B` | Listing / Listed | `N entries` | plain output preview |
| `bash` | `\uF155` | Running / Ran | `N output lines` / `no output` | `createBashExpandedEvidence` |
| `write` | `\uEE38` | Writing / Wrote | `+N` | write preview (highlighted) |
| `edit` | `\uEE3C` | Editing / Edited | `+A -D` | edit diff box |

`read` uses `collapsed: "hidden"` plus `singleLineHeader: true` and
`showExpandIndicator: false` (`codex-tool-specs.ts:101-119`). `bash` uses
`collapsed: "preview"`, `failedCollapsed: "hidden"`, `expandedResultOnFailed: true`,
`transformOutput: compactBashStatusSpacing`, and `showExpandIndicator: true`
(`codex-tool-specs.ts:176-199`) — the glance header is the only bash header form;
full command evidence lives in the expanded body (comment `:171-175`).

**4. Render — `createCodexToolRendering`.** `tool-renderer.ts:341` returns
`{ renderShell: "self", renderCall, renderResult }`. `renderShell: "self"` means the
tool paints its own chrome instead of using host-provided shell decoration;
`tests/register.test.ts` asserts every registered tool keeps that value.

Per-row mechanics:

- **Header.** `headerText` composes `icon + bold verb + argument + summary + chevron`
  (`tool-renderer.ts:263-277`). `leadingParts` picks the bullet color from
  `state.leadingIconOverride` (warning) else status (`failed` → error, `completed` →
  success, else dim) (`:228-234`), picks the verb from status (`:235-240`), and
  emits an empty icon when the host owns the persistent mark (`context.toolCallMark`,
  `:246-248`). A failed verb is always error-red regardless of icon provenance
  (`:249-250`). The summary is prefixed with a dim ` · ` and optionally routed
  through `spec.formatSummary` (`:241-245`). Long single-line headers go through
  `SingleLineToolHeader`, which delegates width-safe truncation to pi-tui's
  `TruncatedText` and replaces embedded CR/LF runs with ` ↵ ` (`:139-163`, `:166-187`).
- **Body.** Expanded rendering prefers `spec.renderExpandedResult` when the host says
  expanded and the call is settled and (success or `expandedResultOnFailed`)
  (`tool-renderer.ts:380-389`). Otherwise the raw text is transformed and shown
  through `ToolOutputComponent` — expanded with all rows, or, for settled *failed*
  calls with meaningful output and `failedCollapsed !== "hidden"`, a collapsed tail
  preview (`:396-419`). Everything else returns an empty `Container`; settled bash is
  header-only on both success and failure (`:420-422`).
- **Output shape.** `tool-output.ts` owns the `  └ ` first-line / `    ` continuation
  rail (`:5-6`), the wrap-then-prefix-then-truncate order (`:60-84`), and the
  preview/expanded builders (`:86-126`). Preview defaults to 5 rows
  (`tool-renderer.ts:128`) and splits head/tail around an `… +N lines` marker unless
  `edge: "tail"` (`tool-output.ts:86-117`). Pi's bash success placeholder
  `(no output)` is recognized once, in one place, and excluded from counts
  (`tool-output.ts:28-44`).
- **Live padding.** Every render calls `paddingSource.track(toolCallId, invalidate)`
  and reads `getOutputPad()` fresh (`tool-renderer.ts:349`, `:365`). The controller
  watches `settings.json` (`output-padding.ts:50-61`, `:112-116`), re-reads the
  `outputPad` key with project setting winning over global and any non-`0` value
  collapsing to `1` (`:103-110`), and invalidates every tracked row when it changes
  (`:72-79`). Tracked invalidators are capped at 200 with oldest-first eviction
  (`:19`, `:90-100`); the comment explains why trimming is safe — rendered calls
  re-track on every render.

`bash-command-header.ts` (`WrappedCommandHeader`, `:59`) still implements the Codex
ExecCell `wrap-command` layout, but no production spec sets `headerLayout:`
`"wrap-command"` any more. The file's own header marks it reserved, routed only for
tests and future opt-in (`bash-command-header.ts:5-12`).

## Codemode

Three modules, deliberately split so that only one of them knows upstream field
names.

- **`codemode-contract.ts`** is the boundary. Its header states it is the only place
  that knows `CodemodeToolDetails`, `CodemodeNestedCall`, and the script header text,
  and that parsing must stay fail-soft (`codemode-contract.ts:1-12`). `toTreeView`
  (`:258`) maps an unknown payload to a stable `TreeView` (`:52-59`): glance counts,
  child rows, code and output blocks, optional `fullOutputPath`, image count, and a
  `capabilities.childResultPreview` probe. `stripScriptHeader` (`:75`) uses a line
  scan rather than one regex specifically so wall-time wording can drift (`:69-74`).
  `summarizeCallArgs` (`:155`) prefers `path`/`file`/`filePath`, then
  `command`/`cmd`, then `pattern`/`query`/`url`/`text`, then `oldText`, and falls back
  to a truncated raw JSON preview rather than dropping the value. Statuses normalize
  to `running | ok | error | cancelled | unknown` (`:198-201`).
- **`codemode-tree.ts`** is UI only. `formatCodemodeGlance` (`:62`) renders
  `└ Ran N commands · Read N files · Edited N files · N failed · N images`, replacing
  the `└` with the caller's `leadingIconOverride` when one is set (`:67-68`), and
  saying ` · all failed` when nothing succeeded (`:78-82`). Collapsed results reuse
  the host `Text` component and only reset its text (`:368-375`); expanded results
  return a clickable tree (`:383`). `createClickableTree` (`:265`) caches lines per
  width, maps a left-click's `y` to a section (`sectionAtY`, `:246-263`), toggles it
  (`toggleSection`, `:299`), and returns `{ handled: true }` (`:294`). Body lines are wrapped to the content
  width *before* styling so every entry stays exactly one terminal row and the click
  y-mapping stays exact even for minified output — the same rule Pi 1.0.0 applies to
  its own preview (`:130-136`, `:138-152`). `TREE_BODY_INDENT` is 5 (`:125`).
  Per-call sections default to open on `error` and otherwise follow
  `expandedCalls` (`:173`). Section headers are built by `blockHead` (`:127`).
- **`codemode-tool.ts`** does the registration trick. Pi 1.0.0 has no
  renderer-only registration API, so `registerCodemodeTreeTool` (`:54`) resolves
  pi's public `createCodemodeExtension` factory off the package namespace, runs it
  against a `Proxy` that intercepts `registerTool` to capture the real definition,
  and re-registers `{ ...definition, ...tree, defaultActive: false }` (`:37-52`,
  `:62-70`). `execute` and `prepareLoadout` stay verbatim, which the file calls out
  as the reason it never hand-writes execute (`codemode-tool.ts:10-16`). The comment
  also records the expected side effect: re-registering a name from a
  non-replaceable extension omits `builtin:codemode` because the first registration
  per name wins (`:18-20`). Hosts older than 0.99 have no factory and the function
  returns without registering (`:56-59`).

`__captureCodemodeDefinitionForTest` (`codemode-tool.ts:71`) exposes the capture
step for tests. No test file currently imports `codemode-tool.ts`.

## Editor and input surface

### The editor factory stack

`registerEditorChrome` (`editor-chrome.ts:28`) owns a single editor factory that
composes three layers, innermost first, and installs it with
`ctx.ui.setEditorComponent` (`:94`). It runs on `session_start` behind
`isInteractiveTui(ctx)` (`:40`) and refuses to wrap a factory that already carries
its own `__editorChrome` marker, so resumes and forks cannot grow the closure chain
(`:45-47`, `:93`). Inside the factory (`:56-92`):

1. The previous factory is called, or a fresh `CustomEditor` is constructed when
   there is none (`:71-73`).
2. `applyBoxChrome(editor, providers)` (`model-editor.ts:56`) wraps `render`.
3. `applyAutocompleteAbove(withBox, tui)` (`autocomplete-above.ts:64`) is applied
   last, so the completion panel is laid out against the final boxed width
   (`editor-chrome.ts:89-91`).

The badge text and visibility come from pi-safety's structured `pi-safety:mode` bus
event, not from the footer's status text (`editor-chrome.ts:6-10`, `:32-37`).
`PermissionsModeState.applyEvent` returns whether anything changed, and only then is
a repaint queued (`:36`); burst events coalesce through a microtask
(`:61-70`). The event shape is validated by `isPermissionsModeEvent`
(`packages/shared-tool-presentation/src/permissions-mode.ts:15-31`), and visibility
keys off `severity` with `label` as display copy (`:1-5`, `:23-35`).

### Box chrome

`applyBoxChrome` (`model-editor.ts:56`) decorates in place rather than replacing the
class, so decorations from earlier extensions survive (`:50-55`), and guards with
`Symbol.for("@x1a2h1/pi-core:box-chrome-applied")` (`:48`, `:60-63`). It renders the
upstream editor at `width - 2` (`:77-79`), locates the border rows with
`isHorizontalBorder` — including scroll indicators like `─── ↓ 2 more ───`
(`:87-95`, `box-editor.ts:25-29`) — splices the mode badge into the top border
(`:98-106`), and only then wraps with `boxEditorLines`
(`:111-114`). Narrower than `BOX_MIN_WIDTH = 24` (`box-editor.ts:19`, `:77`) the
editor renders unboxed. Without a mode label `buildTopBorder` returns `undefined`
and the top border is left clean (`border-labels.ts:34-45`).

Badge color follows the product rule stated in `badge.ts:1-13`: auto mode is
`warning` (attention, not alarm), YOLO is `error` (alarm), with inverse-video cap
fallback when truecolor data is missing (`:52-56`). Badge width accounting adds
`BADGE_CAP_WIDTH = 2` for the two powerline caps (`:23`, `border-labels.ts:39`).

`box-editor.ts` and `format-primitives.ts:2` are intentionally free of pi package
imports so tests can run them under bare node (`box-editor.ts:15-16`).

### Floating panels

`EditorFloatPanel` (`editor-float-panel.ts:179`) is the "where and how long"
mechanism; consumers decide content (`:1-9`). Placement math needs three facts,
resolved by `resolveLayout` (`:75-98`): the editor's index in the root children
(`locateEditor`, `:46-60`, which also searches one nesting level), the rendered
height of every sibling below it (`suffixHeight`, `:84-89`), and whether the editor
is actually bottom-anchored — `mode === "fullscreen"`, or the main screen's
`captureRenderState().cursorRow + 1 >= rows` (`:94-96`). Shorter sessions render
content top-aligned, and bottom-anchored arithmetic would detach the panel, so
`computeRowFromLayout` returns `null` instead (`:118-127`, comment `:69-74`).

`show()` (`:198-236`) re-mounts the overlay only when geometry changes, because
`OverlayOptions` has no public mutation API (`:224-227`); otherwise it just unhides.
Liveness is `locateEditor(tui, anchor) !== null` (`:228`) and death disposes the
entry permanently through a queued microtask (`:144-152`, `:228-233`). `getLayout`
caches the `captureRenderState()` snapshot while a panel is open and invalidates on
resize or hide (`:267-287`).

`autocomplete-above.ts:64` uses that panel to move pi's completion list above the
input box with zero layout shift, and degrades to inline lines prepended above the
editor when floating is unavailable (`:126-131`). It mirrors the base editor's
padding math (`:105-107`), detaches `autocompleteList` for the duration of the
original render so the host skips its own placement (`:95-102`), and remaps
tab/shift+tab to panel navigation (`:151-168`). Enter is deliberately forwarded as a
synthetic `\t` so it completes without submitting, which sidesteps upstream's
`tui.select.confirm` path where `/` prefixes fall through to submit
(`:140-149`, `:162-165`).

`selector-float.ts` floats pi's built-in selector panels instead of leaving them in
the editor slot. It uses "plan B": the host's `showSelector` flow is untouched and
only the container's `render` is patched (`selector-float.ts:1-19`). Floated
selectors are opt-in per constructor name through `FLOAT_ALLOWLIST`
(`:30`, currently only `SettingsSelectorComponent`) or a `markFloatableSelector`
brand (`:27`, `:49-59`). Fullscreen keeps the native inline selector because the
dock reserves a minimum height (`:91-97`). `installSelectorFloat` (`:67`) is called
lazily from `applyAutocompleteAbove`'s first render, because the container can only
be located while the editor sits inside it (`autocomplete-above.ts:78-87`).

`selector-tab-nav.ts:104` installs a raw-terminal-input listener once per session
that rewrites tab → down and shift+tab → up *only while a selector occupies the
editor slot* (`:91-96`, `:79-85`). It runs before focused-component dispatch and
extension shortcuts, so shift+tab also stops cycling the pi-safety mode while a
selector is open (`:98-103`). The accepted trade-off is documented: the model and
session selectors lost their tab scope-toggle shortcut (`:11-14`).

`frame.ts` provides the shared rounded frame for both floating panels
(`:32-42`) and documents why it is open at the bottom: the editor's own top border
closes it (`:5-12`).

### Commands and message chrome

- `/effort` opens pi's own `ThinkingSelectorComponent` in the editor slot through
  `ctx.ui.custom`, so `selector-tab-nav` and `selector-float` both apply
  (`effort-command.ts:29-54`). Levels come from pi-ai's
  `getSupportedThinkingLevels` (`:42`), the command bails with a warning for
  non-reasoning models (`:36-40`), and the save-key path applies the level to the
  session while pointing the user at `/settings`, because extensions cannot persist
  the default (`:20-26`, `:58-64`).
- `/exit` is a true alias that calls `ctx.shutdown()` (`exit-command.ts:4-10`).
- `user-message-bar.ts` patches `UserMessageComponent.prototype.render` to add a
  Crush-style `▌` rail plus a content background band (`:2-29`). It supports both
  host shapes, detected at render time by "Box has `setBgFn`, Markdown does not"
  (`:74-81`), unwrapping the ≤0.99 box or dropping the 1.0.0+ Markdown's own
  `paddingY` blank rows (`:82-110`). It renders at `width - 1`, re-applies
  `userMessageBg` (and `borderAccent` for the bar) to content columns only, and keeps
  one blank banded row above and below for a 3-row minimum (`:69`, `:123-131`). OSC
  133 zone marks are re-applied around the whole block (`:35-37`, `:132-133`). The
  patch is re-entrant through a prototype-stashed original so `/reload` swaps the
  wrapper instead of pinning a stale closure (`:54-59`). Geometry note: the bar owns
  column 0, so `outputPad = 0` shifts user content one column right of the assistant
  edge — inherent to keeping the rail (`:19-22`).

## Evidence and diff rendering

**`edit-diff.ts`.** `parseEditDiff` (`:22`) splits pi's display diff on
`/^([ +-])(\s*\d*)\s(.*)$/` (`:20`) into context / added / removed rows with optional
line numbers. `createEditDiffBox` (`:201`) builds a `Box(1, 0)` with **no box-wide
background** — each row paints its own (`:208-211`) — and indents the whole thing by
`outputPad` (`:211`). Row rendering (`:136-177`) uses a marker, a right-aligned line
number, a `│` gutter, and diff colors `toolDiffAdded` / `toolDiffRemoved` /
`toolDiffContext`; when syntax highlighting produced ANSI, only the gutter takes the
diff color, because the content already carries its own (`:163-166`). Long lines wrap
with continuation rows sharing the number gutter (`:160-171`). Per-row backgrounds
come from `buildRowBackgrounds` (`:90`), which parses truecolor SGR with `parseTruecolor`
(`:56`) to derive readable banded backgrounds.

**`write-preview.ts`.** The write preview is an incremental highlighting cache, not
a re-highlight per frame. `WriteHighlightCache` (`:18-24`) keeps raw content,
normalized lines, and highlighted lines. `updateWriteHighlightCache` (`:74`) rebuilds
wholesale when the path, language, or prefix changed, and otherwise highlights only
the appended suffix and then re-highlights the first `PREVIEW_LINE_LIMIT = 50` lines
(`:16`, `:52-67`, `:74-107`) — the prefix pass is needed because multi-line constructs
only resolve once the closing delimiter arrives (`:52-57`). `createWritePreviewFromArgs`
(`:153`) is shared by the streamed `renderCallPreview` and the settled
`renderExpandedResult` paths, and the component carries the cache so the caller can
persist it in renderer state (`:135-146`). The header comment records that the
machinery mirrors pi's built-in write renderer and is duplicated because that
implementation is not public API (`:4-13`).

**`read-evidence.ts`.** `summarizeReadLines` (`:22`) produces the `N lines` header
summary and yields nothing on error. `createReadEvidence` (`:129`) renders a dim
line-number gutter plus `│` plus highlighted content, using
`getLanguageFromPath` + `highlightCode` with a `toolOutput` fallback on throw
(`:64-72`). The painted rows are cached independently of terminal width so a resize
does not re-highlight (`:53-56`, `:74-89`), and the whole view is capped at
`READ_EVIDENCE_MAX_LINES = 2000` / `READ_EVIDENCE_MAX_CHARS = 200000` so a global
ctrl+o cannot stall the TUI (`:7-8`, `:90-106`). Omitted lines collapse to a dim
`… +N lines` row (`:115-122`). The spec comment states the read evidence never
reuses bash's `└` rail (`codex-tool-specs.ts:96-100`).

**`bash-evidence.ts`.** `commandGlance` (`:19`) is the fixed-budget header subject:
first logical line, capped, `…` when truncated or when more non-empty command lines
exist. `BASH_GLANCE_BUDGET = 52` exists so `· N output lines` and the chevron stay on
the header row (`:11`). `createBashExpandedEvidence` (`:86`) renders the full
highlighted command under a `  │ ` rail with `$ ` on the first line
(`:42-58`, `:63-73`), then the full output, error-colored on failure (`:74-82`). The
command is capped at `MAX_COMMAND_CHARS` before highlighting (`:68-70`).

**`shell-command-highlight.ts`.** `MAX_COMMAND_CHARS = 4000` caps work before
highlighting so pathological commands cannot stall the renderer (`:3-4`). The
highlighter finds command-position tokens by shell separators and reserved words
(`:11-30`), substitutes unique placeholders so user text cannot collide with a
token, highlights, then restores (`:60-72`). It resolves pi's theme off the
host-published `Symbol.for("@earendil-works/pi-coding-agent:theme")` key
(`:37-40`).

**`markdown-code-frame.ts`.** pi-tui's `Markdown` hardcodes raw fence lines and
offers no hook (`:1-13`), so `applyMarkdownCodeFrame` (`:63`) patches
`Markdown.prototype.renderToken`, intercepts the `"code"` branch, and delegates
everything else to the original (`:69-84`). The replacement shape is
Codex-aligned — pure highlighted content with no fence, language label, or indent, so
selection copies just the code (`:14-21`). Spacing after the block is preserved by
emitting a blank line when the next token is not `space` (`:115-117`). Syntax
highlighting is untouched: `theme.highlightCode` when present, else `codeBlock` per
line (`:20-21`, `:102-104`). Any error falls back to the original fence rendering
(`:77-82`), and the pristine original is stashed on the prototype so a reload swaps
the wrapper rather than pinning a stale closure (`:54-62`).

## Rate and timing indicators

**`token-rate.ts`** is the measurement core, with no UI. `createTokenRateTracker`
(`:120`) accumulates an estimate from text/thinking/toolcall deltas
(`:44-53`, `:127-130`), anchors elapsed time at the **first content token** rather
than request start so prefill/TTFT is excluded and the rate measures pure decode
throughput (`:33-39`), waits `FIRST_SHOWN_MS = 1000` before the first display so the
small-sample spike at stream start does not show (`:25-29`, `:135-137`), and then
throttles refreshes at `DEFAULT_THROTTLE_MS = 100` (`:24`, `:138`).
`estimateTokensFromChars` (`:73`) counts CJK characters as roughly one token each
and everything else at ~4 chars per token (`:55-81`), including supplementary-plane
ideographs via code-point iteration (`:63-71`). `finalize` (`:152`) replaces the
estimate with the provider's real `usage.output` on `message_end` — the only event
that carries usage — always bypassing the throttle because it is the final true value
(`:18-21`, `:161-170`). `streamHealth` (`:104`) is a separate export classifying a
turn as `healthy | slow | stalled` from idle time, burst length, and throughput, so
a sustained crawl is not mistaken for progress (`:85-101`). It is ported from
another codebase with thresholds proven for the same speedometer use case (`:94-95`).

**`working-token-rate.ts`** is the adapter. It holds one tracker (`:42`) and drives
the footer through `ctx.ui.setWorkingMessage` — which updates text without
restarting the spinner (`:35-40`). `formatWorkingMessage` builds
`Working 111 tok/s` into a `RATE_COLUMN_WIDTH = 3` right-aligned column so 2- and
3-digit rates do not make the line jitter, with `≈` marking an estimated rate
(`:16-25`). Identical messages are skipped so the footer is not re-rendered every
tick (`:43-45`, `:76-79`). Lifecycle: `agent_start` clears (`:60-62`),
`message_start` resets the baseline (`:64-69`), `message_update` streams the rate
(`:71-80`), `message_end` corrects it with real usage unless the message is a pure
tool call (`:82-99`, `:27-33`), `tool_execution_start` restarts the counter while
keeping the last rate visible (`:101-105`), `model_select` resets because a new model
changes the measurement baseline (`:107-114`), and the prompt events swap in
`Waiting for input` / restore the last rate (`:116-126`). `agent_end` restores pi's
default (`:128-131`). Non-TUI modes never touch the UI (`:72`, `:90`, `:117`, `:123`).
`clearRate` still defensively clears the retired above-editor widget key
`pi-core:working-token-rate` (`:5`, `:51-57`).

**`thinking-glance.ts`** patches `AssistantMessageComponent.prototype.updateContent`
so each hidden thinking run renders its own glance instead of the host's single
global label (`:1-15`, `:115-124`): `└ Thinking…` while open and
`└ Thought for 1.4s` once settled (`:52-64`). There is deliberately no `▶` chevron —
expand stays host-owned via click or `app.thinking.toggle`, and the constant is an
empty string (`:12-14`, `:21-22`). Durations come from the side-channel below;
unknown durations degrade to plain `Thought` (`:106-113`). The patch is
re-entrant through a prototype-stashed original (`:120-122`), falls back to the host
implementation on any error (`:237-239`), and click toggling writes into the host's
`thinkingVisibilityOverrides` map before re-invoking the original (`:203-210`). It
also re-implements truncation and abort/error tail rows that the host render draws
(`:216-236`). The theme is resolved off
`Symbol.for("@earendil-works/pi-coding-agent:theme")` (`:45-50`).

**`thinking-timing.ts`** is the memory-only side-channel. Pi's thinking content has
no duration, so `createThinkingTimingTracker` (`:27`) derives it from
`thinking_start` / `thinking_delta` and stream boundaries (`:53-74`), keyed by
`messageKey#runIndex` (`:39-42`, `:80-82`). A `text_delta` or tool-call boundary
settles open runs (`:65-73`); `message_end` settles them by stop reason
(`:75-79`). Resume/compact lookups miss, which is exactly why the glance degrades to
`Thought` (`:4-7`). `thinking-glance.ts:67` defines the message key as
`timestamp|responseId`, explicitly not display text.

## `isInteractiveTui()`

`extensions/pi-core/src/tui/ui-guard.ts:4` is the single shared guard for
TUI-only affordances:

```ts
return context.hasUI && context.mode === "tui";
```

The header states the reason (`ui-guard.ts:1-3`): in Pi 0.84 `hasUI` is true in both
TUI and RPC modes, because RPC can answer dialogs. Only `mode === "tui"` supports raw
terminal input, editor components, widgets, and working lines. Checking `hasUI` alone
would therefore try to install editor chrome into a non-terminal session.

It matters at every point where pi-core touches host UI:

| Call site | Guarded behavior |
| --- | --- |
| `output-padding.ts:139-147` | Starts settings watching only in the TUI; otherwise stops the controller. |
| `canonical-tool-fallback.ts:64` | Registers the canonical fallback only in the TUI. |
| `editor-chrome.ts:40` | Installs the editor factory only in the TUI. |
| `selector-tab-nav.ts:106` | Installs the raw-input rewrite only in the TUI. |
| `effort-command.ts:34` | `/effort` no-ops outside the TUI before touching the model. |
| `working-token-rate.ts:50-57`, `:72`, `:90`, `:117`, `:123` | Clears widgets, streams the rate, and swaps the waiting message only in the TUI. |
| `user-message-bar.ts:155` | Captures the theme only in the TUI. |

Because the same predicate gates the pad controller, the canonical fallback, and the
renderer's default pad source, all three agree about whether floating/padded
rendering is in play.

## Testing and CI

**Tests.** 34 flat `tests/*.test.ts` files mirror `src/tui/*` by basename
(`extensions/pi-core/README.md:60`). Every module with logic has a direct test, with
these exceptions, all verified by filename lookup against the 36 modules in
`src/tui/`:

| Module | Why |
| --- | --- |
| `frame.ts` | Trivial geometry helper, covered through the overlay, markdown, and autocomplete tests. |
| `border-labels.ts` | Exercised through `tests/model-editor.test.ts`. |
| `thinking-timing.ts` | Exercised through `tests/thinking-glance.test.ts` and `tests/pi-api-compat.test.ts`. |
| `format-primitives.ts` | One-line ANSI strip. |
| `codemode-tool.ts` | Currently unreferenced by any test, despite exposing `__captureCodemodeDefinitionForTest`. |

Two suites carry weight beyond their own module:

- `tests/register.test.ts` is the integration check on the register graph. It asserts
  the exact registered tool set is `[read, grep, find, ls, codemode]`, that every
  registered tool has `renderShell === "self"`, that `bash` / `write` / `edit` are
  absent by default, that the six token-rate lifecycle events are subscribed, that
  editor chrome subscribes to both `session_start` and the `pi-safety:mode` bus, that
  `/exit` exists, and the collapsed one-line summaries for read/grep/find/ls.
- `tests/pi-api-compat.test.ts` pins the private runtime seams pi-core reaches through
  because pi exposes no public hook: the `Editor` autocomplete fields
  (`isShowingAutocomplete`, `autocompleteList`, `getPaddingX`), `Markdown`'s
  `renderToken` and instance theme, `AssistantMessageComponent.updateContent` /
  `setHiddenThinkingLabel`, `SettingsSelectorComponent`'s constructor name,
  `SettingsManager.create`'s `drainErrors` / `getShellPath` /
  `getShellCommandPrefix`, and the canonical builtin source-marker format
  (`BUILTIN_PATH_PREFIX` / `<builtin:${` / `builtin:${`). The intent is explicit:
  a future Pi upgrade should fail here instead of degrading later in an interactive
  session (`pi-api-compat.test.ts:15-21`).

Shared fixtures live in `tests/helpers/` — `effort-fixtures.ts` (an identity theme
stub) and `token-rate-fixtures.ts` (a realistic assistant message plus a text-delta
update event). `biome.json` relaxes `noExplicitAny` and `noNonNullAssertion` for
`tests/**` only.

**Scripts** (`extensions/pi-core/package.json:34-39`):

```bash
npm run check    # tsc --noEmit
npm run lint     # biome check .
npm run format   # biome check --write .
npm run test     # vitest --run
```

`tsconfig.json` includes `index.ts`, `src/**/*.ts`, and `tests/**/*.ts`, targets
ES2022, and enables `allowImportingTsExtensions` (required, since every import
carries a `.ts` extension). Biome requires `useImportType` / `useExportType`,
`noExplicitAny`, `noConsole`, and `noNonNullAssertion` in source, and excludes
`docs`, `work`, `.pi`, `.pi-subagents`, and `graphify-out` from its scope.

**CI.** `.github/workflows/ci.yml` runs on pushes to `main` and on every pull
request. One job on `ubuntu-latest`: checkout, `pnpm/action-setup`, Node 22 with pnpm
cache, then `pnpm install --frozen-lockfile`, `pnpm run check`, `pnpm run lint`,
`pnpm run test` (`extensions/pi-core/.github/workflows/ci.yml:3-21`). All three must
stay green (`extensions/pi-core/AGENTS.md:87-88`).

Note that this is the **only** workflow in the repository — there is no root
`.github/` directory — so it is what runs for the monorepo, but it installs and tests
the `pi-core` workspace only. `pi-safety`, `statusline`, and `tool-result-budget`
have no CI of their own.

## Where to change what

| You want to… | Start at |
| --- | --- |
| Change a tool's header copy, icon, or verbs | its spec in `src/tui/codex-tool-specs.ts` |
| Change how any tool row is composed | `src/tui/tool-renderer.ts` (`headerText` `:263`, `renderResult` `:363`) |
| Change expanded output shape or preview rows | `src/tui/tool-output.ts`, plus the spec's `maxOutputRows` / `failedOutputRows` |
| Add a tool to the Codex presentation | add a spec, then a case in the private map at `src/tui/codex-tool-presentation.ts:20` |
| Change editor chrome or the mode badge | `src/tui/model-editor.ts`, `src/tui/border-labels.ts`, `src/tui/editor-chrome.ts` |
| Change floating-panel placement | `src/tui/editor-float-panel.ts` (`resolveLayout` `:75`, `computeRowFromLayout` `:118`) |
| Change how an overlay is allowed to float | `src/tui/selector-float.ts` (`FLOAT_ALLOWLIST` `:30`) |
| Change thinking row copy or timing | `src/tui/thinking-glance.ts`, `src/tui/thinking-timing.ts` |
| Change the token rate math or health classification | `src/tui/token-rate.ts`; the footer adapter is `src/tui/working-token-rate.ts` |
| Change the cross-extension surface | `standalone.ts`, then the consumer table in `AGENTS.md:46-59` |
| Change a shared presentation primitive | **both** `extensions/pi-core/src/tui/<name>.ts` and `packages/shared-tool-presentation/src/<name>.ts` |

Two conventions to keep: every new cross-extension component is exported from
`standalone.ts` and its consumer recorded in the `AGENTS.md` table
(`extensions/pi-core/AGENTS.md:92-93`), and TUI-only behavior goes behind
`isInteractiveTui()` (`:91`).

`extensions/pi-core/AGENTS.md:89-90` still tells maintainers to keep
`docs/architecture.md` in sync. That file is gone; this document replaced it. Update
this file instead.
