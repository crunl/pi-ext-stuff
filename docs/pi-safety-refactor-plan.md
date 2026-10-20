# pi-safety 重构：链路最简骨架

Status: **第 2、3 步已落地；第 1、4 步判定无需改动**（见 7 节）。第 8 节的命令
模型分层未开始。基线：`npm run check` 零错误，1805 tests 通过 1 跳过，biome 干净。

所有路径相对 `extensions/pi-safety/`。规模基线：`src/` 58 个模块 24,459 行，
`tests/` 27,925 行。

## 0. 为什么重构

现行模型是**人类在环**：静态分析证明不了安全 → 弹窗问人类；需要更高权限 →
弹窗问人类。人类是最终权威，所以代码里到处是「把这个决定交回人类」的通道。

目标模型是**人类完全出环**：

> 安全门控 · 无人工审批 · LLM reviewer 是唯一审批者 ·
> `request_permissions` 是唯一的额外权限入口

这不是功能增删，是权威来源的替换。它推出四条硬约束：

| 约束 | 理由 |
| --- | --- |
| 不设 escalation | escalation 的本质就是「把决定交回人类」，人类不在环里，这条通道不存在 |
| 静态层必须保留 `deny` 出口 | 否则所有证明不了安全的都推给 LLM，LLM 成为万能背锅侠 |
| `request_permissions` 是唯一额外权限入口 | 没有「人类说可以就可以」了，扩权必须显式请求、显式被审 |
| yolo 必须保留 | 它是唯一让人重新回到环里的开关，代价是放弃静态分析与 LLM 裁决 |

要绕沙箱就切 yolo。不提供第三条路。

## 1. 目标链路

一次工具调用穿过四层，每层只有一个职责：

```text
  tool_call event
        |
        v
+-- L1 gate: user deny --------+--hit--> blocked  (yolo included)
|   tool name + cmd pattern    |
+------------------------------+
        | miss
        v
+-- mode === yolo ? -----------+--yes--> bare run (no sandbox, no L2, no L3)
+------------------------------+
        | no
        v
+-- L2 static risk analysis ---+--deny-> blocked
|   1. prove dangerous         |
|   2. prove safe              |
|   3. neither  --> review     |
+------------------------------+
        | review
        v
+-- L3 LLM reviewer -----------+--deny-> return
|   sole approver              |
|   turn-scoped cache hit skips|
+------------------------------+
        | approve
        v
+-- L4 SRT sandboxed exec -----+
+------------------------------+

  side path (does not execute a command):
  request_permissions --> L3 reviewer --approve-->
      widen turn sandbox scope (not a bypass; cleared at turn end)
```

两层 deny 必须分开，这是整个设计的接缝。L1 在 yolo 判断**之前**，所以两种模式
都生效；L2 被 yolo 跳过。合成一层则 yolo 要么失去「用户明令禁止仍然有效」，
要么失去「裸跑」语义。

## 2. L2 静态层：从分类器改为有序证明

### 2.1 现在的病灶

`risk-policy.ts:228` `evaluateRiskRequest(tool: string, input: Record<string, unknown>, ...)`
—— 函数不知道自己处理什么工具，类型信息在边界处丢失，后续全靠字符串匹配：

```ts
if (request.operation === "execute" && gitNetwork?.unsafeReason)
if (tool.toLowerCase() !== "bash" || command === undefined)
if (typeof input.command === "string")
```

由此产生四个连锁问题：

**默认方向错了。** 现在先算 `risk`，再用五路析取式判断是否需要审批：

```ts
const wouldPrompt = promptedByRule || risk !== "Skip" || escalationRequested || ...;
```

最后一行 `return { action: "allow", risk, reason: "Low-risk operation" }` 表明
**默认是 allow**。fail-closed 系统里默认应当是 review。

**`NeedsApproval` 被当成裁决。** 它实际是「没有任何裁决」的落空状态，却被建模成
`ApprovalDisposition` 三值之一。

**可变升级污染判断。** `if (filesystemWriteRoots.length > 0 && risk === "Skip") risk = "NeedsApproval"`
—— 额外写根是*授权*，不是*证明问题*，不该改变裁决。

**注释取代结构。** 最长的注释块 20 余行解释 `escalatedGitDestinationUnbound` 为何
存在。注释写得好，但它存在本身说明这个判断无法从代码结构读出。

