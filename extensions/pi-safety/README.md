# pi-safety

Permission modes (`auto` / `yolo`) for the pi coding agent, with sandboxed
tool execution and an external guardian reviewer that approves risky actions
on your behalf. Distributed as `.ts` sources — pi loads extensions directly,
so there is **no build step**.

## Features

- **Permission modes** — `auto` asks the guardian reviewer to approve risky
  actions for you; `yolo` runs unrestricted. (The old human-popup
  `default`/`plan` modes are retired.)
- **Sandboxed execution** — `bash` / `write` / `edit` run inside an
  OS-enforced sandbox (workspace-write by default). Public network access is
  reviewed automatically at the connection boundary.
- **Guardian reviewer** — an external LLM judge re-examines anything the
  static policy cannot prove safe. Denied actions can be retried exactly once
  with `/approve`.

## Install

```bash
pi install ~/path/to/pi-ext-stuff/extensions/pi-safety
```

Requires [`pi-core`](../pi-core) (shared presentation surface); see
[Relationship](#relationship) below.

## Config / commands

Runtime config lives at `~/.pi/agent/safety.json` (or
`$PI_CODING_AGENT_DIR/safety.json`). Copy
[`config.example.json`](config.example.json) there and trim to what you need —
a minimal starting point is `sandbox.enabled: true` with the default
workspace-write profile and empty `rules`.

- `/approve` — authorize one exact retry of a recent auto-review denial.
- `request_permissions` tool — ask for a turn-scoped filesystem or network
  grant instead of retrying blindly.

## Relationship

Imports presentation helpers from `pi-core/standalone.ts` only — never the
reverse. Emits `pi-safety:mode` (also `:review`, `:delegation`) on the event
bus, which `statusline` listens to.

## Development

```bash
npm run check && npm run lint && npm test
```

See [`AGENTS.md`](AGENTS.md) (commands, product boundaries, layout) and
[`docs/host-api-boundaries.md`](docs/host-api-boundaries.md).

## Migrating from `pi-permissions` (renamed September 2026)

All paths below are relative to your agent directory —
`$PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`. Export it once:

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
```

Make three edits, in this order, with no new pi session started in between
(a half-renamed state leaves guardian protection offline):

1. Update the settings entry so pi can locate the package. If you installed
   via `pi install`, the entry is a path in `$AGENT_DIR/settings.json`:
   replace the `extensions/pi-permissions` segment with
   `extensions/pi-safety`. If you symlinked the package into
   `$AGENT_DIR/extensions/` instead, re-point that symlink at the new
   directory. Do not keep both entries — path-based dedup would load the
   package twice and the duplicate tool registrations collide.
2. Move the config file (a pure extension convention the host knows nothing
   about):
   ```bash
   mv "$AGENT_DIR/permissions.json" "$AGENT_DIR/safety.json"
   ```
   There is no legacy fallback: after the rename the extension reads
   `safety.json` only, so a skipped move silently reverts to the default
   config and your deny rules and network restrictions stop applying.
3. Start a new pi session. Permission-mode state from the old
   `pi-permissions-state` name is intentionally not migrated — losing it is
   fail-closed. Re-set the mode if you had changed it.

Old session logs under `$AGENT_DIR/sessions/` still mention
`pi-permissions`; they are the audit trail and are not rewritten.
