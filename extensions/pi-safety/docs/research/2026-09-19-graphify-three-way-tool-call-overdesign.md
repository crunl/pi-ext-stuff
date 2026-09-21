# Graphify 三方：tool call 接管路径 vs pi 是否过度设计

## Scope

- Date: 2026-09-19
- Graphs (rebuilt this session):

| Tree | Path | Graph | Commit |
|---|---|---|---|
| fx | `/tmp/repo-research/fx/graphify-out/graph.json` | 27718 nodes / 59281 edges (`--no-cluster`) | `34d262d` (main) |
| Codex | `/tmp/repo-research/codex/graphify-out/graph.json` | 114294 nodes / 351093 edges (`--no-cluster`) | **pin** `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f` |
| pi-permissions | `extensions/pi-permissions/graphify-out/graph.json` | 1696 nodes / 3636 edges / 102 communities | tree @ `4594cd4` + untracked notes |

- Question: tool call 被权限层接管后的路径链路；**我们的 pi 扩展有没有过度设计？**
- Method: Graphify topology + 源码 file:line；对照 `docs/host-api-boundaries.md` 与 fx/Codex 一等公民 harness 差异。
- This note is analysis only. No product code change. No commit/push.

## 结论

**主决策链路没有过度设计**：pi 的「静态 elevate + LLM Guardian」与 Codex pin 双层同构；相对 fx 更厚，主因是 **Pi host 没有 permission mode / grant store / OS sandbox**，扩展必须自建这些宿主原语，而不是为了对齐而堆层。

**周边复杂度大多可辩护**（SRT 生命周期、worker 隔离、delegation 交集），**不是**把 fx 一行 gate 拆成十层。

**真正「尚未证明必要 / 可保持克制」的点**（不是立刻砍）：

1. Guardian **进程级** evidence worker（比 fx in-process reviewer 重）— 隔离收益真实，但是相对 fx 的最大结构差。
2. Write-root / denyRead 恢复规则面很宽 — 安全需要，但**禁止再扩 scope**。
3. Review UI / presenter / diagnostic 周边 — 不在安全关键路径上，保持薄。
4. 观测仍欠账（N1 `requestSource`、N2 `token_usage`）— **欠仪器化，不是过度设计**。
5. 未实现 Luna / cyber circuit-breaker / strict_auto_review 默认开 — 正确地没有跟风。

---

## 三方 tool call 接管链路

### fx（`vercel-labs/fx` @ 34d262d）— 一等公民 harness，最薄

```text
agent tool call
  → tool_dispatch.admitToolCall()          tool_dispatch.zig:L714
  → permission_gate.decideOrdinary()       permissions/permission_gate.zig
  → tool_admission.requestPermissionOutcome / runCommandContext
       tool_admission.zig（graph 权重最高 permissions 文件之一）
  → rules / session grants 先短路
  → unresolved → auto_classifier.review
       → provider: gateway chat | typesafe jev | codex/grok
  → Decision clear | caution | HostDisposition.unavailable
  → clear → executeToolCallAuthorized      tool_runtime.zig:L375
  → caution / unavailable → hold + guidance（不 unreviewed 执行）
```

Graph 证据（permissions/tooling 社区）：`tool_admission` 126、`permissions.zig` 120、`auto_classifier` 72、`tool_runtime` 33、`typesafe_permission_reviewer` 25。

特点：**执行与权限同进程、同 harness**；reviewer 可插拔（含已接 Jev）；无 Guardian 证据工具栈；沙箱是 `host_sandbox_default` 级别，不是独立 SRT 协调器。

### Codex @ pin — 一等公民 + sandbox 产品

```text
tool call
  → tools/orchestrator.rs                 ExecApprovalRequirement
  → exec_policy / shell-command parse
  → is_dangerous_command（静态）          shell-command/.../is_dangerous_command.rs
  → Skip | Forbidden | NeedsApproval
       Skip + strict_auto_review → 仍 request_approval   orchestrator.rs:L178-207
  → tools/approvals.rs
       hooks → (StrictAutoReview || Guardian) → Guardian else user
  → guardian/run_synchronous_review()     guardian/review.rs
  → GuardianAssessment allow|deny + policy floor
  → tools/sandboxing.rs 执行
```

Graph 证据：`parse_command` 125、`network_approval` 61、`guardian/review_session` 51、`exec_policy` 44、`sandboxing` 40、`is_dangerous_command` 21。

特点：静态 Forbidden **不进** LLM；Guardian 是审批阶段不是唯一门；sandbox 与 approval 是产品内原生路径。

### pi-permissions — **宿主扩展**，链路最厚（可解释）

```text
Host tool event
  ├─ Owned tools（可强制沙箱）
  │    bash/write/edit/request_permissions
  │    → register.ts 同名 override
  │    → adapters → AdmissionPlan
  │    → risk-policy.ts / permissions/risk.ts  (LOW|REVIEW|HARD, allow|prompt|block)
  │    → approve-for-me-engine.ts
  │         hard deny / grants / escalation lease / circuit / review route
  │    → auto-reviewer.ts + guardian-session + guardian-worker.*
  │    → sandbox/srt-enforcer + srt-coordinator (+ connect-guard)
  │
  └─ Host-only tools（仅 review gate）
       tool_call preflight → Engine review only
       → allow 后 host 以原生进程权限执行（sandboxEnforcesAction=false）
```