### 2.2 目标形态

核心是一个 10 行 helper 加两组谓词：

```ts
type Recoverability = "fix-arguments" | "transient" | "no";

type Verdict =
  | { kind: "deny";   reason: string; recoverable: Recoverability }
  | { kind: "allow";  reason: string }
  | { kind: "review"; reason: string; packet: ReviewPacket };

type Gate = (req: Request, ctx: GateContext) => string | undefined;

function decide(denyGates, allowGates, req, ctx): Verdict {
  for (const gate of denyGates) {
    const reason = gate(req, ctx);
    if (reason) return { kind: "deny", reason, recoverable: gate.recoverable };
  }
  for (const gate of allowGates) {
    const reason = gate(req, ctx);
    if (reason) return { kind: "allow", reason };
  }
  return { kind: "review", reason: "No proof", packet: buildPacket(req, ctx) };
}
```

两组独立数组、顺序求值。「deny 优先于 allow」由结构保证，不靠行序维持。
review 是落空分支，不需要计算。

门列表：

```text
deny : userRuleDeny → dangerousGitNetwork → protectedPath → malformedShape
allow: userRuleAllow → provenSafeArgv
review: 以上都不命中
```

每个 deny 门自带 `recoverable`，见 2.6。

### 2.3 关键发现：不需要重写分类器

`classifyRiskWithCause` 已恰好输出三个状态，一一对应门模型出口：

| 分类器输出 | 门模型 |
| --- | --- |
| `Forbidden` | **不是 deny**：仍进 review packet（见下方修正） |
| `Skip` | allow 门命中 |
| `NeedsApproval` | 两门都不命中 → 落空为 review |

所以这一步是**重新接线**，不是重写分类逻辑。`classifyRiskWithCause` 原样保留，
从「返回 disposition 给调用方判断」变成「在门内部被调用」。

> **实施修正（第 3 步）**：上表最初把 `Forbidden` 写成「deny 门命中」，与代码
> 不符。`classifyRiskWithCause` 返回 `Forbidden` 时，`evaluateRiskRequest` 的
> 现有行为是 `prompt`（例：私有地址的 WebFetch 目标进 review），不是 `block`。
> deny 门只承接那批显式 `action: "block"` 的拒绝；把它们混为一谈会变成行为变更。

### 2.4 这个形状删掉什么

- `wouldPrompt` 五路析取式整体消失
- `ApprovalDisposition` 从三值减为两值（`Forbidden` / `Skip`）；`NeedsApproval` 不再是
  一种裁决，只是「没有任何裁决」的落空状态，由 `review` 分支承担
- `risk` 可变升级消失，额外写根只进 packet
- `writeOutsideRoots` 不再是决策输入（沙箱运行时裁决它）
- `operation === "external"` 兼容分支（规则拆成两门后自然消失）

### 2.5 唯一真实风险

`provenSafeArgv` 是新增安全面：每加一条，就多一个不过审就执行的命令。

**必须从当前 `Skip` 集合机械提取，不能从空开始。** 从空开始会让每条 bash 命令
触发一次 LLM 调用，不可接受。

之后只允许从实际观察到的误判里加，一次一条，每条配测试。乐观地往里填等于把
`needsApproval` 偷偷变成直接运行。

### 2.6 不新增 `failed` 出口，改为给 deny 加可恢复性

曾考虑给静态层加第四个出口 `failed`，区分「输入形状错误 / 环境错误」与真正的
安全 deny。核实后结论：**不新增出口，改为在 deny 上携带可恢复性维度。**

#### 依据：14 处 block 点的实际分类

`risk-policy.ts` 中全部 14 处 `action: "block"` 都返回 `risk: "Forbidden"`，
但安全含义截然不同：

| 类型 | 数量 | 例子 |
| --- | --- | --- |
| 输入形状 / 参数错误 | 4 | `isSupportedPermissionRequestShape` 失败、`request_permissions` 空权限、escalation 参数格式错 |
| 策略配置读取失败 | 4 | `gitMetadata`、`remoteHosts`、`additionalWriteRoots`、路径判定 |
| 真正的危险证明 | 2 | 危险 Git 网络调用、路径命中保护模式 |
| 用户配置 deny | 1 | `matchRules` |
| 待删（escalation） | 3 | 随第 2 步删除 |

