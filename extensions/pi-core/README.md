# pi-core

An opinionated personal core extension pack for the pi coding agent:
Codex-style tool rendering, a live token rate in the working indicator,
edit-diff previews, and a boxed editor carrying the permissions-mode badge.
Distributed as `.ts` sources — pi loads extensions directly, so there is
**no build step**.

## Features

- **Codex-style tool presentation** — `read` / `grep` / `find` / `ls` /
  `write` / `edit` / `bash` calls render with icons, verbs, and collapsed
  summaries, including a live diff box for file edits. In core-only interactive
  TUI sessions, pi-core decorates canonical `bash` / `write` / `edit` only when
  their public metadata and builtin owner marker match. Permission extensions
  retain execution ownership when installed.
- **Working token rate** — the streaming spinner in the footer shows the
  current output speed (`⠋ Working  50 tok/s`). Uses the provider's
  reported usage when available; falls back to a CJK-aware character
  estimate (marked with `≈`) otherwise.
- **Boxed editor with mode badge** — the editor sits in a rounded box whose
  top border carries the permissions-mode badge (`auto` / `yolo`), colored by
  severity from pi-safety's `pi-safety:mode` bus event. Implemented as an
  official `CustomEditor` subclass via `setEditorComponent` — no host
  prototype patching.
- **Edit diff summary** — colorized `+/-` summaries for `edit` tool results.
- **Output padding sync** — keeps the tool-output viewport aligned with the
  editor layout.

Everything else renders with Pi's stock components: user messages, thinking
blocks, markdown code fences, autocomplete placement, and selector panels all
follow host defaults. (Earlier revisions patched those prototypes; the patches
were removed in favour of stock rendering wherever Pi exposes no public hook.)

## Requirements

- Node.js ≥ 22.19.0 (the minimum required by Pi 0.84.1).
- Pi 1.1.0. The host supplies the peer packages; development dependencies are
  pinned to 1.1.0 so API checks are reproducible.
- **No third-party runtime dependencies** — only the pi core packages
  (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, provided by
  the host) and Node built-ins. No external executables are invoked.

## Install

From a local checkout of this monorepo:

```bash
pi install /path/to/pi-ext-stuff/extensions/pi-core
```

Not installable as a git package (pi's source parser has no subdirectory
support) and not published to npm yet (still `private`).

## Development

```bash
npm run check    # tsc --noEmit
npm run lint     # biome check .
npm run format   # biome check --write .
npm run test     # vitest --run
```

Tests are flat `tests/*.test.ts` files mirroring `src/tui/*` by basename.
The `core-builtin-presentation` flag (`auto`/`off`, default `auto`) and SDK
compatibility boundaries are documented in `AGENTS.md` — SDK hosts injecting
non-file-backed tool configuration should set it to `off`.

## Architecture

- `index.ts` — package entry; loads the register graph. Default-exports
  `registerExtension(pi)`.
- `standalone.ts` — **side-effect-free** cross-extension surface. Other
  extensions (e.g. `pi-safety`) must import from here,
  never from `index.ts` or `src/**` deep paths, to avoid double-registering
  and pulling the register graph into their jiti instance.
- `src/register.ts` — orchestration facade; calls every `register*` once,
  in order.
- Module naming in `src/tui/*`: `create*` = pure factories, `register*` =
  extension hooks. No `apply*`/`install*` host patches remain.

See [`docs/pi-core.md`](../../docs/pi-core.md) for the full module map.

## License

MIT
