# pi-ext-stuff

> English · 中文说明（看图版）: [`README.zh-CN.md`](README.zh-CN.md)

Four extensions for the pi coding agent, developed together in one repo but
loadable independently. Everything ships as `.ts` sources — pi loads extensions
directly, so there is **no build step** in any package.

## Packages

- **[`pi-core`](extensions/pi-core)** — live token rate, boxed editor with mode
  badge, and `/effort` + `/exit` commands.
- **[`pi-tool-render`](extensions/pi-tool-render)** — Codex-style tool
  presentation, edit-diff previews, and `codemode` clickable tree rendering.
- **[`pi-safety`](extensions/pi-safety)** — permission modes (`auto` / `yolo`)
  with sandboxed tool execution and a guardian reviewer.
- **[`statusline`](extensions/statusline)** — boxed editor frame carrying
  token, model, and effort info.

Each package README covers install, config, and usage — start there.

## How they relate

```text
[shared-tool-presentation] ──┬──> [pi-tool-render]
                             ├──> [pi-core] <──mode── [pi-safety] ──mode/review──> [statusline]
                             ├──> [pi-safety]
                             └──> [statusline]
```

`packages/shared-tool-presentation` is the shared pure leaf; `pi-tool-render`,
`pi-core`, `pi-safety`, and `statusline` import nothing back from each other.

## Installing

```bash
pi install ~/path/to/pi-ext-stuff/extensions/pi-core
pi install ~/path/to/pi-ext-stuff/extensions/pi-tool-render
pi install ~/path/to/pi-ext-stuff/extensions/pi-safety
pi install ~/path/to/pi-ext-stuff/extensions/statusline
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
