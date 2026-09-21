# P2-1 recheck: Codex dangerous-command blacklist vs Pi static gate

## Scope

- Date: 2026-09-17
- Codex pin: `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
- Host pin: `@earendil-works/pi-coding-agent@0.85.1`
- Corrects two false claims in `2026-09-10-auto-approve-four-way-comparison.md` §5
  and `2026-09-10-alignment-reverification-and-score.md` §6.4.
- This note does **not** change product code; it retires the "Codex removed the
  blacklist" premise behind the open P2-1 item.

## Decision

**P2-1 is closed as a false premise.** Codex still ships a static
`is_dangerous_command` blacklist at the standing pin. Pi's dual layer
(static elevate-to-review + LLM Guardian) is the same architecture, not a
divergence to "fix" by deleting the static gate.

## Codex facts (GitHub at pin)

| Claim | Verdict |
|---|---|
| Blacklist removed by LLM classification | **False** |
| `is_dangerous_command` still exists | **True** — `codex-rs/shell-command/src/command_safety/is_dangerous_command.rs` |
| Rules narrowed | **True** — forced-`rm`, `sudo`/`env`/`trap` wrappers, Windows force-delete |
| Git checks still present | **False** — removed in `fc073c9` (2026-02-13) |
| Guardian replaced the blacklist | **False** — Guardian is a later approval stage |
| `codex-guardian-reviewer` crate | **Not present at pin** — implementation is `core/src/guardian/`; only `guardian-context` is a separate crate |

Codex stage order:

1. ExecPolicy static (`Allow | Prompt | Forbidden`); unmatched →
   `is_dangerous_command`. Dangerous → `Forbidden` under `Never`, else `Prompt`.
2. Orchestrator: Forbidden rejects; NeedsApproval → `request_approval`.
3. Hooks, then Guardian LLM (when reviewer=AutoReview), else user UI.
4. Sandbox execute. Static Forbidden never reaches Guardian.

## Pi facts (this tree)

| Surface | Location | Behavior |
|---|---|---|
| Word-level heuristic | `src/permissions/dangerous-commands.ts` | `rm` with force flag; recursive `sudo`/`env`; depth 8 |
| Segment / trap expand | `src/permissions/risk.ts` `isDangerousSegment` / `shellCommandIsDangerous` | `trap` actions re-parsed |
| Sandboxed bash risk | `src/risk-policy.ts:332-336` | dangerous → `HARD`, else `LOW` |
| Admission mapping | `src/pi-approve-for-me-adapters.ts:95-113` | `block`→deny; `prompt`→review (carries risk) |
| Guardian | `src/approve-for-me-engine.ts` `runReview` | LLM re-judges; policy floor on critical/high |

Sandboxed bash with dangerous command is **not** a pre-Guardian hard deny.
It becomes `action: "prompt", risk: "HARD"` (`src/risk-policy.ts:399-409`),
so Guardian still decides. `action: "block"` is reserved for other HARD paths
(private targets outside the sandboxed-bash carve-out, protected writes,
rule deny, …).

Pi Guardian policy already contains Codex's LLM taxonomy, including
"user-requested `rm -rf` of a specific local path is usually low/medium"
(`src/guardian-policy.ts:74`, `:182`).

## Comparison

| Axis | Codex `129fd216` | Pi (this tree) | Status |
|---|---|---|---|
| Static blacklist exists | yes (narrowed) | yes (`rm -f` + wrappers) | **aligned** |
| Git subcommands in list | no (removed `fc073c9`) | no | **aligned** |
| Windows force-delete rules | yes | no | gap (platform) |
| Dangerous outcome | Forbidden (`Never`) / else Prompt | always review (no Never analogue; yolo is a different axis) | deliberate |
| LLM Guardian | later approval stage | later approval stage | **aligned** |
| Guardian consumes static match | no | `staticRisk` is metadata only | near-align |
| LLM risk taxonomy in policy | yes | yes (ported) | **aligned** |

## What this retires

The 2026-09-10 claims that Codex "无命令黑名单" / "已改用 LLM 分类" are
**superseded by this note**. Do not schedule blacklist removal on that basis.
Any future P2-1 work must start from the actual Codex stage model above.

## Remaining optional deltas (not P2-1)

1. Windows force-delete detection — only if Windows becomes a product target.
2. Document in product notes that sandboxed-bash `HARD` means "must review",
   not "pre-Guardian deny" (the type name invites that misread).
3. Keep `is_dangerous_command` rules as a living mirror of Codex's narrowed
   set; re-check when the pin moves or `shell-command/command_safety/` changes.

## This note does not claim

- Live Codex binary behavior beyond static source at the pin.
- That Pi's `classifyRisk` non-sandboxed path (network / external side-effect
  HARD sources) is Codex-identical — only the dangerous-command slice is in scope.
