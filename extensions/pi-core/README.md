# pi-core

An opinionated personal core TUI extension pack for the pi coding agent:
a boxed editor carrying the permissions-mode badge, a live token rate in the
working indicator, and `/effort` + `/exit` slash commands.
Tool rendering and `codemode` tree presentation live in the sibling
[`pi-tool-render`](../pi-tool-render) extension. Distributed as `.ts` sources —
pi loads extensions directly, so there is **no build step**.

## Features

- **Boxed editor with mode badge** — the editor sits in a rounded box whose
  top border carries the permissions-mode badge (`auto` / `yolo`), colored by
  severity from pi-safety's `pi-safety:mode` bus event. Implemented as an
  official `CustomEditor` subclass via `setEditorComponent` — no host
  prototype patching.
- **Working token rate** — the streaming spinner in the footer shows the
  current output speed (`⠋ Working  50 tok/s`). Uses the provider's
  reported usage when available; falls back to a CJK-aware character
  estimate (marked with `≈`) otherwise.
- **`/effort` and `/exit` commands** — `/effort` opens Pi's native
  `ThinkingSelectorComponent` in the editor slot; `/exit` is a true alias for
  `/quit`.

Everything else renders with Pi's stock components: user messages, thinking
blocks, markdown code fences, autocomplete placement, and selector panels all
follow host defaults.

## Requirements

- Node.js ≥ 22.19.0 (the minimum required by Pi 0.84.1).
- Pi 1.2.0. The host supplies the peer packages; development dependencies are
  pinned to 1.2.0 so API checks are reproducible.
- **No third-party runtime dependencies** — only the pi core packages
  (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
  `@earendil-works/pi-ai`, provided by the host) and Node built-ins.

## Install

From a local checkout of this monorepo:

```bash
pi install /path/to/pi-ext-stuff/extensions/pi-core
pi install /path/to/pi-ext-stuff/extensions/pi-tool-render
```

## Development

```bash
npm run check    # tsc --noEmit
npm run lint     # biome check .
npm run format   # biome check --write .
npm run test     # vitest --run
```

## Architecture

- `index.ts` — package entry; loads the register graph. Default-exports
  `piCore(pi)`.
- `src/register.ts` — orchestration facade; calls `registerEditorChrome`,
  `registerEffortCommand`, `registerExitCommand`, and `registerWorkingTokenRate`.

See [`docs/pi-core.md`](../../docs/pi-core.md) for the full module map.

## License

MIT
