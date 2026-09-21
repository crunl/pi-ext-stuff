# pi-ext-stuff

Three extensions for the pi coding agent, developed together in one repo but
loadable independently. Everything ships as `.ts` sources — pi loads extensions
directly, so there is **no build step** in any package.

## Packages

- **[`pi-core`](extensions/pi-core)** — Codex-style tool presentation, a live
  token rate in the working indicator, edit-diff previews, and assorted TUI
  polish. ([README](extensions/pi-core/README.md),
  [architecture](extensions/pi-core/docs/architecture.md))
- **[`pi-permissions`](extensions/pi-permissions)** — permission modes
  (`auto` / `yolo`) with sandboxed tool execution and an external guardian
  reviewer that approves on your behalf.
  ([AGENTS.md](extensions/pi-permissions/AGENTS.md),
  [host API boundaries](extensions/pi-permissions/docs/host-api-boundaries.md))
- **[`statusline`](extensions/statusline)** — rebuilds the footer as a boxed
  editor frame carrying token, model, and effort information.
  ([README](extensions/statusline/README.md),
  [palette research](extensions/statusline/docs/))

## How the packages relate

`pi-permissions` and `statusline` both consume the side-effect-free surface in
`pi-core/standalone.ts`:

| Consumer | Imports from `pi-core/standalone.ts` |
| --- | --- |
| `pi-permissions` | `codexBashToolSpec`, `codexEditToolSpec`, `codexWriteToolSpec`, `createCodexToolRendering` |
| `statusline` | `applyAutocompleteAbove` |

So `pi-core` is not optional for the other two. `pi-core` imports nothing back.
The only reverse direction is the event bus: `pi-permissions` emits
`pi-permissions:mode` (also `:review` and `:delegation`), and `statusline`
listens for `pi-permissions:mode`.

## Installing

pi reads extension sources from `~/.pi/agent/settings.json`. Point it at each
package directory:

```bash
pi install ~/path/to/pi-ext-stuff/extensions/pi-core
pi install ~/path/to/pi-ext-stuff/extensions/pi-permissions
pi install ~/path/to/pi-ext-stuff/extensions/statusline
```

`pi install` stores the path relative to the settings file, so the entries keep
working if the whole home directory moves, as long as the layout is preserved.

Three things worth knowing before you try:

- **Not installable as a git package.** pi's source parser has no subdirectory
  support, so `git:github.com/crunl/pi-ext-stuff/extensions/pi-core` is read as
  a repository URL and fails. Use a local path, or npm once published.
- **Not published to npm yet.** All three packages are still `private`, and
  `pi-permissions` and `statusline` reach into `pi-core` by relative path, which
  a published tarball would not contain.
- **One loading mechanism per extension.** A package that is both symlinked into
  `~/.pi/agent/extensions/` and listed in `settings.json` gets loaded twice —
  deduplication compares resolved paths, not real paths.

## Layout

```
extensions/
  pi-core/          shared TUI surface and core presentation
  pi-permissions/   permission modes, sandbox, guardian reviewer
  statusline/       footer and status line rendering
```

`main` is this monorepo. `pi-core-archive` preserves the pre-monorepo
single-package history of pi-core — 81 commits with their original SHAs.