若新增 `failed` 出口，它要么只能装第一类，要么退化为「所有非 deny 的 block」
垃圾桶——后者正是 `blocked` 现在的问题。

#### `failed` 的职责已被错误码体系承担

系统已有 14 个 `PermissionErrorCode`，每个码对应不同的模型提示文本
（`permission-copy.ts:79`）。这不是一堵墙，而是按可恢复性分流：

| 错误码 | 模型看到的行为 |
| --- | --- |
| `policy-denied` + 参数错误 | 修参数重试同一命令，命令本身未被评估 |
| `policy-denied` 其他 | 被权限策略阻止，无法通过 Auto-review 覆盖 |
| `review-denied` | 不得用绕过手段达成同一目标 |
| `review-timeout` | 可重试一次，或询问用户 |
| `review-unavailable` | 瞬时故障则重试 |
| `circuit-open` | 停下来询问用户 |

其中 `policy-denied` 内部还有一层细分：`isPermissionArgumentError(reason)` 把
参数格式错误渲染成「可修的参数错误，不是策略墙」（`permission-copy.ts:116-124`）。

**这就是 `failed` 想做的事，而且做得更细。**

#### 现存缺陷：用文本匹配替代类型

`isPermissionArgumentError(reason)` 在猜字符串。静态层知道每一处 block 属于哪类，
但只把 `reason: string` 传下去，下游再反推。

修法：

```ts
{ action: "block"; risk: "Forbidden"; reason: string;
  recoverable: "fix-arguments" | "transient" | "no" }
```

三值对应三种模型行为：

- `fix-arguments` — 4 处输入形状错误，模型应改参数重试
- `transient` — 4 处配置读取失败，可能是瞬时故障
- `no` — 危险证明 + 用户 deny + 待删的 escalation，不该重试

`isPermissionArgumentError(reason)` 的字符串嗅探随之删除，分流由类型保证。

#### 为什么不动错误码体系

`PermissionErrorCode` 是面向模型的稳定契约，改它影响面太大。`recoverable` 是
静态层内部的新信息，只在构造 block 时用，在 `register-support.ts:96` 那层映射
成对应错误码。

#### 「deny → return」是否合适

合适，链路（`block` → `blocked({code, reason})` → `renderPermissionErrorForAgent`
→ 模型）本身没问题，问题只在 `reason` 是文本而非结构化信息。

`review-denied` 的提示值得保留：

> 不得用工作绕过、间接执行或策略规避达成同一结果。只能用明显更安全的替代方案，
> 或用户在被明确告知风险后批准。否则停下来询问用户。

这是把「deny」与「换个办法试试」区分开的正确做法。

## 3. L3 LLM reviewer

guardian 保留，且从「人类不在时的兜底」变成**唯一决策组件**。

### 3.1 当前审批缓存

键是调用指纹，五重校验，任何一项漂移即 miss（`engine.ts:1491-1528`）：

```text
key                        = invocationFingerprint(调用身份，不含 call id)
entry.reviewKind           = "capability-grant" | "action-exercise"
entry.requestedFingerprint = 请求的权限范围
entry.basePolicyFingerprint= turn 开始的沙箱基线
entry.evidenceFingerprint  = risk + reason + summary
```

六条前置条件缺一不可：`source === "preview"`、`ownership === "sandbox-owned"`、
`snapshot.mode === "auto"`、非 elevated、熔断器关闭、turn 仍有效。

设计上有一处刻意取舍：**证据指纹含 risk/reason/summary，不含对话记录**。注释写明
「the live host transcript is deliberately NOT here」——engine 看不到 host 对话，
transcript 增长无法在 engine 侧做成键。同一 turn 内即使对话变了，只要命令、范围、
策略、风险判定不变，就复用第一次裁决。

`reviewKind` 分区是有意为之：批准一个权限范围 ≠ 批准用这个范围执行某个动作。

**新模型下缓存是否保留**：缓存前提是「同 turn 内、同动作、同证据 → 裁决不变」，
LLM 作为唯一审批者时这个前提依然成立。倾向保留，省 LLM 调用，五重指纹已足够保守。

### 3.2 要改的两处

**`staticRisk` 的传法。** 现在把静态层结论直接塞进 `GuardianPermissionContext`
（`auto-review-request.ts:82-83`）。Codex 的 guardian 不接收这个。若 LLM 是唯一
审批者，它应独立判断——但完全不传又浪费信号。建议传，且在 prompt 里明确标注
「参考信号，非结论」，要求独立验证。

