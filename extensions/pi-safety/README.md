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

Every `bash` / `write` / `edit` call walks the same pipeline: six steps, but
only **three decisions**. The others set up (①), project (③), or derive (⑤) —
they never grant or withhold authority on their own. Each step can only
*narrow* what the next one sees; nothing downstream can widen it.

```text
 your tool call
      │
 ① prepare ──────────── setup: activation + snapshot (mode, policy)
      │
 ② static risk ──────── DECISION: can we PROVE this safe?
      │                  (lexer → AST → segments; unproven ≠ dangerous)
 ③ admission ────────── projection: risk verdict → engine vocabulary
      │
 ④ guardian review ──── DECISION: external LLM judge (only when ② can't prove)
      │
 ⑤ capability lease ─── derivation: sandboxed | host-admitted | unrestricted
      │
 ⑥ SRT sandbox ──────── DECISION: kernel enforcement (seatbelt / bwrap)
      │
   the command actually runs
```

| Step | Role | Decides / does | Fails as |
|---|---|---|---|
| ① prepare | setup | activation + snapshot: mode, policy (once per turn; cached hits are free) | `stale-invocation` |
| ② static risk | **decision** | provable-safe vs needs-review | `policy-denied` |
| ③ admission | projection | risk verdict → engine vocabulary, plus shape validation — "a projection, not an authorization decision" | `policy-denied` |
| ④ guardian | **decision** | approve / deny — skipped when ② proved safe; auto-approved short-circuit in yolo | `review-denied`, retriable via `/approve` |
| ⑤ lease | derivation | which backend executes: sandboxed / host-admitted / unrestricted | `enforcement-unavailable` |
| ⑥ SRT | **decision** | kernel says yes/no **while running** | command's own error, or timeout |

Steps ②–⑥ are enforcement; in `yolo` ② is skipped and ④ auto-approves,
while ①/③/⑤ still run and ⑥ executes unsandboxed (bare, no SRT wrap).
Host-first tools (`read`/`grep`/`find`/`ls`) only see ① and a deny-rule check;
foreign (MCP/custom) tools see none of it.

**⑥ is the only step that acts after the command starts.** A denial there
looks like the command's own failure — often a hang until timeout, not a clean
error. When that happens the footer shows `SRT diagnostic observations`, which
are *bounded, possibly sanitized, and never authorization evidence*.

The sandbox policy itself is not produced by ②–⑤: `createSandboxRuntimeConfig`
projects `safety.json`'s `sandbox` section straight into the policy at
activation time (session start, turn start, mode change). The guardian runs
under its own separate read-only, zero-network policy.

That activation-time policy is fixed until the next activation boundary; it is
not rebuilt per call. One part of it is refreshed per execution: before ⑥ runs,
`policyWithGitMetadataProtection` re-discovers the Git metadata roots for the
*request's* cwd (which can differ from the activation cwd after a `cd`, a
worktree switch, or a submodule checkout) and appends their `hooks`/`config`
denies to a copy of the policy. The copy is skipped entirely when it would add
nothing.

## What the sandbox denies inside Git metadata

Only the Git *code-execution* surfaces of each discovered metadata root are
denied — `<root>/hooks` and `<root>/config`. History paths (`objects`, `refs`,
`index`, `logs`) stay writable so a commit runs inside the sandbox without an
approval round trip. Everything else — `HEAD`, `packed-refs`, `worktrees/`,
`modules/`, `info/attributes`, and the `.git` pointer file of a worktree or
submodule — is **not** denied.

That gap is deliberate. A git metadata write the sandbox refuses surfaces as
`EPERM`, and that error is final: there is no command-level escalation
parameter. The remedies are a narrower
`sandbox_permissions=with_additional_permissions` write where the target allows
one, `request_permissions`, or the user switching to yolo; the bash tool
description states this. Widening the deny list would force every commit through
one of those routes instead, and the pointer file cannot be denied on shape
alone without re-deriving "directory vs `gitdir:` file" inside
`sandbox-policy.ts`, which sits in the engine value-closure and must stay free
of `node:fs` (`tests/structure-invariants.test.ts:188-221`).

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
