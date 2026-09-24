# pi-ext-stuff

Four extensions for the pi coding agent, developed together in one repo but
loadable independently. Everything ships as `.ts` sources — pi loads extensions
directly, so there is **no build step** in any package.

## Packages

- **[`pi-core`](extensions/pi-core)** — Codex-style tool presentation, live
  token rate, edit-diff previews, TUI polish.
- **[`pi-safety`](extensions/pi-safety)** — permission modes (`auto` / `yolo`)
  with sandboxed tool execution and a guardian reviewer.
- **[`statusline`](extensions/statusline)** — boxed editor frame carrying
  token, model, and effort info.
- **[`tool-result-budget`](extensions/tool-result-budget)** — per-turn
  tool-result size limit with spill files.

Each package README covers install, config, and usage — start there.

## How they relate

```text
[pi-core]──standalone.ts──┬──> [pi-safety] ──mode/review──> [statusline]
                          └──> [statusline]
[tool-result-budget] standalone (no cross-package imports)
```

`pi-core` is required by `pi-safety` and `statusline`; it imports nothing back.

## Installing

```bash
pi install ~/path/to/pi-ext-stuff/extensions/pi-core
pi install ~/path/to/pi-ext-stuff/extensions/pi-safety
pi install ~/path/to/pi-ext-stuff/extensions/statusline
pi install ~/path/to/pi-ext-stuff/extensions/tool-result-budget
```

Not installable as a git package (no subdirectory support — use a local
path), not published to npm yet (all `private`), and load each extension
exactly once (symlink + settings entry loads it twice).

Upgrading from the renamed `pi-permissions`? See
[`pi-safety` migration](extensions/pi-safety/README.md#migrating-from-pi-permissions-renamed-september-2026).

## Published append-prompt

[`APPEND_SYSTEM.md`](APPEND_SYSTEM.md) is this machine's global pi
append-prompt, versioned here (the home copy is a symlink to this file).

`main` is this monorepo. The tag `pre-monorepo-pi-core` preserves the
pre-monorepo single-package history of pi-core.
