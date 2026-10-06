# pi-ext-stuff — monorepo overview

`@crunl/pi-suite` (version 0.1.0, `private`, `"type": "module"`,
keyword `pi-package`) is a collection of extensions for the
[earendil-works Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
developed together in one repository but loadable independently.
It contains four pi extensions and one internal shared library.

## Packaging model

- **npm workspaces.** The root `package.json` declares
  `"workspaces": ["packages/*", "extensions/*"]`
  (`package.json:10-13`). That globs to the five members below.
- **No build step.** Everything ships as `.ts` sources; pi loads
  extensions directly through the host's `jiti` instance
  (`README.md:4-6`). No package has a `build` script, and every
  `pi.extensions` entry points at a `.ts` file.
- **All private / unpublished.** Every member sets `"private": true`.
  The root is the npm package (`package.json:2-4`); the four
  extensions are separate npm packages (e.g. `pi-core`,
  `pi-safety`, `statusline`, `tool-result-budget`) installed by local
  path, not published.
- **Peer dependencies.** The root declares
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and
  `@earendil-works/pi-ai` (all `*`)
  (`package.json:26-30`); `pi-core` and `shared-tool-presentation`
  mirror the relevant subset.
- **No root `pnpm-workspace.yaml`.** There is none at the repo root
  (verified: `ls pnpm-workspace.yaml` at root fails). Two members
  (`extensions/pi-core`, `extensions/pi-safety`) each carry their own
  `pnpm-workspace.yaml`; those are pnpm install-policy files
  (`allowBuilds`, `minimumReleaseAgeExclude`), not workspace roots.
  The workspace itself is npm's.
- **Root scripts.** `check` = `npm run --workspaces --if-present check`,
  `test` = `npm run --workspaces --if-present test`
  (`package.json:22-25`).

## The five members

| Member | Purpose | src | tests |
| --- | --- | --- | --- |
| `extensions/pi-safety` | Permission modes, sandbox, guardian reviewer | 64 files / 24,901 lines | 54 files / 27,162 lines |
| `extensions/pi-core` | Codex-style tool presentation, TUI polish | 37 files / 5,114 lines + 44 entry lines | 36 files / 5,929 lines |
| `packages/shared-tool-presentation` | Pure presentation specs/renderers (shared lib) | 15 files / 2,090 lines | 3 files / 182 lines |
| `extensions/statusline` | Boxed footer: token/model/effort/usage | 8 files / 725 lines + 2 entry lines | 5 files / 341 lines |
| `extensions/tool-result-budget` | Per-turn tool-result size limit with spill files | 1 file / 180 lines | none |

`pi-safety` dominates the codebase: it is roughly 4.7× the source of
`pi-core` and 11× `shared-tool-presentation`, and its test suite is
~27,000 lines — by far the largest in the repo.

### `extensions/pi-safety` (the largest member)

Permission modes (`auto` / `yolo`) for pi, with sandboxed tool
execution and an external "guardian" LLM reviewer that approves risky
actions on the user's behalf (`extensions/pi-safety/README.md:1-7`).
The old human-popup `default`/`plan` modes are retired. `bash`,
`write`, and `edit` run inside an OS-enforced sandbox backed by
pristine `@anthropic-ai/sandbox-runtime@0.0.77`
(`extensions/pi-safety/package.json:27-31`, `extensions/pi-safety/AGENTS.md`
"sandbox enforcement" section). `extensions/pi-safety/src/register.ts`
(~2,930 lines) is the host adapter that loads config, captures turn
snapshots, maps host tool events to the Engine, and owns the concrete
bash/write/edit adapters (`extensions/pi-safety/AGENTS.md` "Layout notes"). Entry:
`index.ts` default-exports `registerExtension` from `src/register.ts`
(`extensions/pi-safety/index.ts:1`). It is the only member with
runtime `dependencies` (`@anthropic-ai/sandbox-runtime`,
`tree-sitter-bash`, `web-tree-sitter`) —
`extensions/pi-safety/package.json:27-31`.

### `extensions/pi-core`

An opinionated core pack: Codex-style tool rendering, a live working
token rate in the footer spinner, edit-diff previews, floating
overlays, output-padding sync, and markdown code framing
(`extensions/pi-core/README.md:1-7`). Tool registration is
first-wins; pi-core registers `read`/`grep`/`find`/`ls` with Codex
rendering and conditionally decorates canonical `bash`/`write`/`edit`
in interactive TUI when no extension owns them
(`extensions/pi-core/AGENTS.md` "Who registers what"). Its
`src/register.ts` is an orchestration facade that calls every
`register*` once, in order (`extensions/pi-core/src/register.ts:15-28`).
Node ≥ 22.19.0 (`extensions/pi-core/package.json:40-42`).

### `packages/shared-tool-presentation`

The only shared library. A pure, side-effect-free library of
Codex-style tool-rendering specifications and components
(`packages/shared-tool-presentation/package.json:5`). See the next
section.

### `extensions/statusline`

A custom TUI footer: a powerline chain (`mode`·`effort`·`folder`·`git`)
on the left and cache-hit / context-usage stats on the right, using
Catppuccin dual-theme truecolor (`extensions/statusline/README.md`,
written in Chinese). It installs via `ctx.ui.setFooter()` on every
`session_start` and toggles with the `/statusline` command
(`extensions/statusline/src/index.ts:38-70`). It is the only member
with no `version` field (`extensions/statusline/package.json:1-8`); all
five members carry `private: true`. It also declares neither a `files`
nor an `exports` map — a distinction it shares with `pi-safety`, the only
other member lacking both.

### `extensions/tool-result-budget`

A single 180-line file that bounds how many characters one turn may
add to context via tool results (default 60,000/turn, never shrink a
result under 4,000); overflow is written whole to a spill file under
`~/.pi/agent/tool-spill/` and replaced with head + tail + a pointer
(`extensions/tool-result-budget/index.ts:1-180`, header comment
lines 1-33). It never compacts, never aborts, and never touches pi's
compaction or goal accounting. Standalone: Node builtins plus the
extension API only, no cross-package imports
(`extensions/tool-result-budget/README.md` "Relationship").

## `packages/shared-tool-presentation` — the shared library

**Why it exists as a separate package.** Three different packages
need the *same* Codex presentation code: `pi-core` (its own TUI),
`pi-safety` (decorating the tools it owns), and `statusline` (badge
colors). Putting it in `pi-core` would make `pi-safety` and
`statusline` depend on a pi extension (and pull its register graph
into their `jiti` instances). A pure leaf package breaks that cycle:
it has no host side effects and no dependencies on any extension, so
any extension can import it cleanly. Its own header says it is the
"side-effect-free Codex-style tool rendering specifications,
components, and high-order presentation decorators"
(`packages/shared-tool-presentation/src/index.ts:1-6`).

**What it exports** (`packages/shared-tool-presentation/src/index.ts:7-46`):
`withCodexToolPresentation`; the seven `codex*ToolSpec` specs
(bash/edit/find/grep/ls/read/write) plus `colorizeEditDiffSummary`,
`compactBashStatusSpacing`, `countWrittenLines`, `displayPath`,
`summarizeBashOutput`, `summarizeEditDiff`; the badge surface
(`BADGE_CAP_WIDTH`, `PL_LEFT`, `PL_RIGHT`, `contrastTextFor`,
`makeModeBadgeDecorator`, `parseTruecolor`); `createEditDiffBox` /
`parseEditDiff`; `createBashExpandedEvidence` / `commandGlance` /
`BASH_GLANCE_BUDGET`; `highlightShellCommandLines` / `MAX_COMMAND_CHARS`;
`createCodexToolRendering` (+ `CodexToolRendererSpec`); the
`OutputPad`/`OutputPaddingSource` types; and the permissions-mode
surface (`ModeSeverity`, `PermissionsModeEvent`,
`isPermissionsModeEvent`, `PermissionsModeState`).

**The duplication question — resolved.** `pi-core/src/tui/` contains
near-namesake files (`tool-renderer.ts`, `codex-tool-specs.ts`,
`edit-diff.ts`, `shell-command-highlight.ts`, `write-preview.ts`,
`output-padding.ts`, `read-evidence.ts`, `bash-command-header.ts`,
`bash-evidence.ts`, `codex-tool-presentation.ts`, `tool-output.ts`,
`ui-guard.ts`). These are **byte-identical copies** of the
corresponding files in `shared-tool-presentation/src/`, not re-exports
and not divergent code: `diff -q` reports every one of the 12 shared
names as IDENTICAL to its `pi-core/src/tui/` twin (e.g.
`packages/shared-tool-presentation/src/tool-renderer.ts` =
`extensions/pi-core/src/tui/tool-renderer.ts`, both 425 lines).
The shared package has 15 files; 12 are duplicated in `pi-core`, and
the 3 that are not are `index.ts` (the barrel), `badge.ts`, and
`permissions-mode.ts` — which `pi-core` imports *from the shared
package* rather than keeping local copies (see below).

**The relationship, precisely.** Both trees are live, and they are
imported through *different* paths:

- `pi-core/src/tui/*` keeps its local copies and wires them together
  internally (e.g. `extensions/pi-core/src/tui/tool-renderer.ts:7`
  imports `./bash-command-header.ts`; `src/tui/codex-tool-specs.ts:8-14`
  imports `./bash-evidence.ts`, `./edit-diff.ts`, `./read-evidence.ts`,
  `./shell-command-highlight.ts`, `./tool-output.ts`, `./tool-renderer.ts`,
  `./write-preview.ts`). `src/register.ts` drives this local graph
  (`registerOutputPaddingSync` from `./tui/output-padding.ts`,
  `extensions/pi-core/src/register.ts:9,16`).
- `shared-tool-presentation/src/*` is the same 12 files plus the barrel
  and the two statusline-facing modules, wired the same way internally
  (e.g. `packages/shared-tool-presentation/src/tool-renderer.ts:7`
  imports `./bash-command-header.ts`).
- `pi-core` does **not** import its own `src/tui` twins for the shared
  surface — it imports the shared package for the 3 non-duplicated
  modules: `src/tui/model-editor.ts:26`,
  `src/tui/editor-chrome.ts:18`, and `src/tui/border-labels.ts:7`
  import `badge.ts` / `permissions-mode.ts` via
  `../../../../packages/shared-tool-presentation/src/...`. And
  `standalone.ts:25` re-exports the whole shared barrel from
  `../../packages/shared-tool-presentation/src/index.ts`.

**So there are two sources of truth for the same 12 modules.** Nothing
in the repo generates or syncs one from the other, and no test asserts
the copies stay identical — a change to one tree will not reach the
other. This is the repo's main structural hazard. The duplication also
means `pi-core` carries ~2,000 lines of presentation code that already
live in `shared-tool-presentation`; `standalone.ts` deliberately bridges
the two by re-exporting the shared barrel (rather than the local
twins), so `pi-safety`'s cross-extension imports resolve to the
*shared* copies, while `pi-core`'s own register graph uses the *local*
copies.

**Who consumes it.** Every consumer uses a relative path into
`packages/shared-tool-presentation/src/`, not the npm name
(verified by grep across the repo):

- `extensions/pi-safety/src/register.ts:27` —
  `codexBashToolSpec`, `codexEditToolSpec`, `codexWriteToolSpec`,
  `createCodexToolRendering` from
  `../../../packages/shared-tool-presentation/src/index.ts`.
- `extensions/pi-core/standalone.ts:25` — re-exports the shared barrel.
- `extensions/pi-core/src/tui/{model-editor,editor-chrome,border-labels}.ts` —
  `badge.ts` / `permissions-mode.ts` deep imports.
- `extensions/statusline/src/status-mode.ts:1` and
  `extensions/statusline/src/palette.ts:23` — `badge.ts` deep imports.

The shared package's own `tsconfig.json` resolves the `@earendil-works/*`
peer packages and `*` through `../../extensions/pi-core/node_modules`
(`packages/shared-tool-presentation/tsconfig.json:11-17`), so it
typechecks against `pi-core`'s installed deps. Its test suite is small
(3 files: `badge`, `index`, `permissions-mode` — 182 lines) and does
not cover the duplicated renderer/spec modules.

## Cross-package dependency graph

Verified from the actual import statements (not the README). The
shape is a one-way flow with `shared-tool-presentation` as the pure
leaf:

```
shared-tool-presentation  (pure leaf, no extension imports)
        ^  re-exported
        |
      pi-core  ──standalone.ts──>  pi-safety
        |                              |
        |                              +──> statusline (via pi-safety:mode bus event)
        +──────────────────────────────┘  (statusline also imports shared badge directly)

tool-result-budget   (standalone: no cross-package imports)
```

- `pi-core` imports nothing back from `pi-safety` or `statusline`
  (grep of `extensions/pi-core` for those names finds none). Its only
  cross-package imports are *into* `shared-tool-presentation`
  (`standalone.ts:25` and the three `src/tui` deep imports above).
- `pi-safety` imports `shared-tool-presentation` only — from
  `src/register.ts` — and never imports `pi-core` at all. Its
  `AGENTS.md` ("Shared presentation dependency") states presentation
  helpers come "from the shared package only — never directly from
  `pi-core/standalone.ts` or `src/**` deep paths." The structure
  invariant test pins the exact importer set:
  `extensions/pi-safety/tests/structure-invariants.test.ts` asserts
  the only file importing
  `../../../packages/shared-tool-presentation/src/index.ts` is
  `src/register.ts` (the `sharedPresentation` set expectation), and
  that `@earendil-works/pi-coding-agent` is imported only by
  `src/guardian-tools.ts` and `src/register.ts`, and `@earendil-works/pi-ai`
  only by `src/auto-reviewer.ts`.
- `statusline` imports `shared-tool-presentation/badge.ts` directly
  (`src/status-mode.ts:1`, `src/palette.ts:23`) plus
  `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`
  (`src/footer.ts:16-17`). It does not import `pi-core` or
  `pi-safety` code; it receives pi-safety's mode via the
  `pi-safety:mode` bus event, which pi-core subscribes to
  (`extensions/statusline/README.md` "接线与组合").
- `tool-result-budget` has no cross-package imports
  (`extensions/tool-result-budget/index.ts` imports only `node:fs`,
  `node:path`, and `@earendil-works/pi-coding-agent`).

**What `pi-core/standalone.ts` exports and who imports it.**
`standalone.ts` (27 lines) is documented as "the side-effect-free
cross-extension surface of pi-core"
(`extensions/pi-core/standalone.ts:1-13`). It re-exports nine names
from the shared barrel — `codexBashToolSpec`, `codexEditToolSpec`,
`codexWriteToolSpec`, `colorizeEditDiffSummary`,
`compactBashStatusSpacing`, `createCodexToolRendering`,
`createEditDiffBox`, `summarizeEditDiff`, `withCodexToolPresentation`
(`extensions/pi-core/standalone.ts:15-25`) — plus `applyAutocompleteAbove`
and `markToolCall` from pi-core's own `src/tui`
(`extensions/pi-core/standalone.ts:26-27`). `index.ts` re-exports
`standalone.ts` (`extensions/pi-core/index.ts:17`) so existing
`../../pi-core/index.ts` imports keep working, while steering new
consumers to `standalone.ts` to avoid loading the register graph
(`extensions/pi-core/index.ts:5-10`). Within this repo, the only
in-repo importer of the shared surface is `pi-safety` — but it imports
the shared package *directly* (per its AGENTS.md rule), so in practice
no in-repo file imports `pi-core/standalone.ts`; it exists for
out-of-repo and legacy consumers.

## Pi extension registration model

Each extension is a package whose `package.json` carries a
`"pi": { "extensions": [...] }` array naming its entry file(s) —
e.g. `extensions/pi-core/package.json:20-24` lists `"./index.ts"`.
The root `package.json:14-21` aggregates all four in one array:
`./extensions/pi-safety/index.ts`, `./extensions/pi-core/index.ts`,
`./extensions/statusline/index.ts`, `./extensions/tool-result-budget/index.ts`.
pi discovers the entry files from these arrays.

Each `index.ts` is a thin default-export shim over the real module:

- `extensions/pi-safety/index.ts:1` — `export { registerExtension as default } from "./src/register.ts"`.
- `extensions/pi-core/index.ts:13-17` — default-exports
  `piCore(pi)` which calls `registerExtension(pi)`, then
  `export * from "./standalone.ts"`.
- `extensions/statusline/index.ts:1` — `export { default } from "./src/index.ts"`
  (auto-discovery shim).
- `extensions/tool-result-budget/index.ts:87-178` — the whole
  implementation, default-exporting the `pi => {…}` function.

**Load-once constraint.** Install each extension exactly once: a
symlink *and* a settings entry pointing at the same package causes pi
to load it twice, and the duplicate tool registrations collide
(`README.md:38-41`; `extensions/pi-safety/README.md` migration step
1, "path-based dedup would load the package twice"). The migration
section of `extensions/pi-safety/README.md` also warns that a
half-renamed install (both `pi-permissions` and `pi-safety` entries
present) leaves guardian protection offline.

## Install, upgrade, and the `pre-monorepo-pi-core` tag

Install is by local path, from a checkout of this monorepo
(`README.md:27-33`):

```bash
pi install ~/path/to/pi-ext-stuff/extensions/pi-core
pi install ~/path/to/pi-ext-stuff/extensions/pi-safety
pi install ~/path/to/pi-ext-stuff/extensions/statusline
pi install ~/path/to/pi-ext-stuff/extensions/tool-result-budget
```

It is not installable as a git package (pi's source parser has no
subdirectory support) and is not published to npm (all `private`)
(`README.md:35-37`). Upgrading from the renamed `pi-permissions` is
a three-step, all-or-nothing edit documented in
`extensions/pi-safety/README.md` ("Migrating from `pi-permissions`"):
re-point the settings entry/symlink, `mv permissions.json safety.json`
(no legacy fallback), and start a new session (old mode state is
intentionally not migrated — losing it is fail-closed).

`main` is the monorepo. The git tag `pre-monorepo-pi-core` (the only
tag in the repo; commit `a183628e…`) preserves the pre-monorepo
single-package history of pi-core
(`README.md:47-49`).

## Development workflow

**Root scripts** (`package.json:22-25`): `check` and `test` fan out
to every workspace with `npm run --workspaces --if-present`.

**Per-package scripts:**

- `pi-core` (`extensions/pi-core/package.json:34-39`): `check` = `tsc
  --noEmit`, `lint` = `biome check .`, `format` = `biome check --write
  .`, `test` = `vitest --run`.
- `pi-safety` (`extensions/pi-safety/package.json:14-21`): `check` =
  `tsc --noEmit`, `check:host-turn-boundary` = `node
  scripts/host-turn-boundary.mjs` (offline real-host step-boundary
  check driven through the pinned `createAgentSession` +
  `bindExtensions`, described in `extensions/pi-safety/AGENTS.md`),
  `diagnose:guardian` = `jiti scripts/guardian-srt-diagnostic.ts`
  (read-only, deterministic local reviewer stub), `lint` = `biome check
  .`, `preflight:sibling` = `node scripts/preflight-sibling.mjs`,
  `test` = `vitest --run`.
- `statusline` (`extensions/statusline/package.json:5-7`): `test` =
  `node --experimental-strip-types --test tests/*.test.ts` (Node's
  built-in runner, no vitest).
- `shared-tool-presentation` (`packages/shared-tool-presentation/package.json:10-13`):
  `check` = `tsc --noEmit`, `test` = `npx vitest --run`.
- `tool-result-budget`: no scripts at all
  (`extensions/tool-result-budget/package.json` has no `scripts` key).

**`preflight:sibling`.** `scripts/preflight-sibling.mjs` checks the
sibling `packages/shared-tool-presentation` checkout: it fails closed
when the shared package is absent, is not a git repo, or has a dirty
working tree (`extensions/pi-safety/scripts/preflight-sibling.mjs:11-61`).
Because the shared package is a subtree of the monorepo, the script
scopes `git status --porcelain` to the shared subtree
(`extensions/pi-safety/scripts/preflight-sibling.mjs:31-37`). It does
not pin a SHA; it reports the sibling revision so test results are
attributable.

**CI.** Only `extensions/pi-core` has CI:
`extensions/pi-core/.github/workflows/ci.yml` runs on push to `main`
and on pull requests, with `pnpm install --frozen-lockfile`, then
`pnpm run check`, `pnpm run lint`, `pnpm run test` (Node 22, pnpm
setup). `pi-safety`'s AGENTS.md states plainly: "There is no CI; green
checks are voluntary until a remote gate exists."

**Biome.** `extensions/pi-core/biome.json` and
`extensions/pi-safety/biome.json` (both Biome 2.5.4) are nearly
identical: 2-space indent, width 100, double quotes, trailing commas,
`noExplicitAny`/`noConsole`/`noNonNullAssertion` as errors, with
`tests/**` relaxing only `noExplicitAny` and `noNonNullAssertion`
(`noConsole` stays on). Both use the VCS integration
(`useIgnoreFile: true`) and exclude `node_modules`, `docs`, and local
dirs. There is no root `biome.json`.

**Sibling-clean acceptance requirement.** `pi-safety`'s AGENTS.md
("Acceptance for a revision") requires `npm run preflight:sibling` to
pass first (sibling `pi-core`/shared package present and clean), then
`check`, `lint`, and `test`; a dirty-sibling run is "provisional/blocked,
never acceptance — even if check/lint/test are green."

## Documentation map

This `docs/` directory is new and lives **only at the monorepo root**.
Per-extension `docs/` directories were removed (git rm) in this change;
the root previously held `docs/pi-suite-architecture-design.md`, also
removed. Companion files written concurrently:

- `docs/pi-safety.md` — the pi-safety member: permission modes, the
  guardian reviewer, sandbox enforcement, the permission-rule layer
  (`src/permissions/`), and its product boundaries.
- `docs/pi-core.md` — the pi-core member: the TUI module map
  (`src/tui/*`), the register facade, and the `standalone.ts`
  cross-extension surface.
- `docs/statusline-and-tool-result-budget.md` — the two small members:
  the statusline footer layout/palette and the tool-result-budget
  clipping/spill behaviour.

The per-package READMEs remain in-tree (`extensions/*/README.md`,
`extensions/pi-core/README.md` points at `docs/pi-core.md`).

## AGENTS.md situation

`AGENTS.md` files exist on disk at `extensions/pi-core/AGENTS.md` and
`extensions/pi-safety/AGENTS.md`, but **there is no root `AGENTS.md`**
(`ls AGENTS.md` fails), and **none are tracked by git** — `git
ls-files '*AGENTS.md'` returns nothing. The reason is the user's
global gitignore: `/Users/x1a2h1/.gitignore_global:12` lists
`AGENTS.md`, and `git check-ignore -v` confirms all three paths match
that rule. Consequences:

- A fresh clone does **not** get these files — they are local-only
  guidance, not part of the repo. Anything a new contributor needs must
  live in `README.md` or `docs/`.
- The two on-disk files are therefore the authoritative local agent
  guidance for those two members (commands, product boundaries, layout
  conventions, acceptance procedure), but they are invisible to anyone
  who clones the repo.

Note: the two `AGENTS.md` files used to reference deleted per-extension docs
(`docs/host-api-boundaries.md`, `docs/research/`, `docs/architecture.md`).
Those references have been repointed — to this root `docs/` set, to the
"Product boundaries" section of `extensions/pi-safety/AGENTS.md`, and (for the
research archive) to git history at commit `96da0b4`. Both files are gitignored
by `~/.gitignore_global`, so they are local-only and never reach a clone.

## Repo shape at a glance

- 265 tracked files. One of them is `packages/shared-tool-presentation/node_modules`,
  a tracked symlink (git mode `120000`) to `../../extensions/pi-core/node_modules`
  — so `node_modules` is not uniformly gitignored; this one path is in the tree.
  Excluding it, 264.
- Tracked source lines across the five members: 32,121 for `.ts`/`.mts`, 33,340
  including the `.mjs` files. Total tracked content is 75,438 lines; the gap is
  mostly tests (33,614) plus the two `pnpm-lock.yaml` files (4,898).
- Everything is ESM (`.ts`), loaded directly by pi's `jiti`; the only
  non-TS sources are `pi-safety`'s two `.mjs` Guardian worker files
  (`src/guardian-worker.mjs`, `src/guardian-worker-limits.mjs`) and its
  `scripts/*.mjs` helpers. The remaining non-code tracked files are the
  two `LICENSE` files and three `.gitignore` files.
