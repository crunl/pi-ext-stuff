# Host API boundaries for Approve for me

**Standing Codex pin:** `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`  
**Pi host pin:** `@earendil-works/pi-coding-agent@0.86.0`  
**SRT pin:** `@anthropic-ai/sandbox-runtime@0.0.77` (pristine; no patch)

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

## Governance channels (owned / host-first B / foreign A)

Product scope (2026-09-19): this extension governs **Pi built-in tools**.
Foreign MCP/custom tools are **out of scope**. Host-first read-only tools use
**B: static rules deny only** — no Engine, no Guardian.

```text
Owned tools (enforceable)
  bash / write / edit / request_permissions
    → pi.registerTool() same-name override
    → Engine + sandboxed lease (SRT) or one-shot escalated lease

Host-first tools (B: rules deny only)
  read / grep / find / ls
    → pi.on("tool_call") host-first branch
    → matchRules(config.rules): deny → { block: true, reason }
    → ask / allow / no match → undefined (host native)
    → never Engine / Guardian; no sandbox ownership
    → rules.ask is ignored on this channel; empty rules = no extra gate

Foreign tools (A: out of scope)
  MCP / custom tools / other extension-registered tools
    → pi.on("tool_call") returns undefined
    → host runs the original tool with native process authority
    → this extension contributes no review gate

Residual special (product gate, not foreign)
  subagent
    → tool_call still runs checkDelegateSpawn (depth / re-delegation)
    → then same host-first B (rules deny only)

yolo (unrestricted preflight)
  → tool_call returns undefined for host-first and subagent
  → skips B deny and subagent spawn gate (owned yolo also skips static risk)
  → explicit product exception; not a silent capability drop
```

Evidence in this extension:

- Host-first / special preflight: `src/register.ts` `evaluateHostFirstToolCall`
  and `evaluateHostFirstRulesOnly` in `src/risk-policy.ts` — deny returns
  `{ block: true, reason }`; otherwise the host tool continues.
- Owned execution: `src/register.ts` re-registers `bash` / `write` / `edit` /
  `request_permissions` with Engine-backed `execute`.
- Escalated review context: `src/pi-approve-for-me-adapters.ts` still sets
  `sandboxEnforcesAction` false for `escalated` (owned one-shot outside SRT).

Host-first B does **not** submit Engine authorization decisions or Guardian
reviews. It may still load/activate permission config lifecycle state so
`rules[]` are readable; that is not a grant.

Do not claim that owned-tool sandboxing covers host-first or foreign tools.
Host-first B is only a **user-configured static deny**; it is not a sandbox
and not an approval gate.

**Ask-user is orthogonal to Approve for me.** Codex `request_user_input` and
MCP elicitation still pause the turn under `OnRequest + AutoReview`; the
reviewer axis only replaces *who approves permissions*, not whether the agent
may ask conversational questions. Foreign question-style tools are out of
scope under A (host-native).

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
| Sandbox adapter | Pristine SRT 0.0.77 + native parentProxy connect-guard | No `network.mode`; lease spawn gate; platform FS/proxy gates remain |
| `request_permissions` protocol | Extension-registered tool | Shape is Pi-specific |
| Approval handoff-to-user event | `/approve` after denial only | Guardian does not AskUser |
| Runtime reviewer switch | Mode cycle shortcut / commands | No mid-turn User ↔ AutoReview flip; auto/yolo applies at the next `turn_start` step boundary |

These are deliberate boundaries, not unfinished host features. Closing a gap
requires either an extension-side product decision or a new host API; do not
paper over them in docs as if the host already offered them.

## API surfaces this extension does use

| API | Use |
| --- | --- |
| `pi.on("tool_call")` | Owned skip; host-first B rules deny; foreign A pass-through |
| `pi.registerTool()` | Own bash/write/edit/request_permissions execution |
| `ctx.ui.setStatus` | Approve for me / Bypass permissions |
| `ctx.ui.confirm/select/notify` | `/approve` and mode notices (not the default Auto path) |
| `ctx.abort()` | Circuit-breaker turn interrupt |
| session/agent lifecycle events | Turn snapshot, grant expiry, cleanup |
| `pi.on("turn_start")` | Step-boundary apply of a mid-agent auto/yolo cycle (Codex-like); no sandbox profile hot-swap |
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
   enforcement is not host-first B and is not foreign host-native execution.
5. **Do not restore host-admission Guardian review** for foreign/host-first
   tools without an explicit product decision; B exists because review-only
   without sandbox ownership is false authority.