Graph 证据（src communities）：engine 88、risk 55、worker-client 53、connect-guard 42、session 39、sandbox-policy 37、srt-enforcer 34、adapters 36、auto-reviewer 27、srt-coordinator 19、delegation 18。

边界依据（`docs/host-api-boundaries.md`）：

| Host 缺失 | 扩展自建 | 是否「为了复杂而复杂」 |
|---|---|---|
| permission mode / reviewer 轴 | auto \| yolo + Guardian | 否 — 替代宿主缺失 |
| grant store | Engine turn amendments | 否 |
| OS sandbox | SRT + coordinator + poison/drain | 否 — 安全必需，但重 |
| 审批 UI | review presenter 等 | 弱必要 — 可保持薄 |

---

## 链路复杂度对照（主路径 stage 数）

| Stage | fx | Codex | pi |
|---|---|---|---|
| 入口 | dispatch/admit | orchestrator | register override + host preflight |
| 静态规则 | permission_gate + rules | exec_policy + dangerous | risk-policy + permissions rules + dangerous |
| 自动审查 | auto_classifier（可选 provider） | Guardian / hooks / user | Engine → auto-reviewer Guardian（+ worker） |
| 执行 | in-process authorized execute | sandboxing | SRT lease / escalated one-shot / host-native |
| 失败语义 | hold + guidance | Rejected / Deny | block / failed_closed / circuit / recovery |
| 特有层 | Jev 路由 | strict_auto_review、Luna 路径存在 | **双通道 owned/host-admission**、delegation 交集、write recovery、metrics |

**主路径 stage 数：fx ≈ 4、Codex ≈ 5、pi ≈ 6–7**。差值几乎全部落在「宿主替身 + 沙箱生命周期 + 双通道」。

---

## 「过度设计了吗？」分项裁决

| 组件 | 相对 fx/Codex | 裁决 | 说明 |
|---|---|---|---|
| 静态 Risk + Guardian 双层 | 与 Codex 同构；fx 更薄 | **不过度** | 已有 09-17 研究笔记关闭伪前提 |
| Engine grants / attempt freeze | fx session grants 类似但更简单 | **不过度** | 宿主无 grant store |
| SRT + coordinator poison/drain | fx/Codex 无同等扩展层 | **可辩护偏重** | 换安全边界；勿再加状态 |
| Guardian worker 进程 + 证据工具 | fx in-process；Codex Guardian 在产品内 | **最大结构差，可辩护** | 隔离 host 进程；Path1 residency 已 deferred |
| Write/Edit 恢复矩阵 | 无直接对等 | **必要但禁止扩张** | 沙箱 deny 后的唯一恢复路径 |
| Delegation 交集 / child network pin | 无直接对等 | **不过度** | 子代理越权是真实风险 |
| Network connect-guard + patch | 比 Codex Enabled 更严 | **产品选择，非堆层** | AGENTS.md 已记录 |
| Metrics / diagnostic / presenter | Codex telemetry 更完整 | **欠账 > 过度** | N1/N2 仍空 |
| 未做 Luna / Jev 默认接入 / cyber breaker | — | **正确的克制** | 不跟风未对齐项 |

### 指标含义（勿误读）

- pi graph **1696 nodes** 只覆盖扩展树；fx **27k / Codex 114k** 是整仓。不能比绝对节点数说 pi 更复杂。
- pi 在 **permissions 相关 src 社区上的集中度高** 是预期：整个产品就是权限扩展。
- fx `tool_admission` + `permissions` + `auto_classifier` 也已经是一大块 —— 说明「接管后的路径」在一等公民里也不薄。

---

## 可执行的克制原则（后续改动用）

1. **主链路冻结形状**：`static → (optional classifier) → Guardian → sandbox lease`。新功能优先挂在现有缝上，不新开第 N 条审批轨。
2. **host-admission vs owned 双通道保留** — 这是 API 事实，不是过度设计；不要合并成虚假的单一强制沙箱承诺。
3. **禁止**：把 fx Jev/Claude Code Auto Mode 当默认 Guardian 替代；默认开 strict；扩大 write recovery scope；为对齐再复制 cyber 熔断除非产品要求。
4. **要补的是观测不是层**：N1 requestSource、N2 token_usage、P0 skip-LLM 清单。
5. 若未来 host 提供原生 sandbox/grant，**删**扩展替身而不是再包一层。

---

## What this note does not claim

- 未跑 product `npm test`（无代码变更）。
- fx 图为 main `34d262d`，不是某个长期 pin；Codex 固定 `129fd21`。
- Graphify `--no-cluster` 无 community 命名（fx/codex）；对比以源码路径权重 + file:line 为准。
- 「不过度」不等于「每一行都最优」；指**架构形状**相对宿主约束与 Codex 双层是合理的。
