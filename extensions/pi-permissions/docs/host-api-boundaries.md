# Host API boundaries for Approve for me

**Standing Codex pin:** `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`  
**Pi host pin:** `@earendil-works/pi-coding-agent@0.85.1`

This note records what the Pi host Extension API can and cannot express. It is
the product boundary for Approve for me — not a wishlist.

## Host intent

Pi host does **not** ship a built-in permission mode, approval ledger, or OS
sandbox.

- No built-in sandbox (`docs/security.md` in the host package)
- No built-in permission popups / plan mode (`docs/usage.md`)
- Project trust is not a sandbox

Approve for me is therefore implemented entirely inside this extension: tool
overrides, `tool_call` preflight, Engine grants, Guardian worker, SRT.

## Two execution channels

```text
Owned tools (enforceable)
  bash / write / edit / request_permissions
    → pi.registerTool() same-name override
    → Engine + sandboxed lease (SRT) or one-shot escalated lease

Host-only tools (review-only)
  MCP / custom tools (including UI-question style tools) / other host tools
    → pi.on("tool_call") may block
    → after allow, host runs the original tool with native process authority
    → sandboxEnforcesAction = false
```

Evidence in this extension:

- Host preflight: `src/register.ts` `authorizeHostTool` — approve returns
  `undefined` and the host tool continues; deny returns `{ block: true }`.
- Owned execution: `src/register.ts` re-registers `bash` / `write` / `edit` /
  `request_permissions` with Engine-backed `execute`.
- Review context: `src/pi-approve-for-me-adapters.ts` sets
  `sandboxEnforcesAction` false for `host-admitted` and `escalated`.

Do not claim that a Guardian approval sandboxes an MCP/custom tool. The
approval only satisfies the review gate for that exact call.

## Parallel tool calls vs attempt freeze

Host semantics (`docs/extensions.md` in the host package):

- Sibling tool calls in one assistant message are **preflighted sequentially**
  and **executed concurrently**.
- A `tool_call` handler is not guaranteed to see sibling results from the same
  message in `ctx.sessionManager`.

Approve for me freeze point:

- Authority freezes at **execution-attempt creation after action review**,
  not at invocation submission.
- A still-reviewing invocation may observe an intervening turn grant when its
  first attempt is created.
- An already-created attempt is never expanded retroactively.
- A later attempt is never an automatic replay of an earlier Bash denial.

`request_permissions` tool description in `src/register.ts` states this
contract to the model.

## What the host does not provide

| Missing host primitive | Extension substitute | Consequence |
| --- | --- | --- |
| Approval policy / reviewer axis | `PermissionMode = auto \| yolo` + Guardian | No human-first first-class mode |
| Turn/session grant store | Engine turn amendments, cleared at turn end | No session-scoped grant |
| Sandbox adapter | Pinned SRT 0.0.74 + connect guard | Backend/platform capability gates remain |
| `request_permissions` protocol | Extension-registered tool | Shape is Pi-specific |
| Approval handoff-to-user event | `/approve` after denial only | Guardian does not AskUser |
| Runtime reviewer switch | Mode cycle shortcut / commands | No mid-turn User ↔ AutoReview flip |

These are deliberate boundaries, not unfinished host features. Closing a gap
requires either an extension-side product decision or a new host API; do not
paper over them in docs as if the host already offered them.

## API surfaces this extension does use

| API | Use |
| --- | --- |
| `pi.on("tool_call")` | Block or pass host-only tools after risk/Guardian |
| `pi.registerTool()` | Own bash/write/edit/request_permissions execution |
| `ctx.ui.setStatus` | Approve for me / Full access |
| `ctx.ui.confirm/select/notify` | `/approve` and mode notices (not the default Auto path) |
| `ctx.abort()` | Circuit-breaker turn interrupt |
| session/agent lifecycle events | Turn snapshot, grant expiry, cleanup |
| `pi.registerCommand` / `registerShortcut` | `/approve`, `/permissions`, mode cycle |
| `pi.sendMessage` | Exact one-shot `/approve` retry instruction |

## Implications for future work

1. **Do not schedule host-tool sandboxing** as an Approve for me subtask. It
   needs a host `operations`-style seam or ownership of every host tool.
2. **Do not add session grants** without an explicit product decision; a
   second mutable ledger is forbidden by the Engine design.
3. **Do not implement Guardian AskUser** unless fail-closed-to-human is an
   intentional product mode. Host UI can host it; host approval state cannot.
4. **Claims in tests and delivery audits must name the channel.** Owned-tool
   enforcement is not host-admission enforcement.
