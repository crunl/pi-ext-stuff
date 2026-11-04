# pi-tool-render

Codex-style tool presentation and `codemode` clickable tree rendering for the
pi coding agent. Distributed as `.ts` sources — pi loads extensions directly,
so there is **no build step**.

## Features

- **Codex-style tool presentation** — `read` / `grep` / `find` / `ls` /
  `write` / `edit` / `bash` calls render with icons, verbs, and collapsed
  summaries, including a live diff box for file edits. In interactive TUI
  sessions without a permission extension, `pi-tool-render` decorates canonical
  `bash` / `write` / `edit` only when their public metadata and builtin owner
  marker match. Permission extensions (such as `pi-safety`) retain execution
  ownership when installed.
- **Codemode tree rendering** — shadow-registers `codemode` with an interactive,
  clickable tree view for nested tool calls, script source, output, and
  generated image blocks while keeping upstream `execute` and `prepareLoadout`
  verbatim.
- **Output padding sync** — watches `settings.json` `outputPad` and keeps the
  tool-output viewport aligned with the editor layout across extensions.

## Requirements

- Node.js ≥ 22.19.0.
- Pi 1.5.0. The host supplies the peer packages; development dependencies are
  pinned to 1.5.0 so API checks are reproducible.
- **No third-party runtime dependencies** — only the pi core packages
  (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, provided by
  the host), `packages/shared-tool-presentation`, and Node built-ins.

## Install

From a local checkout of this monorepo:

```bash
pi install /path/to/pi-ext-stuff/extensions/pi-tool-render
```

## Development

```bash
npm run check    # tsc --noEmit
npm run lint     # biome check .
npm run format   # biome check --write .
npm run test     # vitest --run
```

The `core-builtin-presentation` flag (`auto`/`off`, default `auto`) and SDK
compatibility boundaries are documented in `AGENTS.md` — SDK hosts injecting
non-file-backed tool configuration should set it to `off`.

## Architecture

- `index.ts` — package entry; loads the register graph. Default-exports
  `piToolRender(pi)`.
- `standalone.ts` — **side-effect-free** cross-extension surface re-exporting
  `packages/shared-tool-presentation` and `markToolCall`.
- `src/register.ts` — orchestration facade; calls `registerOutputPaddingSync` →
  `registerCodexToolRendering` → `registerCodemodeTreeTool` →
  `registerCanonicalBuiltinFallback` in order.

## License

MIT