**`executionMode` 三值收敛。** 现在 `"sandboxed" | "escalated" | "host-admitted"`
（`auto-review-request.ts:57`）。删 escalation 后只剩 `sandboxed`，字段可去掉。

## 4. 删除 escalation

不是「暂时关闭」，是这条路径不该存在。

要删的：

- `CapabilityLease.mode` 的 `"escalated"`（`engine.ts:106`）
- `escalation-policy.ts` 整个模块（78 行）
- `register.ts:66,357,789` 的 `escalationEligibility` 消费点
- `register.ts:2102` 工具描述里「git 元数据写入用 require_escalated」那段
- `GuardianPermissionContext.executionMode` 的 `"escalated"`
- `RiskDecision` prompt 分支的 `executionMode?: "escalated"`
- `escalationRequested` 及其 5 处读取点

`src/` 中 `escalated` 相关引用 57 处（不含 `escalatedGitDestinationUnbound`）。

### 4.1 git 元数据（本轮不处理）

沙箱内写 `.git/hooks`、`.git/config` 现在走 `require_escalated`（工具描述告诉模型
「这个要用 require_escalated」）。删除 escalation 后模型只剩两条路：被沙箱拒绝，
或切 yolo。

这符合设计意图。`register.ts:2102` 的描述文本、`.git` 指针文件、deny 名单范围
（HEAD / packed-refs / worktrees / modules / info 当前均不 deny）**均不在第 1–4 步
范围内**，留待后续单独处理。

## 5. `request_permissions` 保持扩大沙箱

与 Codex `RequestPermissionProfile` 语义一致：只扩大权限，不脱离沙箱。

批准后写 `turnWriteRoots` / `turnNetworkHosts`，turn 级有效，`closeState` 清除
（`engine.ts:1185-1200`）。

若改成裸跑授权，权限清单失去约束力，且与已删除的 escalation 重复。

它与 `bash` 是两个独立工具：`request_permissions` 不执行命令。批准后虚线影响
后续 `bash` 的沙箱策略，而非控制流。

## 6. engine 保留

不是投影层，是有状态核心。独占职责：

- turn 生命周期（`beginTurn` / `closeState` / `refreshTurnMode`）
- 审批缓存（`readApprovalCache` / `writeApprovalCache`）
- turn 级授权累积（`turnWriteRoots` / `turnNetworkHosts` / `grants`）
- 拒绝重试与熔断器（`retryRecords` / `denialWindow` / `circuitOpen`）
- lease 派生与执行尝试（`leaseWithRequests` / `executeAttempt`）
- 并发中止（`abortAttempts` / `abortReviews`）

这些状态无处安放：`turnWriteRoots` 是 request_permissions 批准后写的，`approvals`
是 LLM 裁决缓存，`snapshot` 是 turn 开始冻结的执行形态。

可瘦身的是 `CapabilityLease` 四种模式 → 两种（删 `escalated` / `host-admitted`），
以及两个 deny 构建器合并。

## 7. 迁移顺序

**关键约束**：`structure-invariants.test.ts` 强制两条结构不变量——
`sandbox-policy.ts` 在 engine value-closure 内禁止 `node:fs`（`:188-221`），
闭包内禁止出现 `sandbox.ts`（`:337-346`）。每一步都必须让它保持绿。

四步，每步独立可合、独立可回退：

### 第 1 步：数据形状收敛（低风险）—— 已判定跳过

原计划把 16 个 `allowWrite` 载体收敛为 1 个 `FilesystemPolicy` 类型。查证后跳过：
`SandboxPolicy.filesystem` 已经是统一形状，而 16 个 `allowWrite` 载体分属 4 种
不同语义（配置解析 11、策略派生 7、消费 6、`srt-enforcer.ts:135` 刻意注入
`$TMPDIR` 2、prompt 文本 2）。强行合并会破坏现有分层，收益为零。

### 第 2 步：删 escalation（中风险，改动面广）—— 已完成

按第 4 节清单全部删除，外加 `escalatedGitDestinationUnbound`（决策模型 0.99：
沙箱内每个连接由运行时 NetworkBoundary 逐端点授权，该谓词在无 escalation 后没有
消费点）。净删 1885 行；`src/` 与 `tests/` 中 `require_escalated` 归零，
`npm run check` / 1800 tests / biome 全绿。保留 `host-admitted`（0.98：host-first
工具有真实消费点）。

