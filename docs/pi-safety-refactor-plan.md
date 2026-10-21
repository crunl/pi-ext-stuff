# pi-safety 重构计划

> **目标架构**：安全门控 · 无人工审批 · LLM reviewer 为默认审批者 · `request_permissions` 为唯一额外权限入口
>
> **计划日期**：2026-10-20 · **重构基线**：`b9b9ab0`（engine 改名完成后）
> **文档状态**：已完成三轴独立评审（安全 / 内部一致性 / 事实准确），评审意见已吸收
> **配套图**：[`diagrams/pi-safety-target-flow.html`](./diagrams/pi-safety-target-flow.html)（目标架构流程图）
> **HTML 版**：[`pi-safety-refactor-plan.html`](./pi-safety-refactor-plan.html)

---

## 目录

<div class="doc-toc">

- [1. 目标架构](#1-目标架构)
  - [1.1 五条硬约束](#11-五条硬约束)
  - [1.2 非目标与既有决策](#12-非目标与既有决策)
- [2. 现状锚点](#2-现状锚点)
  - [2.1 人工干预面现在有哪些](#21-人工干预面现在有哪些)
  - [2.2 图例语义表（实施后必须一致）](#22-图例语义表实施后必须一致)
  - [2.3 engine 状态分层](#23-engine-状态分层)
  - [2.4 硬约束清单（实施时每步保持绿）](#24-硬约束清单实施时每步保持绿)
- [3. 两条行为契约](#3-两条行为契约)
  - [3.1 模式切换在 turn 边界生效](#31-模式切换在-turn-边界生效)
  - [3.2 ESC 终止整个 session](#32-esc-终止整个-session)
- [4. 分块实施设计](#4-分块实施设计)
  - [4.1 L1 前置只判 `deny`](#41-l1-前置只判-deny)
  - [4.2 门模型语义逐条定义](#42-门模型语义逐条定义)
  - [4.3 渲染件待办](#43-渲染件待办)
  - [4.4 engine 授权逻辑不需要重构](#44-engine-授权逻辑不需要重构)
  - [4.5 人工审批面清理清单](#45-人工审批面清理清单)
- [5. 顺序](#5-顺序)
- [6. 决策表](#6-决策表)
- [7. 不变量](#7-不变量)
- [8. 验证](#8-验证)

</div>

---

## 1. 目标架构

### 1.1 五条硬约束

| # | 约束 | 内容 |
|---|---|---|
| 1 | **LLM reviewer 是默认审批者** | 常规批准权在 LLM reviewer。唯一例外：用户通过 `rules[]` 的 `allow` **配置**预先声明安全（见 4.1.3） |
| 2 | **零用户审批面板** | 重构后 pi-safety 不含任何运行时用户审批 UI。含 `/approve` 的 `ui.select`、`ui.confirm`、`ui.prompt` 及一切「ask the user」文案全删 |
| 3 | **`request_permissions` 是唯一额外权限入口** | 除它之外不存在第二条扩权通道；不设 escalation（`67ca74f`） |
| 4 | **sandbox 仍由 pi 沙箱强制** | reviewer 不能授予 host 逃逸能力，只能在沙箱约束内放行 |
| 5 | **yolo 绕开 reviewer 与 sandbox，但绕不开 L1** | 用户配置的 deny 在 yolo 前仍拦得住 |

> **配置不是审批面板**：约束 2 禁止的是**运行时**弹窗交互。`rules[]` 是用户事先写在配置里的静态声明，写一次长期生效，不打断任何 turn——两者性质不同，不冲突。

### 1.2 非目标与既有决策

| 项 | 决定 | 说明 |
|---|---|---|
| `escalation` | **删** | `67ca74f` 已删 `escalation-policy.ts`；但 `PolicyRiskLevel` 的 `"escalation"` 词表项保留（`engine-fingerprint.ts` 参与 review 指纹） |
| `transient` 标记 | **删** | `c848cb8` 已删整条链路（`declassify-transient.ts`） |
| `failed` 出口 | **不新增** | deny 携带 `recoverable`；四个 deny 终点不合并 |
| 域名白名单网络边界 | **不新增** | `allowedDomains: []` 保持「不做进一步限制」 |
| git 元数据 deny 名单 | **本轮不扩** | 见 `security/git-metadata-policy.md` |
| 审批缓存 | **保留** | 五重指纹，仅 preview 来源可读 |
| engine 授权逻辑 | **不重构** | 见 4.4 |
| **`request_permissions` 是否受 deny 约束** | **不受**（产品决策 2026-10-20） | `evaluateRiskRequest` 在 `risk-policy.ts:288-294` 提前 return 进 `evaluateRequestPermissions`，不查 `matchRules`。保持现状：用户 deny 规则对它无效 |
| **外来工具（MCP / 其他扩展注册）** | **完全不管**（产品决策 2026-10-20） | `register.ts:2316-2326` 早退，既不沙箱也不评审。**但必须删掉 `src/permissions/rules.ts:140` 谎称 `mcp__*` 能覆盖 MCP 的注释**（见 4.2.9） |

---

## 2. 现状锚点

> **2 节描述现状；4 节描述目标；冲突时以 4 节为准。**

### 2.1 人工干预面现在有哪些

| # | 面 | 位置 | 处置 |
|---|---|---|---|
| 1 | `/approve` 命令 | `register.ts:2346-2400` | **删**（4.5） |
| 2 | `ui.select("Auto-review denials")` | `pi-safety.ts:506`（唯一一处 `.select(`） | **删**（4.5） |
| 3 | `approvalOverride` 信任通道 | `engine.ts:253` | **删**（4.5） |
| 4 | deny 文案「ask the user」 | `permission-copy.ts:92,102,114,173`；`register-tool-copy.ts:11,14` | **改写**（4.5） |
| 5 | `request_permissions` 主动扩权 | `register-request-permissions.ts` | **保留**（约束 3） |

> **注入点**：reviewer 在 `register.ts:266`（`guardian: createPiGuardianAdapter(autoReviewer)`）注入，可被 `options.autoReviewer` 覆盖（`:223`）。

### 2.2 图例语义表（实施后必须一致）

| 视觉 | 语义 | 节点 |
|---|---|---|
| **黄** | 沙箱 | `sbxA`、`sbxN`、`sbx`、`rSbx`、`lease` |
| **红** | 终止 | `blocked`、`vDeny`、`ret`、`rret` |
| **蓝** | 决策 | `eCall`、`toolCall`、`g1`、`g2`、`g3`、`ruleEval`、`kExec`、`arb` |
| **绿** | 放行 | `exec`、`vAllow`、`vAsk`、`rAllow`、`rp`、`rret2`、`done`、`grant`、`ext` |
| **灰** | 数据 | `cfg`、`input`、`logs`、`sig`、`deny` |
| **紫** | 审批 | `rrev`、`pnl`、`arule` |
| **实线** | 顺序 / 依赖 | — |
| **虚线** | **路径存在性**（可能不走） | `g1 ⇢ toolCall`、`g2 ⇢ vDeny`、`vAsk ⇢ rret`、`rSbx ⇢ rret2`、`rp ⇢ rret`、`g3 ⇢ rrev` |
| **无箭头线** | 同容器（纯视觉） | `leash` |

> **一色一义**：红只表示终止，不表示「有害」「拒绝」。vAsk 画绿不画红（见 4.2.3）。
> **见 4.2.1**：`allow`/`ask` 不进 L1。

> **`vDeny` 无出口**（三轴评审 C1 的处置）：红 = 终止，`vDeny` 是纯终局节点。
> `writeOutsideRoots`（`register.ts:1795-1812`）不是 deny，是**在沙箱内继续执行**的路径——它不画成 `vDeny` 的放行边，否则破坏「一色一义」。正确画法是作为 `vAllow → sbxA` 路径上的**标注**（badge），不是节点出口。

### 2.3 engine 状态分层

engine **保留为容器**（有状态核心，不拆）。状态分三层：

| 层 | 状态 | 生命周期 | 处置 |
|---|---|---|---|
| **进程级** | `generation:876`、`active:877`、`sessionKey:878`、`configKey:879`、`circuitOpen:883`、`reviewSequence:887`、`reviewControllers:888`、`inFlightCallIds:889`、`inFlightAttempts:890` | 进程级，跨 turn 保持 | **保留** |
| **进程级** | `retrySequence:880`、`retryRecords:884`、`denialNotices:885`、`armedRetry:886` | 同上 | **删**（4.5） |
| **Turn 级** | `TurnState:426`（`generation:427`、`snapshot:428`、`turnNetworkHosts:429`、`turnNetworkAll:430`、`turnWriteRoots:431`、`grants:432`、`approvals:433`、`closed:434`） | turn 级 | **保留**（与模式切换契约一致） |

**熔断与统计**：`denialWindow:881`、`consecutiveDenials:882`、`recordDenialStats`（`engine.ts:911`）**保留**——它们支撑 deny 熔断，属 4.2 的「多计数」观测数据，不是人工审批面。

**审批缓存**：`readApprovalCache:1337-1374`（仅 preview 来源可读）、`consumeGrant:1314-1320`、`requestCovered:744` **保留**。缓存注释明确「manual-retry 路径永不读取」（`:448`）。

### 2.4 硬约束清单（实施时每步保持绿）

- `sandbox-policy.ts` 在 engine value-closure 内禁止 `node:fs`；闭包内禁止 `sandbox.ts`
- host 包白名单仅 `["src/guardian-tools.ts", "src/register.ts"]`（`tests/structure-invariants.test.ts:367`）
- 结构不变量测试全绿（`tests/structure-invariants.test.ts`）
- **零用户审批面板**（见 7）

---

## 3. 两条行为契约

### 3.1 模式切换在 turn 边界生效

**契约**：用户在 turn 进行中切换 `auto ↔ yolo` 时，当前 turn 继续使用**进入 turn 时的模式快照**；新模式从下一个 turn 的 `turn_start` 起生效。

**为什么不是 turn 内生效**（三条真实原因）：

1. **pi 无批次级事件**：`executeToolCalls`（`agent-loop.ts:508-523`）默认并行执行，无 `tools_before_batch` 之类的通知，`before_tool_call` 是每调用粒度，无法在批次边界插入刷新。
2. **并行批次内授权会分裂**：`executeToolCallsParallel`（`agent-loop.ts:586-650`）prepare 串行（`:601-635`）、执行 `Promise.all`（`:637-639`）——同批工具可能各拿各的模式快照。更糟的是 SRT 是**进程级单例**（`sandbox-policy.ts:281`），两个工具会互相踩 `activate()`。
3. **`message_end` 不是安全接缝**：它在 UI 分发/落盘前被 `await`（`agent-loop.ts:942-944`），静止性不保证——SRT 有 15 秒排空窗口（`srt-coordinator.ts:19` `SRT_DRAIN_TIMEOUT_MS = 15_000`），并发 subagent 共享同一个 SRT manager。

**已知弱点**（不修，记录在案）：状态栏 turn 内中途可能显示期望模式，而实际快照仍旧——用户看到的和生效的会有短暂不一致。

**唯一未来路径**：pi 上游增加 `tools_before_batch` 事件。届时可改为批次前刷新，契约随之收紧。

> **被否决的说法**（不重复采信）：「`message_end` 是静止点」「turn 内刷新不会分裂」「SRT 冲突可以靠锁解决」——三条都已在论证中被推翻。

### 3.2 ESC 终止整个 session

**契约**：ESC（`app.interrupt`）终止整个 session 的工作，不保证「立即可重试」。

**六层链路**（已核实）：`keybindings.md:124` `app.interrupt = escape` → `agent-session.ts:2464`（含 `await waitForIdle()`）→ `agent.ts:341` → `agent-loop.ts:809` signal → `bash.ts:141-144` 杀进程树 / `:155-158` 返回 `128+signal` → `agent-loop.ts:581` break。

**三条 engine 残留**（属清理时序问题，排计划末尾，不影响契约）：

1. abort reason 被丢弃，不进入审计链
2. `abortAttempts` / `abortReviews` 不对称
3. ESC 不走 `invalidate:2506`，旧 generation 状态可能残留到下一个 turn

---
---

## 4. 分块实施设计

### 4.1 L1 前置只判 `deny`

**结论**：`allow`/`ask` 不能进 L1，只有 `deny` 可以。**L1 不替代 `evaluateManagedRisk`，只在其前叠加。**

**现状缺口**：bash / write / edit 是 `PI_OWNED_TOOL_NAMES` 的成员，在 `register.ts:2316` 的 `tool_call` 早退。host-first（read / grep / find / ls）在 `register.ts:1448-1465` 走 `evaluateHostFirstRulesOnly`（只认 `deny`）；受管工具在 yolo 下**完全不查规则**：

- bash：`register.ts:1592-1602` yolo 下 `risk = undefined`，`evaluateManagedRisk` 根本不调用
- write/edit：`riskForFileMutation:1777` yolo 直接返回 `undefined`
- engine 也不是第二道防线：`engine.ts:1078-1080` yolo 下直接 `return { kind: "approve" }`

结果：`register.ts:1447-1449` 注释承诺「a deny rule wins in every mode」，**但只在 host-first 路径成立**。

#### 4.1.1 为什么 `ask` 不能进 L1

`ask` 的定义是**强制进 LLM reviewer**（`risk-policy.ts:456-462` 的 force-review 门）。若 L1 前置短路 `ask`：

- 在 **yolo** 下：yolo 已绕开 reviewer，`ask` 无从「强制 review」，只剩强制阻断——**与约束 5「yolo 绕开 reviewer」直接冲突**。
- 在 **auto** 下：L1 提前短路会绕开 `decide()` 的门序（deny → force-review → allow），语义重复且易分叉。

**落点**：`ask` 留在 L2（`risk-policy.ts:456-462`）。

#### 4.1.2 为什么 `allow` 不能进 L1

`allow` 的语义是**用户声明安全 → 沙箱内直接执行**（4.1.3）。它有两个依赖，只有 L2 判定完才知道：

1. **`Forbidden` 仍优先**：`risk-policy.ts:465-468` 的 allow 门条件是 `decision === "allow" && risk !== "Forbidden"`。`Forbidden` 是不可被 `allow` 覆盖的硬阻断。
2. **写根判定**：`!grantsWriteRoots`——动作请求写根时 `allow` 不生效。

若 L1 提前放行 `allow`，这两条都会被绕过。

#### 4.1.3 `allow` 的语义（产品决策 2026-10-20）

> **`allow` = 用户在配置里预先声明「这个安全」→ 直接在 sandbox 里跑，不进 LLM reviewer。**

- **不绕沙箱**：`allow` 只免除 reviewer，不解除沙箱约束（lease 仍是 `sandboxed`，不是 `unrestricted`）。
- **不覆盖硬阻断**：`Forbidden`、deny 规则、写根判定照旧优先。
- **不违背约束 2**：`rules[]` 是事先写好的静态配置，不是运行时审批面板。
- **reviewer 的定位因此是「默认审批者」而非「唯一审批者」**——用户用 `allow` 预先批准，用 `deny` 预先否决，运行时只有 reviewer 在裁决。

#### 4.1.4 实施：`tool_call` 单接缝（三轴研究结论）

**接缝放在 `pi.on("tool_call")` 内、`PI_OWNED_TOOL_NAMES` 早退之前**（`register.ts:2316`），
一处覆盖 bash / write / edit / host-first / subagent。

> **为什么不是 3 个 execute 入口**（两个独立 subagent 收敛到同一结论）：
>
> | | 3 个调用点（原设计） | `tool_call` 单接缝 |
> |---|---|---|
> | 遗忘点 | 3 处「记得调」 | 1 处 |
> | 未来工具 | 新注册的工具静默绕过 L1 | 自动覆盖 |
> | 错误传播 | 两套（`throw policyDeniedError` vs 返回 `{block}`） | 一套 |
> | 测试面 | 碎片化，要测过接口摸内部 | 所有工具走同一接口 |
> | 产品决策吻合 | 要单独把 `request_permissions` 摘出来 | 钩子里一个过滤条件 |
>
> **决定性证据**：`ToolCallEventResult`（pi `core/extensions/types.d.ts:1089`）原生就是拦截结构：
> `{ block?: boolean; reason?: string; terminate?: boolean }`。
> 而 `evaluateHostFirstRulesOnly` 返回的正是 `{ block: true; reason } | undefined`——**形状天然吻合，不需要适配**。
> 这接口本来就是为拦截准备的，不是「能塞进去」。

**代码形状**：

```typescript
pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
  // L1：deny 规则，auto 与 yolo 都拦得住（在任何 mode 分支之前）
  if (event.toolName !== "request_permissions") {
    const denial = evaluateDenyRulesOnly(event.toolName, event.input, cwd, config);
    if (denial) return { block: true, reason: denial.reason };
  }

  if (PI_OWNED_TOOL_NAMES.has(event.toolName)) return;           // bash/write/edit
  if (PI_HOST_FIRST_TOOL_NAMES.has(event.toolName) ||
      DELEGATED_TOOL_NAMES.has(event.toolName)) {
    return evaluateHostFirstToolCall(event, ctx);                  // read/grep/find/ls/subagent
  }
  return;                                                          // 外来工具：不拦（产品决策）
});
```

**两个豁免在同一处断言**（而非「哪里没调」的涌现结果）：
`request_permissions` 豁免 = 那一个 `!==` 条件；外来工具豁免 = 落到最后的 `return`。

#### 4.1.5 函数改名与去重

**改名**：`evaluateHostFirstRulesOnly` → **`evaluateDenyRulesOnly`**。

> **名实不符是真实的接口缺陷，不是美观问题**：函数体内**零 host-first 专属逻辑**，
> 就是 `normalizeToolCall` + `matchRules` + 只认 `deny`。名字说「host-first 专用」，
> 调用方却必须读实现才知道 `HostFirst` 是历史误称——按 deep-module 判据，这破坏接口完整性。
> 应改名为真职责。

**去重**：L1 移到钩子后 host-first 会被查两次（钩子一次 + `evaluateHostFirstToolCall` 内部一次）。
按 locality 原则只留一处——但 `evaluateHostFirstToolCall` 还背着 `checkDelegateSpawn`
（subagent 的委托检查，`register.ts:1469-1484`），不能整块删，只能去掉内部那次 L1。

**删除测试（deletion test）**：当前**只有 1 个生产调用方**（`register.ts:1450`）。
`risk-policy.ts:271` 是废弃包装，其注释 `:262-263` 自陈「Not used by register.ts host-first path
after foreign A / host-first B cut」。另有 4 处测试调用（`tests/risk-policy.test.ts`）。

#### 4.1.6 L1 deny 的返回形状

命中 deny 时返回 `{ block: true, reason }`（钩子层）或抛 `policyDeniedError`
（`register-support.ts:76`，工具包装层），`recoverable: "no"`（与 4.2 第 2 行的 L2 硬阻断一致）。
这是**配置级否决**，无重试路径。

> **测试面随接缝统一**——所有工具走同一形状，不需要测过接口摸内部：
>
> ```typescript
> const blocked = await invoke(app, "tool_call", {
>   type: "tool_call", toolName: "bash", input: { command: "rm -rf /" },
> });
> expect(blocked).toMatchObject({ block: true });
> ```

### 4.2 门模型语义逐条定义

| # | 语义 | 决定 |
|---|---|---|
| 1 | `allow`/`ask` 不进 L1 | **不画进目标图**。L1 只画 `deny` 一条虚线到 `vDeny`（见 4.1） |
| 2 | L2 硬阻断 | git network / git metadata / remote hosts / extra write roots / protected-path → `vDeny`，全部 `recoverable: "no"` |
| 3 | `ask` 的语义 | **强制进 reviewer**，不是弹窗。`vAsk` 画绿（它不是终止） |
| 4 | `writeOutsideRoots` | `register.ts:1795-1812` 设 flag **后继续在沙箱内执行**。画成 `vAllow → sbxA` 路径上的**标注**，不画成 `vDeny` 的出口（见 2.2） |
| 5 | `{kind:"failed"}` | **不是出口**，是工具返回形状。**不画进目标图** |
| 6 | `sbxA` 的出口 | 两个：`exec` 与 `rret2`。`runtimeDenialPolicy: "terminal"`（`register.ts:1646`）vs `"review-and-retry"`（write/edit `:1877`）用边标注区分，不新增节点 |
| 7 | `rret2` 的语义 | 沙箱内执行被拒（如 SRT 失败）后的返回，`recoverable` 由上游决定 |
| 8 | `ext` 的语义 | 外部副作用（网络 / 写 host），从 `exec` 虚线到 `ext` |
| 9 | **外来工具（MCP / 其他扩展）** | **完全不管**（产品决策）。**但必须删掉 `src/permissions/rules.ts:140` 的误导注释**——它宣称 `mcp__*` 能覆盖 MCP 工具，而外来工具在 `register.ts:2316-2326` 早退，`matchRules` 根本不跑。留着就是配置面在撒谎 |
| 10 | `grant` 的出口 | **不是唯一出口**。`grant` 后仍可 `rret`（如 reviewer 后续拒绝） |
| 11 | **形状非法** | `rp → rret` 直连边（v4 的画法），不是 `rp → rpr → rret` |
| 12 | `arb` 的位置 | 裁决点在 `g3` 之后、`exec` 之前 |

### 4.3 渲染件待办

| # | 项 | 状态 |
|---|---|---|
| 1 | `writeOutsideRoots` 标注（4.2 第 4 行） | **待补**（渲染件 `writeOutside` 零命中） |
| 2 | `g2 ⇢ vDeny` 虚线 | v4 已如此；实施时保持 |
| 3 | `rp → rret` 直连边 | v4 已修，见 4.2.11 |
| 4 | 4.2 第 6、10、12 行的边标注 | **待补** |

### 4.4 engine 授权逻辑不需要重构

engine 的授权判定（`authorizeInlineCapability:2303`、`authorizeCapability` 注入点 `:1503`）**保持不动**。engine 是有状态容器，只做**减法**（4.5 删除人工审批面状态）。

> 例外：4.5 的删除会触碰 `engine.ts`，但那是**移除服务链**，不是重构授权逻辑。

### 4.5 人工审批面清理清单

> **处置原则**：删的是「服务 `/approve` 人工重试」的那一半；`recordDenial` 的**统计那一半必须保留**（它喂 deny 熔断，见 2.3）。

| # | 符号 | 位置 | 处置 |
|---|---|---|---|
| 1 | `pi.registerCommand("approve")` | `register.ts:2346-2400` | 删 |
| 2 | `recoverDeniedAction` 实现 | `pi-safety.ts:494-520` | 删 |
| 3 | `recoverDeniedAction` 声明 | `pi-safety.ts:258` | 删 |
| 4 | `RecoverDeniedActionResult` | `pi-safety.ts:209` | 删 |
| 5 | `retryChoice` helper | `pi-safety.ts:275-288` | 删 |
| 6 | `ui.select("Auto-review denials")` | `pi-safety.ts:506` | 删 |
| 7 | `retrySequence` | `engine.ts:880` | 删 |
| 8 | `retryRecords` | `engine.ts:884` | 删 |
| 9 | `RetryRecord` 接口 | `engine.ts:477` | 删 |
| 10 | `denialNotices` | `engine.ts:885` | 删 |
| 11 | `MAX_DENIAL_NOTICES` | `engine.ts:540` | 删（否则 unused 报错） |
| 12 | `armedRetry` | `engine.ts:886` | 删 |
| 13 | `listDenials` 接口 | `engine.ts:421` | 删 |
| 14 | `armRetry` 接口 | `engine.ts:423` | 删 |
| 15 | `RetryHandle` | `engine.ts:248` | 删 |
| 16 | `DenialNotice` | `engine.ts:348` | 删 |
| 17 | **`onDenial` 声明** | `engine.ts:358` | 删（已核实全仓无消费方） |
| 18 | **`onDenial` 调用** | `engine.ts:1005-1009` | 删 |
| 19 | `consumeArmedRetry` | `engine.ts:895-897` | 删 |
| 20 | `makeRetryHandle` | `engine.ts:948-953` | 删 |
| 21 | `armRetry` 实现 | `engine.ts:2421-2439` | 删 |
| 22 | `listDenials` 实现 | `engine.ts:2414` | 删 |
| 23 | cleanup 中 retry 相关 | `engine.ts:2450-2451`、`:2512-2514` | 删 |
| 24 | **engine 工厂返回对象** | `engine.ts:2547` | 改（去掉 `listDenials`/`armRetry`） |
| 25 | **`recordDenial` 的 retry/notice 半** | `engine.ts:957-1011` | **改写，不整删**（`:969` 的 `recordDenialStats()` 必须留） |
| 26 | **`blocked(..., retryHandle)` 两处** | `engine.ts:2074`、`:2218` | 改为 `blocked(error)` |
| 27 | **`retryFingerprint`** | `engine-fingerprint.ts:58` | 删（4 处调用全在 retry 链上） |
| 28 | **`"manual-retry"` source + `ApprovalOverride`** | `engine.ts:2043`、`:2153`、`:2044-2047` | 删 |
| 29 | **`renderExactRetryInstruction`** | `permission-copy.ts:252` | 删 |
| 30 | **approve 专用 notice kinds** | `permission-copy.ts:42-45`（`approve-requires-mode`/`-requires-ui`/`-empty`/`-stale`）、渲染 `:218-225` | 删 |
| 31 | **`tests/register.test.ts:4124`**（断言 `pi-safety-auto-override`） | — | 删 |
| 32 | deny 文案「ask the user」 | `permission-copy.ts:92,102,114,173` | 改写（见下） |
| 33 | **「求用户切 yolo」话术** | `register-tool-copy.ts:11,14` | **删**（真的人工绕过指令，不能只洗 "ask the user"） |

> **不在清单内**：`src/engine-clone.ts` **不要动**——它只有 `runtimeDenialPolicy`（`:68-88`，执行后沙箱拒绝策略），与 retry / denial 链无关。

**隐性引用者**（符号 grep 抓不到，不在上面 33 项内，但删完必须一并改）：

| 类别 | 引用者 | 为什么漏掉 |
|---|---|---|
| **测试（大）** | `tests/engine.test.ts`（**66 处**：`import RetryHandle:14`、`armRetry`/`listDenials`/`retryHandle`/`manual-retry`/`approvalOverride` 断言 `:843-2231`） | 只列了 `tests/register.test.ts` |
| **源码** | `src/pi-guardian-adapters.ts`（**4 处** `approvalOverride`、`approvalOverrideFromEngine`） | **不在步骤 2 的 9 文件清单里**（只在步骤 3） |
| **字符串臂** | `src/permissions/residual.ts:84-85,102-103`（`"manual-retry"` switch case）、词表 `:11` `"manual_retry"` | 字符串不是符号，grep 不到 |
| **测试（其余）** | `tests/{pi-safety:199,pi-safety-nesting:104,107,heap-soak:77,engine-native-retry:259,312,permissions-residual:28,131,pi-guardian-adapters:349-363,auto-review-request:359-398,auto-reviewer:5,310-320}.test.ts` | 只列了 2 个测试文件 |
| **字符串断言** | `tests/permission-copy.test.ts:26` 断言 `"stop and ask the user"`；`tests/register.test.ts:726` 断言 `"switch to yolo"` | 断言的是文案，不是符号 |
| **Outcome 形状** | `src/engine.ts:345`（`{ kind: "blocked"; retryHandle?: RetryHandle }`）、`blocked()` helper `:1049-1052` | 原表只列了 2 处调用点 |
| **请求字段** | `src/auto-review-request.ts:92,130,159,203`（`approvalOverride`） | 原表只列了 prefix 两行 |
| **文档** | `extensions/pi-safety/{README.md:20,52,118, README.zh-CN.md:11,40,72, AGENTS.md:159,243}`、`APPEND_SYSTEM.md` | 都在教用户 `/approve` |

> **教训**：删除清单若按**符号名 grep** 产出，会系统性漏掉三类东西——**字符串字面量**、
> **switch case 臂**、**测试断言的文案**。本轮补的就是这三类。

> **信任通道必须一起拆**：`approvalOverride` + `"manual-retry"` + `AUTO_REVIEW_DENIED_ACTION_APPROVAL_DEVELOPER_PREFIX`（`auto-review-request.ts:104-105`）是一条「用户已批准」的 developer 权威通道（`renderAutoReviewTrustedContext:203-214`）。只删锁不拆通道 = 留下一个**无人认证的伪造批准口**，比保留 `/approve` 更危险。

**文案改写原则**：

- `review-denied`（`permission-copy.ts:92`）、`circuit-open`（`:173`）分支**只写「停止」**，不写「等 reviewer 裁决」——前者 reviewer 已终局拒绝，后者 reviewer 不可用，「等待」等于对非确定性审批者再掷一次骰子。
- `permission-copy.ts:102,114` 可写「等待 reviewer 裁决」（review 尚未终局）。

---

## 5. 顺序

| # | 步骤 | 触碰文件 | 验证 |
|---|---|---|---|
| 1 | **L1 前置**：`pi.on("tool_call")` 单接缝（见 4.1.4）+ 函数改名 `evaluateDenyRulesOnly` | `src/register.ts`、`src/risk-policy.ts` | **auto 与 yolo** 两模式下 deny 都拦得住 bash/write/edit；`request_permissions` 不受影响；委托包络在 auto 下仍生效 |
| 2 | **拆 `/approve` 服务链**（4.5 全 33 项 + 隐性引用者），拆成 4 个各自落绿的切口 | 见 4.5 的完整清单（含测试） | 每个切口后 `tsc` + 全量测试绿；grep 全清单符号**且字符串**零命中 |
| 3 | **`"prompt"` → `"review"` 改名** | `src/risk-policy.ts`、`src/pi-guardian-adapters.ts`、`src/auto-review-request.ts`、**`src/register.ts`**、**`src/register-request-permissions.ts`**、相关测试 | `tsc` 干净（**注意 3 处比较点**：`register.ts:1607`、`:1803`、`register-request-permissions.ts:135`） |
| 4 | **渲染件补分支**（4.3 第 1、4 项 + 4.2 标「待补」的行） | `docs/diagrams/pi-safety-target-flow.html` | 按 **4.2 行号清单**逐行断言存在 |
| 5 | **文档对齐**（含 README 与 AGENTS） | `docs/pi-safety.md`、`extensions/pi-safety/AGENTS.md`、`extensions/pi-safety/README.md`、`extensions/pi-safety/README.zh-CN.md`、`APPEND_SYSTEM.md`、`security/git-metadata-policy.md` | 无「ask the user」；无 `/approve` 引用 |
| 6 | **（可选）ESC 清理**（3.2 三条残留） | `src/engine.ts` | 3.2 契约不变 |

> **步骤 1 不要碰 `register-request-permissions.ts`**：产品决策（1.2）是
> `request_permissions` 不受 deny 约束。原计划把它当第三入口是**自相矛盾**——照做会让 §8 检查 3 必然红。
>
> **步骤 2 拆成 4 个各自落绿的切口**（互不阻断，每步可提交）：
>
> | 切口 | 内容 | 必须同 commit 的原因 |
> |---|---|---|
> | 2a | engine retry 状态 + `approvalOverride` 信任通道 | 两者互相引用，拆开必红 |
> | 2b | `recoverDeniedAction` UI 链 + `ui.select` | — |
> | 2c | 文案改写（含 `register-tool-copy.ts` 的 yolo 话术） | 同步改断言字符串的测试 |
> | 2d | approve 命令 + 专用 notice kind | — |
>
> **步骤 2 的隐性引用者**（符号 grep 抓不到，必须一并改）：
> `tests/engine.test.ts`（**66 处**）、`src/pi-guardian-adapters.ts`（4 处 `approvalOverride`，
> 压根不在原 9 文件清单里）、`src/permissions/residual.ts` 的 `"manual-retry"` **switch 字符串臂**
> （`:84-85`、`:102-103`）、以及 `tests/{pi-safety,pi-safety-nesting,heap-soak,engine-native-retry,
> permissions-residual,pi-guardian-adapters,auto-review-request,auto-reviewer,permission-copy}.test.ts`。
> **字符串断言**（`tests/permission-copy.test.ts:26` 的 `"stop and ask the user"`、
> `tests/register.test.ts:726` 的 `"switch to yolo"`）是最大盲区。
>
> **步骤 3 的触碰清单**：`"prompt"` 不只被**构造**，还被**比较**。只改 union 成员不改那 3 处比较点，`tsc` 直接红。

---

## 6. 决策表

| 决策 | 结论 | 依据 |
|---|---|---|
| escalation | 删 | `67ca74f` |
| 门模型 | 三组门；`Forbidden` 不是 deny 门 | `279eef3` |
| `host-admitted` | 保留 | — |
| `escalatedGitDestinationUnbound` | ~~删除~~ **已完成**（`src/` grep 零命中） | — |
| `transient` 链路 | ~~整条删除~~ **已完成**（`src/` grep 零命中） | `c848cb8` |
| `failed` 出口 | 不新增，也不画进目标图 | 4.2 第 5 行 |
| 审批缓存 | 保留 | 2.3 |
| `"escalation"` 词表项 | 保留 | `engine-fingerprint.ts` |
| engine 是否重构 | **不** | 4.4 |
| engine 画法 | 画容器 | — |
| `vDeny` 出口 | **无出口**，`writeOutsideRoots` 画标注不画边 | 2.2 / 4.2 第 4 行 |
| `action:"prompt"` | 改名 `review` | 4.5 命名修正（**不是** 4.1） |
| `allow` 语义 | 用户声明安全 → 沙箱内跑，跳过 reviewer | 4.1.3（产品决策 2026-10-20） |
| L1 接缝 | **`tool_call` 单接缝**（非 3 个 execute 入口） | 4.1.4（三轴研究） |
| L1 复用 | 复用 `evaluateHostFirstRulesOnly` 并**改名 `evaluateDenyRulesOnly`** | 4.1.5 |
| `request_permissions` 受 deny 约束 | **不受** | 1.2（产品决策 2026-10-20） |
| 外来工具 | **完全不管**，但删 `rules.ts` 误导注释 | 4.2 第 9 行 |

---

## 7. 不变量

- `sandbox-policy.ts` 在 engine value-closure 内禁止 `node:fs`；闭包内禁止 `sandbox.ts`
- host 包白名单仅 `["src/guardian-tools.ts", "src/register.ts"]`
- **零用户审批面板**：`grep -rn '\.select(\|\.confirm(\|\.prompt(' extensions/pi-safety/src/` **零命中**
- **`/approve` 服务链零残留**：`RetryHandle|armRetry|listDenials|DenialNotice|onDenial|retryRecords|armedRetry|retryFingerprint|MAX_DENIAL_NOTICES|ApprovalOverride|manual-retry|manual_retry|recoverDeniedAction|retryChoice|renderExactRetryInstruction|approvalOverride` **零命中**
- L1 只判 `deny`：`allow`/`ask` 不出现在 L1 路径

> **必须是结构不变量测试，不能只靠 grep**：grep 是一次性检查，跑一次就失效。零面板不变量应加进 `tests/structure-invariants.test.ts`（归属**步骤 2**）。

---

## 8. 验证

> **「能失败」才算检查。** 表中标 ⚠️ 的项在补齐对应测试/断言前是**不可证伪**的——
> 照原样跑会通过，但什么也证明不了。

| # | 检查 | 命令 / 依据 | 归属 | 能否证伪 |
|---|---|---|---|---|
| 1 | L1 deny 在 **auto 与 yolo** 下都拦得住 bash/write/edit | `tool_call` 事件级行为测试（形状见 4.1.6） | 步骤 1 | ⚠️ 需新写；现有 yolo deny 覆盖（`engine.test.ts:2495`）走 engine `policy.check` 而非 `config.rules`，L1 哪怕没写它也绿 |
| 2 | **委托包络在 auto 模式下仍生效** | 行为测试 | 步骤 1 | ⚠️ 需新写；yolo 下 `delegation-policy.ts:104` 直接放行，测了是空的 |
| 3 | `request_permissions` 不受 deny 影响（回归） | 行为测试 | 步骤 1 | ⚠️ 需新写；**注意：步骤 1 不碰它，否则这条必然红** |
| 4 | `/approve` 服务链零残留 | `grep -rn '<符号>' extensions/pi-safety/src extensions/pi-safety/tests` | 步骤 2 | **必须锚定路径**；repo 全局跑会命中本计划文档自己 |
| 5 | 结构不变量测试绿 | `tests/structure-invariants.test.ts` | 步骤 2 | 真可证伪 |
| 6 | `tsc` 干净（含 3 处 `"prompt"` 比较点） | `tsc --noEmit`` | 步骤 3 | 真可证伪 |
| 7 | 渲染件 4.2 标「待补」的行**逐行断言存在** | 按 **下表的具体 id/字符串** grep | 步骤 4 | ⚠️ 原写法空的；必须给具体断言字符串 |
| 8 | 文档无「ask the user」/ `/approve` 引用 | 对 **6 份文档** grep：`docs/pi-safety.md`、`extensions/pi-safety/{AGENTS.md,README.md,README.zh-CN.md}`、`APPEND_SYSTEM.md`、`security/git-metadata-policy.md` | 步骤 5 | 原清单漏了 `README*`、`AGENTS.md`、`APPEND_SYSTEM.md`（它们都在教用户 `/approve`） |
| 9 | 无 `mcp__*` 误导注释 | `grep -n 'mcp__' extensions/pi-safety/src/permissions/rules.ts` | 步骤 2 | **原路径错**：`src/rules.ts` 不存在，真路径是 `src/permissions/rules.ts:140`。对不存在的路径 grep 永远通过 |
| 10 | 全量测试 | `pnpm -C extensions/pi-safety test` | 每步 | 真可证伪（但证伪不了 L1 缺失/图错/文档旧） |

**检查 7 的具体断言字符串**（补齐后才能当检查用）：

| 4.2 行 | 要在渲染件里 grep 的内容 |
|---|---|
| 4（`writeOutsideRoots`） | `writeOutside` 当前零命中，必须新增 |
| 6（`sbxA` 出口） | `runtimeDenialPolicy`、`review-and-retry` 边标注 |
| 10（`grant` 非唯一出口） | `grant` → `rret` 边 |
| 12（`arb` 位置） | `arb` 位于 `g3` 与 `exec` 之间 |

---

> **两轮独立研究**（2026-10-20）：
> **第一轮**（安全 / 内部一致性 / 事实准确）——「方向对，但按原样实施会编译不过」。
> 已吸收：2 个 P0 编译缺陷、12 项删除清单遗漏、9 处行号错、7 处一致性问题、6 条安全问题。
> **第二轮**（接缝位置 / 执行风险 / 替代设计，配 `codebase-design` deep-module 词汇）——
> 推翻了 §4.1.4 的接缝选择：两个独立 subagent 收敛到 `tool_call` 单接缝；
> 执行风险轴找出 16 项隐性引用者与 3 条空检查。
> 三条产品决策（`request_permissions` 不受约束 / 外来工具不管 / `allow` = 声明安全）由用户于 2026-10-20 拍板。
