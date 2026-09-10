# 对齐报告核验 + 项目评分（2026-09-10）

> **Codex pin 约定（standing）：** Approve for me 对齐正文统一钉
> [`129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`](https://github.com/openai/codex/commit/129fd21687fbd4ac48133b7abfdcaf52cb6cb01f)。
> 本文写于 2026-09-10，当日漂移对照用的是 main tip `b348fc2`；那是一次性核验快照，不是 standing pin。
> 新结论请以 `129fd216` 为准，或单独标注漂移备注。

核验对象：`docs/research/2026-08-27-approve-for-me-vs-codex.md`（已从树中移除；本文保留其断言核验）
核验基准：Codex `b348fc2`（2026-09-10，当日 main tip 快照）；Pi 工作树当前内容。
Standing pin：`129fd216`。

---

## 0. 头条结论

1. **08-27 对齐报告两侧都已过期，且是"出生即作废"** —— commit `0fb978a`（2026-08-28，`refactor: align permissions with approve-for-me`）在**同一个提交里**加入了这份报告、**删除了它描述的模块**（`enforced-tool.ts` / `grant-ledger.ts` / `sticky-permission-world.ts`）、并**新增了** `approve-for-me-engine.ts`。报告没有任何"已作废"横幅。
2. **报告 12 条关键 Pi 断言：3 条仍成立、3 条部分成立、6 条已失效。**
3. **Codex 侧同期发生重写级漂移**：guardian 被拆成独立 crate，且**新增了"Guardian 可把请求交还用户"**这条原报告不可能覆盖的语义。
4. **综合评分 6.8 / 10** —— 设计维度强（≈8.0），交付与证据维度拖后腿（≈5.4）。

---

## 1. 对齐报告核验：Pi 侧 12 条断言

| # | 08-27 报告断言 | 判定 | 当前事实 |
| --- | --- | --- | --- |
| 1 | 只有 `auto`/`yolo`；auto 状态栏 "Approve for me" | ✅ | `src/state.ts:5`、`src/modes/controller.ts:3`、`src/permission-copy.ts:67` |
| 2 | `tool_call` 里 `request_permissions` **故意跳过 Guardian**，批准在 execute 里 `ctx.ui.confirm` | ❌ | **全仓无 `ctx.ui.confirm`**。现在 `request_permissions` 是注册工具（`src/register.ts:2078`），prompt 分支产出 `kind:"permission-amendment"`（`:2208`）→ engine `runReview` 走 **Guardian**。报告 §4 示例表里"用户 confirm"一格是错的 |
| 3 | risk 三态 allow/prompt/block；block 不进 Guardian | ✅ | `src/risk-policy.ts:18-31`、`src/pi-approve-for-me-adapters.ts:80-85` |
| 4 | Guardian approve → mint 一次性 grant（绑 toolCallId+fingerprint） | ✅ | engine `:2149-2157` 铸；`:1308-1331` 注释 "atomic one-shot spend" |
| 5 | "sticky world hosts/write roots 与 grant 取并"；形状是 turn \| session | ⚠️ | 模块已删。现在是 `leaseWithRequests` 把 `turnNetworkHosts/turnWriteRoots` 并进 base policy（engine `:809-833`）。**只有 turn 作用域，无 session grant**（`:366-369`，`expires:"turn-end"`） |
| 6 | Guardian 工具面只有 `read/grep/find/ls`，**无 shell** | ❌ | 白名单含 **`inspect`**（`src/guardian-tools.ts:43`）= `/bin/bash -c <cmd>`，在只读沙箱内跑（`src/sandbox.ts:586-607`：`allowWrite:[]`、`deniedDomains:["*"]`）。Guardian **能跑有界只读 shell** |
| 7 | 超时 90s、最多 3 次 | ✅ | `src/guardian-policy.ts:1-2` |
| 8 | 连续拒绝熔断 3 次，无 cyber 特例 | ⚠️ | 3 次成立，但**已补窗口熔断**：50 内 10 次（engine `:439-441`）。cyber 特例仍无 |
| 9 | "nono 默认外网开着，与 Codex fail-closed 不是同一语义" | ❌ | nono 已删（`cacd957`）。现在 SRT 0.0.74，生产必持 connect guard ⇒ `allowedDomains` 被强制清空（`srt-enforcer.ts:112-118`），**逐连接审**。默认已 fail-closed，**与 Codex 同向** |
| 10 | 无 unsandbox 重试；唯一旁路是裸 `git init` | ❌ | 已有一次性 `sandbox_permissions=require_escalated` action review（`src/shell-permissions.ts:62-80` → `register.ts:1712-1731`），外加 bounded native recovery |
| 11 | 人审 popup 已退休；`GrantAuthority "user"` 生产路径空着 | ⚠️ | 无人审弹窗 ✅；但 `GrantAuthority` **类型已不存在**（随 GrantLedger 删除）→ 不是"空着"而是"概念已删"。人机面只剩 `/approve`（`src/pi-permissions.ts:466-505`） |
| 12 | 网络审批 = risk 抽 hosts → grant.networkHosts → profile `allow_domain` | ⚠️ | 已分化：`request_permissions` 路径仍在，但**执法不再靠 profile allowlist**，而是 connect guard + engine 连接回调。普通 bash **不再静态抽 host 送审**，改为连接边界 inline review（`src/risk-policy.ts:347-352`） |

**报告 §6「若要再对齐」三条建议的现状**：#1（`request_permissions` 改走 Guardian）**已实施**；#3 的前提（nono）已消失；#2 仍开放。

---

## 2. Codex 侧漂移（`7625bd5` → `b348fc2`）

> 注：本地为两个无父快照，无法做 per-file commit 归属，以下为快照间 diff。

### 2.1 结构性重写

| 变化 | 证据 |
| --- | --- |
| guardian 剥离为独立 crate **`codex-guardian-reviewer`**（重试/超时/熔断/会话池解耦） | `codex-rs/ext/guardian-reviewer/`（OLD 不存在） |
| 新增 **`codex-guardian-context`** 共享上下文 crate | sync reviewer 与 async scorer 共用 |
| `core/src/guardian/` 从 1015 行级模块缩为 host 适配层 | `review.rs`、新增 `decision.rs`/`coverage.rs`/`runtime.rs` |
| prompt 组装移出，`policy.md`/`policy_template.md` 移到 `core/assets/guardian/`，**内容逐字节相同** | 政策模板未变 |

### 2.2 语义变化（会让旧对齐报告失真的）

1. **审批仲裁顺序反转**。OLD 先选 reviewer 再分派；NEW **先无条件问 Guardian，返回 `None` 才落到用户**（`tools/approvals.rs:547-560`）。
2. **⚠️ Guardian 现在可以把请求交还用户**（OLD 不可能）：

   ```rust
   Some(ApprovalDecision::AskUser) if !require_guardian => None,   // decision.rs:185
   ```

   即 AutoReview 下**不再保证一定不进弹窗**。这条直接推翻 08-27 报告对 `request_permissions` 的理解方向（虽然结论相反）。
3. **Full Access 自动放行分支**：`has_full_access(...)` 为真直接 `ReviewDecision::Approved`（`decision.rs:87-104`）。
4. **新增 `write_stdin` 审批通道** + 策略前置硬拒。
5. **reviewer 可运行时切换**：`TurnSettingsUpdate.approvals_reviewer` + MCP elicitation override。
6. **MCP elicitation 路由条件变了**（改用 `Feature::GuardianApproval` + `can_set(AutoReview)`，经 `ElicitationReviewer` trait）。

### 2.3 哪些旧断言**仍然成立**

`routes_approval_policy_to_guardian` 函数体 byte-identical（现为兜底闸门而非主路由）；Guardian 会话 read-only + `approval_policy=never` + 清空 MCP；90s / 3 次重试；熔断 3 连续 / 10-of-50（Cyber 1/1）；`/approve` 一次性重批（`approve_guardian_denied_action` byte-identical）；**Guardian 不能扩大沙箱**（契约现显式写在 `ext/guardian-reviewer/src/review.rs:17-19`）；危险命令仍由 exec_policy 判 Prompt，**未新增任何硬编码命令**。

**未变**：`protocol/src/config_types.rs`、`utils/approval-presets/src/lib.rs` 均 byte-identical。

---

## 3. 重新对齐表（当前真实状态）

| 主题 | Codex `b348fc2` | Pi（工作树） | 状态 |
| --- | --- | --- | --- |
| 两轴 vs 一轴 | `AskForApproval` × `ApprovalsReviewer` | 单开关 `auto`/`yolo` | 刻意偏离 |
| 谁批 | Guardian LLM，**可回落用户** | Guardian LLM，**不回落**（fail-closed） | Pi 更严 |
| Guardian 隔离 | 同进程受限配置 | **独立子进程** + 净化环境 + 自持 SRT | Pi 更强 |
| Guardian 能力 | 只读 profile 下完整 runtime | 白名单 + `inspect`（有界只读 shell） | 已接近 |
| 超时/重试/熔断 | 90s / 3 / 3+10of50 | 90s / 3 / 3+10of50 | **一致** |
| 审批粒度 | per-action（`Turn`/`Session` grant） | per-action + **attempt 冻结**，仅 turn grant | Pi 独有冻结；Codex 有 session |
| 网络审批 | per-action + NetworkPolicyAmendment | **per-connection**（connect guard） | Pi 更细 |
| 真实沙箱 | linux/seatbelt/mxc/windows | SRT 0.0.74 | 平手 |
| 危险命令 | LLM 风险分类（**无黑名单**） | 硬编码黑名单（镜像 Codex 旧实现）+ Guardian | **职责重叠** |
| 人审模式 | "Ask for approval" 仍是一等 | 已退休，仅 `/approve` | **Pi 缺失** |
| `strict_auto_review` | 有 | 无 | Pi 缺失 |
| 运行时切 reviewer | 有 | 无 | Pi 缺失 |

---

## 4. 项目评分

评分口径：0–10，分维度加权。**「设计/架构」与「交付/证据」分开看**，因为两者差距很大。

| 维度 | 权重 | 分数 | 主要依据 |
| --- | --- | --- | --- |
| 授权架构与语义 | 20% | **8.5** | 单一 Engine 主线；`structure-invariants.test.ts:33-43` 用测试**反向锁定**已删模块不得回归；attempt 冻结语义四者独有 |
| 安全边界 | 20% | **7.5** | deny 不可解锁有回归；Guardian 独立进程 + 只读 SRT；私有网段 HARD。扣分：host-admission 工具 `sandboxEnforcesAction=false`；escalated bash 无沙箱策略 |
| 执行强制层 | 15% | **8.0** | SRT 真沙箱 + connect guard + 逐连接审，比 Codex 的 per-action 更细。扣分：依赖**未提交的本地 SRT 补丁**；Linux glob deny 不可表达 |
| Codex 对齐度 | 15% | **6.0** | 自身 §6 建议 #1 已落地、网络默认已 fail-closed（**优于报告预期**）。扣分：报告 6/12 失效；未跟进 Codex 新增能力（AskUser 回落、运行时切 reviewer、write_stdin 审批） |
| 可靠性 / 生命周期 | 15% | **4.0** | **P1 未修复**（4 条可达路径：exit→close 窗口发旧 PGID、client 提前丢弃引用、worker 先清 `state.child`）；v4 实验失败且 stderr 原文丢失 |
| 测试与证据强度 | 10% | **6.0** | 37 文件 / ~682 用例声明；structure-invariants 质量高。扣分：末轮未跑全量；`1075 passed` 是历史；端到端 8 项未做；R1–R10 未审计 |
| 文档卫生 | 5% | **5.5** | 材料极丰富，handoff 诚实度罕见（明写"不应宣称可交付"）。扣分（评分当时）：08-27 报告出生即作废且无横幅；文档间 15 条互相矛盾；`tool-call-architecture.mmd:24` 仍写 `GrantLedger`。**同日 P0 卫生后：08-27 与 mmd 已移除，pin 约定已写入 research 文首，见 §6。** |

### 加权结果

```text
0.20×8.5 + 0.20×7.5 + 0.15×8.0 + 0.15×6.0 + 0.15×4.0 + 0.10×6.0 + 0.05×5.5
= 1.70 + 1.50 + 1.20 + 0.90 + 0.60 + 0.60 + 0.275
= 6.775  ≈  6.8 / 10
```

**拆分**：

- **设计/架构维度**（架构 + 安全 + 强制，权重 55%）≈ **8.0** —— 四者中最讲究的授权模型
- **交付/证据维度**（对齐 + 可靠性 + 测试 + 文档，权重 45%）≈ **5.4** —— 被 P1 与未验收拖住

---

## 5. 与三个上游的相对位置

| | 架构原则性 | 强制层 | 生命周期正确性 | 证据强度 | 综合 |
| --- | --- | --- | --- | --- | --- |
| **Pi** | **8.5** | 8.0 | 4.0 | 6.0 | **6.8** |
| Codex | 8.0 | 8.5 | 8.0 | 8.0 | 8.2 |
| kimi-code | 5.0 | 3.0 | 7.5 | 7.0 | 5.5 |
| MiMo-Code | 4.5 | 3.0 | 7.0 | 7.0 | 5.2 |

（上游三列为本次调研的定性判断，非本项目评分口径的严格同构对比，仅供定位参考。）

**要点**：Pi 的**架构原则性高于 Codex**（尝试冻结、单主线、反向结构断言都是 Codex 没有的），但**生命周期正确性只有 Codex 的一半** —— 而这恰恰是"独立 Guardian 子进程"这一架构选择**额外引入**的复杂度代价。这是当前投入产出比最差的一块：用架构优势换来了自己造的 P1。

---

## 6. 建议（按优先级；状态已更新）

1. **修 P1（Guardian lifecycle）** — **已完成（2026-09-10）**。见 `src/guardian-worker-client.ts` / `src/guardian-worker.mjs` / `src/sandbox/srt-enforcer.ts` 与对应 tests。
2. **08-27 报告作废处理** — **已完成**：文件已从树中移除；本文保留断言核验作为唯一对照记录。
3. **统一 Codex pin** — **已落地约定**：standing pin = `129fd216`；当日 main tip 快照（如 `b348fc2`）只能作漂移备注，不得替代 standing pin。
4. **重新评估硬编码危险命令黑名单** — 仍开放（P2）。Codex 已改用 LLM 分类且无黑名单；Pi 仍维护旧 `is_dangerous_command` 镜像。
5. **`tool-call-architecture.mmd` / `GrantLedger` 图** — **无需处理**：对应文件已不在树中。`tests/structure-invariants.test.ts` 继续反向锁定禁用模块名，防止回归。

---

## 7. 取证局限

1. Codex 为两个无父浅快照，**无法做 commit 归属**；漂移分析基于快照 diff。
2. Pi 侧为静态源码阅读，**未运行 `npm test` / `tsc`**；行数与用例数为 grep 统计。
3. 未运行任何上游项目做行为验证。
4. 本文最初为只读核验；P0 文档卫生（pin 约定、§6 状态更新）已在同日补记。