### 第 3 步：静态层改门模型（中风险）—— 已完成

`decide(denyGates, forceReviewGates, allowGates)` 用三组有序谓词替换了
`wouldPrompt` 析取式和末尾的裸 `allow` return。落空即 review，不会变成 allow。

两处与本节原设想不同，以实际代码为准：

1. **`Forbidden` 不映射到 deny 门。** 分类器返回 `Forbidden` 时当前行为是
   `prompt`（如私有 WebFetch 目标），并未变成 `block`。deny 门只承接那批显式
   `action: "block"` 的拒绝。若按原表接线会变成行为变更。
2. **需要第三组 `forceReviewGates`。** `rule ask` 不能被证明安全的 allow 门
   抵消，否则用户明确要求的审批会被悄悄跳过。它单独成组，落在 deny 之后、
   allow 之前。

`recoverable` 按 2.6 实现：`fix-arguments | transient | no` 在 deny 产生处标定，
经 `AdmissionPlan` → `PermissionError` 传到渲染层。

**行为等价，现有断言一条未改**（唯一的两处改动是新字段参与 `toEqual` 的期望值
与测试 fixture 补字段）。新增 2 条测试锁定门序与落空语义。

### 第 4 步：lease 模式收敛 + deny 构建器合并（低风险）—— 已由第 2 步达成

`CapabilityLease.mode` 现在恰好是 `sandboxed | host-admitted | unrestricted`，
没有第四种。原计划删掉 `host-admitted`，决策模型以 0.98 置信度否决：host-first
工具（`read`/`grep`/`find`/`ls`）由 host 自己执行，与沙箱内执行是不同的事实，
压成同一模式会让 Guardian 拿到错的 `sandboxEnforcesAction`。

「两个 deny 构建器」核实后不存在：`createSandboxRuntimeConfig` 是唯一的 deny
组装点（`projectDeny(denyWrite) + protectedRuntimeDeny + metadataDenyWrite`），
`createFilesystemPolicy` 只做配置投影。没有可合并的重复。

### 7.1 关于 worktree

**不用 worktree，直接在分支上分四次提交。** 理由：

- worktree 适合并行开发互不干扰，但这四步严格串行（第 4 步依赖第 2 步）
- 每步都能独立通过全量测试，普通提交 + 独立回退更简单
- 某步做砸时 `git revert` 单提交比清理 worktree 干净

若第 3 步风险被判定过高，可只给它开 worktree 做实验，验证通过后合回。

## 8. 命令模型分层（第 3 步之后，独立进行）

第 2 节的门模型**依赖现有 `request` 形状**，可直接做。真正消除「类型信息在边界
丢失」需要改 `normalizeToolCall` 的返回类型，那是另一件事：

```text
第一层  命令模型（纯类型，无策略）
        type Command = { kind: "bash"; argv } | { kind: "write"; paths } | ...

第二层  纯谓词（无 IO、无配置）
        isDangerousGitNetwork(command): reason | undefined

第三层  组合（唯一有 IO 的地方）
        readRepositoryRemoteHosts / resolveAdditionalWriteRoots / 组装 packet
```

**顺序不能反。** 门模型依赖现有形状；命令模型改变形状会让门模型跟着改。先做门
模型（谓词收现有 `request`），再单独做命令模型（换谓词签名），每步测试都绿。

若反过来先改命令模型，会同时改类型定义、约 15 个 `request.operation` 收窄点、
6 个谓词签名和主体逻辑，失败时无法判断来自哪一层。

## 9. 待定

1. `refreshTurnMode` 清 `approvals` 对当前 turn 的实际效果——工具调用读的是 turn
   开始时冻结的 `executionSnapshot`，而非 `active.snapshot.mode`，这个清空可能无效
2. 审批缓存在新模型下的最终去留

### 9.1 已决定

- **git 相关暂不处理。** `register.ts:2102` 的工具描述、`.git/hooks` 与 `.git/config`
  的写入路径都不在第 1–4 步范围内。escalation 删除后它们会自然落到「沙箱拒绝」或
  「切 yolo」两条路，符合设计意图；描述文本的改写留到后续单独处理。
- **不新增 `failed` 出口**，改为给 deny 携带 `recoverable`，详见 2.6。
