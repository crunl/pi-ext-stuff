# pi-safety

> English · 中文说明: [`README.zh-CN.md`](README.zh-CN.md)

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

## How one tool call flows

Every `bash` / `write` / `edit` call walks the same pipeline. Each layer can
only *narrow* what the next one sees — nothing downstream can widen it.

```text
 your tool call
      │
 ① prepare ──────────── activation + snapshot: which mode, which policy
      │
 ② static risk ──────── lexer → AST → segments: can we PROVE this safe?
      │                  (unproven ≠ dangerous; it just needs a judge)
 ③ engine admission ─── is this call shape even admissible?
      │
 ④ guardian review ──── external LLM judge approves what ② couldn't prove
      │
 ⑤ capability lease ─── sandboxed | escalated | unrestricted
      │
 ⑥ SRT sandbox ──────── kernel enforcement (seatbelt / bwrap)
      │
   the command actually runs
```

| Layer | Decides | Fails as |
|---|---|---|
| ① prepare | mode, policy, snapshot | `stale-invocation` |
| ② static risk | provable-safe vs needs-review | `policy-denied` |
| ③ admission | call shape valid | `policy-denied` |
| ④ guardian | approve / deny | `review-denied`, retriable via `/approve` |
| ⑤ lease | which backend executes | `enforcement-unavailable` |
| ⑥ SRT | kernel says yes/no **while running** | command's own error, or timeout |

Layers ②–⑥ are skipped entirely in `yolo` (⑥ too — nothing is sandboxed).
Host-first tools (`read`/`grep`/`find`/`ls`) only see ① and a deny-rule check;
foreign (MCP/custom) tools see none of it.

**⑥ is the only layer that acts after the command starts.** A denial there
looks like the command's own failure — often a hang until timeout, not a clean
error. When that happens the footer shows `SRT diagnostic observations`, which
are *bounded, possibly sanitized, and never authorization evidence*.

The sandbox policy itself is not produced by ②–⑤: `createSandboxRuntimeConfig`
projects `safety.json`'s `sandbox` section straight into the policy at
activation time (session start, turn start, mode change). The guardian runs
under its own separate read-only, zero-network policy.

Full walkthrough: [`docs/pi-safety.md`](../../docs/pi-safety.md).

## Install

```bash
pi install ~/path/to/pi-ext-stuff/extensions/pi-safety
```

Consumes presentation helpers from `packages/shared-tool-presentation`
(shared Codex tool rendering surface).

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

Imports presentation helpers from `packages/shared-tool-presentation` only.
Emits `pi-safety:mode` (also `:review`, `:delegation`) on the event
bus, which `statusline` listens to.

## Development

```bash
npm run check && npm run lint && npm test
```

See [`AGENTS.md`](AGENTS.md) (commands, product boundaries, layout) and
[`docs/pi-safety.md`](../../docs/pi-safety.md) for the full extension walkthrough.

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
