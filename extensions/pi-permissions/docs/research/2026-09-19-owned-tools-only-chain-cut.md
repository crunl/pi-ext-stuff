# Owned-only governance + host-first B chain cut

## Scope

- Date: 2026-09-19
- Standing Codex pin: `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
- fx reference: `vercel-labs/fx` main `@ 34d262d` (session graph/docs; clone
  may be external-directory blocked)
- Tree: pi-permissions working tree (implementation may be uncommitted)
- Question: product scope **only Pi built-in tools** — how to cut/merge the
  foreign host-admission path and define host-first `read`/`grep`/`find`/`ls`
- This note is design + implementation intent. Acceptance is separate
  (`preflight:sibling` + `check` + `lint` + `test`). Dirty sibling ⇒ provisional.
- What this note does **not** claim: live acceptance green; that owned Guardian
  is optional; that foreign tools are sandboxed by this extension.

## Product decisions

1. **Owned** (bash/write/edit/request_permissions): keep full chain
   (risk → Engine → Guardian residual → SRT/escalated/amendment).
2. **Host-first B** (read/grep/find/ls): **only** configured `rules[]`
   **deny** → `{ block: true, reason }`. Never Engine/Guardian.
3. **Foreign A** (MCP/custom/other extensions): `tool_call` `return undefined`.
4. **`subagent`**: residual special — `checkDelegateSpawn` then B; not owned
   execute. Do not silently drop delegation depth/re-delegate gates.
5. **rules.ask** on host-first: **ignored** (document warning). Empty rules =
   no extra gate (matches live config with no `rules` field).
6. **P0 residual fail-closed, yolo, SRT poison, escalation/amendment review,
   connect-guard** stay — orthogonal to this cut.

## First-principles boundary

Host-first tools have no SRT-owned `execute`. The extension cannot enforce
effects after host-native run. Guardian review-only without enforcement is
false authority. The only legitimate intervention is a **user-declared static
deny** at `tool_call` `{block:true}`.

Codex (pin): built-in read handlers use sandbox FS / native handles — not
exec_policy approval / Guardian. User policy is Starlark `rules/*.rules` with
`Decision::{Allow,Prompt,Forbidden}` on the **exec** path; Forbidden does not
enter LLM review. B is the static-deny-only degradation when there is no host
sandbox seam for read tools.

fx: rules/session grants short-circuit before auto review; narrow deny/allow
avoids reviewer. Host-first B deletes the reviewer for tools that cannot honor
review semantics.

## Implementation shape

```text
tool_call:
  owned → undefined
  host-first | subagent → evaluateHostFirstToolCall
      yolo → undefined
      subagent + delegation.enabled → checkDelegateSpawn
      evaluateHostFirstRulesOnly(normalizeToolCall + matchRules)
        deny → { block: true, reason }
        else → undefined
  foreign → undefined
```

- `operation` for host-first: reuse `normalizeToolCall` (`read` for
  read/grep/find/ls). `matchRules` uses tool name + optional pattern on
  `JSON.stringify(input)` when there is no `command`.
- Block shape: `{ block: true, reason }` only.
- Example rules (docs only; do not write live `permissions.json`):

```json
{
  "rules": [
    { "action": "deny", "tool": "read", "pattern": "*/Library/*" },
    { "action": "deny", "tool": "find", "pattern": "*.env*" },
    { "action": "deny", "tool": "ls" }
  ]
}
```

## Supersession

This note **partially supersedes** host-admission product claims in
`2026-09-19-p0-skip-llm-first-principles.md` (R1/R9 host `authorizeHostTool` →
Engine/Guardian) and `2026-09-19-graphify-three-way-tool-call-overdesign.md`
(dual-channel production review for generic host tools). Those notes remain
historical for owned-path P0 residual design. Host-admission **production
review** is retired; residual vocabulary `host_admission_review` may remain in
metrics/schema for compatibility.

## Code map

| Area | Change |
| --- | --- |
| `src/risk-policy.ts` | `evaluateHostFirstRulesOnly`; `evaluateHostRiskRequest` deny-only compatibility |
| `src/register.ts` | `PI_OWNED_TOOL_NAMES` / `PI_HOST_FIRST_TOOL_NAMES`; `evaluateHostFirstToolCall`; foreign A; no `permissions.submit` on host-first |
| `docs/host-api-boundaries.md` | Three channels; no host-admission review claim |
| `AGENTS.md` | Governance channels; remove generic host-admission product sentence |
| tests | register + risk-policy: B deny, empty rules pass, ask ignored, foreign no evaluator |

## What we deliberately did not cut

Owned Engine/Guardian/SRT, residual fail-closed, yolo, escalation review,
amendment review, connect-guard, `matchRules` deny>ask>allow algorithm for
owned tools, live user config contents.
