# Guardian 对齐缺口复盘（Graphify 双图 + pin 源码）

## Scope

- Date: 2026-09-18
- Codex pin: `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
  - clone: `~/.graphify/repos/openai/codex` @ `129fd21`（detached）
  - graph rebuilt: `graphify-out/graph.json`，114294 nodes / 351093 edges，`--no-cluster --force`
- pi-permissions: this tree after `4594cd4`
  - graph rebuilt: `graphify-out/graph.json`，1666 nodes / 3608 edges / 98 communities
  - graph commit stamp in node payload: `4594cd4d`
- Purpose: after graph refresh, list **remaining** Guardian alignment gaps beyond the already-tracked open items (P0 skip-LLM ladder, token_usage, cyber circuit-breaker, Path 1 worker residency, Luna/Adaptive).
- Method: subagent draft + parent re-verification against pi `src/**` and Codex clone at pin. Subagent could not read Codex paths (`external_directory=ask`); parent re-checked every **new** claim below in Codex/pin source.
- This note does **not** implement product changes. No commit/push.

## Graph refresh evidence

| Tree | Command | Result |
|---|---|---|
| pi-permissions | `graphify update <pi root>` | 1666 nodes / 3608 edges / 98 communities |
| Codex@129fd21 | `graphify update <codex clone> --no-cluster --force` | 114294 nodes / 351093 edges |

Pi graph topology still lines up with the approval chain communities (engine / auto-reviewer / guardian-session / risk-policy / metrics / adapters). Codex raw extract confirms guardian/exec_policy/approvals symbol presence; **code file:line remains authoritative**, graph is topology only.

## Verdict

**安全语义级 taxonomy / policy floor / fail-closed / 90s×3 / 3+10of50 / 只读证据 / 批准不扩权 在 pin 与 pi 两侧一致。**  
新增/细化缺口集中在 **session 隔离与观测、token 预算、可选 strict 轴**，不是再发现一套不同的危险命令语义。

## Chain compare (summary)

| Stage | Codex @ pin | pi | Status |
|---|---|---|---|
| 静态入口 | Allow\|Prompt\|Forbidden；unmatched→`is_dangerous_command`；dangerous→Never=Forbidden 否则 Prompt | rule deny→block；sandboxed bash dangerous→`HARD`+prompt；LOW→allow | aligned（双层） |
| Orchestrator | Skip/NeedsApproval/Forbidden；**Skip+strict 仍审** | policyCheck→runReview；yolo 短路；无 strict | aligned + optional 差 (N3) |
| Hooks | permission hooks 可短路 Guardian | 无 host hook API | N/A 架构差 |
| Guardian 输入 | action+transcript+tenant policy+读工具；key `guardian:{parent_thread_id}` | untrustedAction+permissionContext+transcript/delta；key `pi-permissions-guardian-${sessionId}` | aligned；sessionId 见 N1 |
| Taxonomy / floor | risk_level+user_authorization+outcome allow\|deny+rationale | 同（`auto-review-request.ts` + `guardian-policy.ts`） | aligned |
| Fail-closed | parse/session→Deny+High | parse/provider→review-unavailable blocked | near-align（安全等价） |
| 超时/熔断 | 90s/3；3连或 50 内 10；cyber 1/1 | 同常量；无 cyber | aligned（cyber 已知 open） |
| Session/trunk | managed reviewer threads（`ThreadSource::GuardianReview`） | trunk 按 host sessionId | **gap N1** |
| Telemetry | Codex tags | schema 就绪；token_usage=0；requestSource 未写 | **partial N2/N1** |
| Model resolve | AutoReview；catalog 可 Luna | configured→active→fallback | aligned（Luna 已知） |

## New / refined gaps (parent-verified)

### N1 — Delegated Guardian session 隔离 + `approval_request_source` 未写

- **Codex**: cache key `guardian:{parent_thread_id}`（09-17 latency note）；reviewer lifecycle 走 managed internal session（`core/src/guardian/review_session_threads.rs`，`ThreadSource::GuardianReview` / `InternalSessionSource::Guardian`）。
- **pi**:
  - `guardianSession.sessionId` = host conversation id（`register.ts:787-806` `stableSessionId`；turn snapshot `:813`）。
  - trunk cache key: `pi-permissions-guardian-${key.sessionId}`（`guardian-session.ts:194-196`）。
  - `invalidateSession()` 仅在 `resetBranchPermissionContext` 路径（`register.ts:359-373`）；nested open **未** invalidate / 未注入 turnId 到 guardian key。
  - `GuardianRequestSource` 枚举含 `delegated_subagent`（`guardian/metrics.ts:29,41,116`），但生产 **无任何调用方传入 `requestSource`**；sink 默认 `main_turn`（`:143`）。adapters metrics 构造亦无该字段（`pi-approve-for-me-adapters.ts:325-337`）。
- **风险**: 子代理 review 可能继承/污染父 Guardian trunk；metrics 无法区分请求来源。
- **判定**: **must-align（小刀）** — nested/delegated 打开时 `invalidateSession()` 或 guardian key += turn/child id；metrics 真实写入 `requestSource`。
- **对照注记**: AGENTS.md 已规定 delegated child **network** 不继承 parent `network_access`（`delegation.ts`）；本条是 **Guardian trunk/观测** 轴，不是 network 轴。

### N2 — `token_usage` 填充断裂（细化已知 open #2）

- **已就绪**:
  - schema: `guardian/metrics.ts:51-58,126-133,153-160`
  - engine metrics 类型: `approve-for-me-engine.ts:199-206` `GuardianDecisionMetrics.tokenUsage?`
  - sink: `register.ts:243-245` 透传 `event.metrics.tokenUsage`
- **断裂点**:
  - `auto-reviewer.ts:485-497` 成功返回仅拼 `...result` + `guardian` + `sessionKind` + `hadPriorReviewContext`，**不读** `response.usage`（含 tool-round `attemptMessages`）。
  - `pi-approve-for-me-adapters.ts:325-337` 成功 metrics **不映射** `tokenUsage`。
- **后果**: JSONL `token_usage` 恒为 0（schema 缺省），不是 provider 一定没给 usage。
- **判定**: **must-align（观测）** — reviewer 聚合 final + tool-round `usage` → `AutoReviewResult` → adapter metrics。

### N3 — `strict_auto_review`（optional / product-choice）

- **Codex @ pin 存在**:
  - protocol key: `protocol/src/mcp_approval_meta.rs:9` `codex_strict_auto_review`
  - turn state: `core/src/state/turn.rs` `strict_auto_review_enabled` / `enable_strict_auto_review`
  - orchestrator Skip 分支强制走 approval（`core/src/tools/orchestrator.rs:178-207`）
  - approvals 路由注释：`If StrictAutoReview || Guardian enabled, then Guardian. Else, user.`（`core/src/tools/approvals.rs:493-495`）
  - 测试：`strict_auto_review_turn_grant_forces_guardian_for_exec_command_policy_skip`（`core/src/session/tests/guardian_tests.rs`）
- **pi**: 全树 0 hit；LOW/static-allow 可不进 Guardian（与 P0 skip-LLM 方向一致）。
- **判定**: **optional** — 与 P0（少进 LLM）方向相反；若要对齐应 `reviewer.strictAutoReview` 默认 `false`，产品另开。**勿与 P0 混做。**

### N4 — approx-token 分层截断（性能；latency P1-E 细化）

- **Codex**: ~4B/token prefix+suffix layered caps（latency note）。
- **pi**: 仍字符预算（`guardian-transcript.ts`、`guardian-session.ts`、`auto-review-request.ts`）。
- **判定**: **must-align（性能）**，非安全语义。

### N5 — `BANNED_PREFIX_SUGGESTIONS`

- **Codex**: `exec_policy.rs` 一带 = **不可建议为 allow-amendment 的前缀**，不是 deny list。
- **pi**: amendment 轴现为 hosts/writeRoots，无前缀 amendment。
- **判定**: **N/A 现架构**；未来若加前缀 amendment，必须与 danger list 分离命名。

## Closed false premises (do not reopen)

| Candidate | Verdict |
|---|---|
| 移除黑名单对齐 Codex | **伪前提** — pin 仍有 `is_dangerous_command`（09-17 recheck） |
| `codex-guardian-reviewer` 独立 crate | **pin 不成立** — 实现在 `core/src/guardian/` |
| Guardian 输出 AskUser | **pin 不成立** — Guardian schema 仅 `allow\|deny`（`core/src/guardian/tests.rs` JSON schema/enum）；AskUser 属 Extension API `decide_approval` fast path（`core/src/guardian/runtime.rs:17` 注释） |
| host 无 hooks = 不安全 | **N/A** — host 无 hook API；见 `docs/host-api-boundaries.md` |
| 缺 ApprovedForSession = 洞 | **否** — product decision（pi 更严） |

## Recommended next slice (if user asks for work)

1. **N1**: nested/delegated Guardian session isolation + metrics `requestSource` 写入；hermetic：子代理 review 不命中父 trunk；JSONL 可区分 `delegated_subagent`。
2. **N2**: `auto-reviewer` 透传 `response.usage`（含 tool rounds）→ adapter `tokenUsage`；stub usage 后 JSONL `token_usage` 非零。
3. Do **not** in that slice: Luna/Adaptive、session grant 扩权、strict 默认开、删黑名单、P0 skip-LLM 大改。

## What this note does not claim

- 未在本 note 内重跑 product `npm test`（无产品代码变更）。
- 未声称 live metrics 已出现 non-zero `token_usage` 或 `delegated_subagent` 行。
- 未实现 N1–N4；仅记录对齐分析结论。
- Codex graph 为 `--no-cluster` 原始抽取，无 community 命名；对比以源码 file:line 为准。
