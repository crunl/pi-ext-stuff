# Graphify: Codex vs pi-permissions 审批/危险命令链路对照

## Scope

- Date: 2026-09-17
- Codex pin: `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
  - clone: `~/.graphify/repos/openai/codex` @ `129fd21`（detached）
  - graph: `graphify-out/graph.json`，124611 nodes / 351093 edges，`--no-cluster`
- pi-permissions: this tree HEAD `7956a74` + untracked research note
  - graph rebuilt via `graphify update .`（1643 nodes / 3587 edges）
- Purpose: verify whether prior commits followed a false Codex premise, and
  map both approval chains from the graphs (not from memory).

## Commit-direction verdict

**近期 commit 没有沿错误前提推进。**

| 前提 | 是否进了代码 | 判定 |
|---|---|---|
| 「Codex 已去掉危险命令黑名单」（09-10 笔记） | 否 — 无删除黑名单的 commit | 仅笔记错误；P2-1 未实施 |
| 「Codex 仍保留 `is_dangerous_command`」 | 是 — `d2b0580` / `566fe46` 镜像 | 与 pin 事实一致 |
| `network_access` whole-open | 是 — `bcb056e` 等 | 有独立 dated note + bind-axis 更正 |
| Guardian cache key + Delta | 是 — `ecd6fdb` | 依据 trunk/LLM token 成本，不依赖 crate 拓扑 |
| Metrics JSONL | 是 — `7956a74` | 观测面，不依赖黑名单结论 |

09-10 笔记里另一条错误断言（`codex-guardian-reviewer` 独立 crate）也**没有**驱动
worker-residency 实现；path 1 仍 deferred。

## Graph evidence — Codex @ pin

| Symbol | Location | Graph degree / notes |
|---|---|---|
| `dangerous_command_match_for_exec()` | `shell-command/.../is_dangerous_command.rs:L123` | present |
| `DangerousCommandMatch` | same file L27 | present |
| `dangerous_command_match_for_heuristics()` | `core/src/exec_policy.rs:L737` | called from `.create_exec_approval_requirement_for_parsed_commands()` L399 |
| `Decision` | `execpolicy/src/decision.rs:L9` | Allow/Prompt/Forbidden |
| `GuardianAssessment` | `core/src/guardian/assessment.rs:L13` | consumed by `run_synchronous_review()` |
| `run_synchronous_review()` | `core/src/guardian/review.rs:L336` | LLM approval stage |

Undirected graph path (structural):

```text
dangerous_command_match_for_exec()
  ← contains — is_dangerous_command.rs
  → imports_from — super
  → imports_from — guardian/review.rs
  → imports_from — GuardianAssessment
```

Call-layer (from explain, not hops): static dangerous match is an **exec_policy
heuristic**; Guardian assessment is a **later review artifact**. Graph does not
show Guardian calling the blacklist.

## Graph evidence — pi-permissions

| Symbol | Location | Edges into/out |
|---|---|---|
| `evaluateRiskRequest()` | `src/risk-policy.ts:L220` | calls `shellCommandIsDangerous()` L334; imported by `register.ts` |
| `shellCommandIsDangerous()` | `src/permissions/risk.ts:L995` | → `parseCommandSegments` / `isDangerousSegment` |
| `admissionPlanFromRiskDecision()` | `src/pi-approve-for-me-adapters.ts:L95` | called by `admissionForAction()` in `pi-permissions.ts:L176` |
| `registerExtension()` | `src/register.ts:L172` | god-node, 104 edges; wires Engine + SRT + AutoReviewer |
| `createApproveForMeEngine()` | engine hub | 36 edges |

Undirected import path:

```text
shellCommandIsDangerous()
  ← imports — risk-policy.ts
  ← imports_from — pi-permissions.ts
  → imports — createApproveForMeEngine()
```

Call-layer (from `explain evaluateRiskRequest`):

```text
register.ts
  → evaluateRiskRequest()
      → shellCommandIsDangerous()   # sandboxed bash: HARD vs LOW
      → classifyRisk() / path checks / network / escalation
  → admissionPlanFromRiskDecision() # block→deny, prompt→review
  → Engine runReview() → Guardian LLM
```

## Side-by-side conclusion

Both graphs show the **same two-stage shape**:

1. Static dangerous-command heuristic (deterministic, pre-LLM).
2. LLM Guardian that re-judges allow/deny with its own risk taxonomy.

Pi maps Codex `Prompt` → `action:"prompt"` + `risk:"HARD"` (must review), not
`Forbidden`. There is no remaining P2-1 code work justified by the old note.

## Graph artifacts

| Tree | Path | State |
|---|---|---|
| pi-permissions | `graphify-out/graph.json` + `GRAPH_REPORT.md` | clustered, dated 2026-09-17 |
| Codex | `~/.graphify/repos/openai/codex/graphify-out/graph.json` | raw extract only |

Codex clustering/labels skipped (`--no-cluster`) — 114k nodes; name communities
only if a targeted subgraph is needed later.

## This note does not claim

- Full Codex behavioral proof beyond source at the pin.
- That AST graph edges equal runtime control flow (import hops are structural).
- Live provider / metrics file presence on the user's machine.
