# pi-core

An opinionated personal core extension pack for the pi coding agent:
Codex-style tool rendering, a live token rate in the working indicator,
edit-diff previews, and assorted TUI polish. Distributed as `.ts` sources —
pi loads extensions directly, so there is **no build step**.

## Features

- **Codex-style tool presentation** — `read` / `grep` / `find` / `ls` /
  `write` / `edit` / `bash` calls render with icons, verbs, and collapsed
  summaries, including a live diff box for file edits.
- **Working token rate** — the streaming spinner in the footer shows the
  current output speed (`⠋ Working  50 tok/s`). Uses the provider's
  reported usage when available; falls back to a CJK-aware character
  estimate (marked with `≈`) otherwise.
- **Autocomplete above the editor** — completion list floats above the input
  area; Shift+Tab anchors selector navigation.
- **Edit diff summary** — colorized `+/-` summaries for `edit` tool results.
- **Output padding sync** — keeps the tool-output viewport aligned with the
  editor layout.
- **Markdown code frame** — consistent code-block framing in chat output.

## Requirements

- Node.js ≥ 22.19.0 (the minimum required by Pi 0.84.1).
- Pi 0.84.1. The host supplies the peer packages; development dependencies are
  pinned to 0.84.1 so API checks are reproducible.
- **No third-party runtime dependencies** — only the pi core packages
  (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, provided by
  the host) and Node built-ins. No external executables are invoked.

## Install

From a git repository:

```bash
pi install git:github.com/crunl/pi-core@main
```

Or from a local checkout:

```bash
pi install /path/to/pi-core
```

## Development

```bash
npm run check    # tsc --noEmit
npm run lint     # biome check .
npm run format   # biome check --write .
npm run test     # vitest --run
```

Tests are flat `tests/*.test.ts` files mirroring `src/tui/*` by basename.
`tests/pi-api-compat.test.ts` pins the few runtime seams for which Pi does not
yet expose an equivalent extension API.

## Architecture

- `index.ts` — package entry; loads the register graph. Default-exports
  `registerExtension(pi)`.
- `standalone.ts` — **side-effect-free** cross-extension surface. Other
  extensions (e.g. `pi-permissions`, `statusline`) must import from here,
  never from `index.ts` or `src/**` deep paths, to avoid double-registering
  and pulling the register graph into their jiti instance.
- `src/register.ts` — orchestration facade; calls every `register*` once,
  in order.
- Module naming in `src/tui/*`: `create*` = pure factories, `apply*` /
  `install*` = host patches, `register*` = extension hooks.

See `docs/architecture.md` for the full module map.

## License

MIT
