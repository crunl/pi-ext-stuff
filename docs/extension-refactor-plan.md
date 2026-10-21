# pi-safety 重构方案

> 版本 v1 · 2026-10-21 · 依据 `docs/extension-structure-standard.md`（标尺）
> 前身 `tmp/refactor-plan-draft.md`（v0）经**四路对抗评审**后作废；被推翻的结论见 §7，不重复采信。
>
> **本方案未动手实施。** 状态：待批准。

---

## 0. 范围声明（先说不做什么）

标尺 §4 声明"任何重构完成后必须满足 S1-S10"。**本方案不满足其中三条**，显式记账，另案处理：

| 判据 | 阈值 | 本方案完成后 | 说明 |
|---|---|---|---|
| **S1** 单文件 ≤400 行 | 400 | `register.ts` ~2400、`engine.ts` ~2050 | 不达标，另案 |
| **S2** 跨闭包共享 `let` ≤2 | 2 | `register.ts` 仍剩 7+ | 不达标，另案 |
| **S3** 入口体 ≤120 行 | 120 | `registerExtension` 未拆 | 不达标，另案 |
| S4 类型图零环 | 0 环 | **0 环** | ✅ 达成 |
| S5 一事实一声明 | — | 同值异名 5 对 → 0 | ✅ 达成 |
| S6 协议 union 只声明一次 | — | 3 组达成，1 组不适用 | ✅ 部分达成 |
| S7 名实一致 | — | `evaluateDenyRulesOnly` | ✅ 达成 |
| S8 删除测试 | — | 逐步自检 | ✅ |
| S9 真接缝 | — | 只切 2 处 | ✅ |
| S10 测试从 interface 穿过 | — | 不动 structure-invariants | ✅ |

**为什么放弃 S1/S2/S3**：三条都指向"按行数/按事件拆文件"。对抗评审证实：
- 拆 `engine.ts` 会把 `beginTurn:2444-2474` 跨组的**代码顺序变成约定**（倒退）
- 按事件切 `register.ts` 后每个事件闭包要持有全部状态组的引用，**接缝比现状更密**
- `register.ts` 的 16 个 `let` 不是 16 个状态机，是 **4 个有时序约束的组 + 3 个单点**，按行数切块会切断 `commitActivation:817-826` 的四元组赋值

本方案治的是**病根**（缺失的声明点、环、名实不符、钉路径的测试），不是症状（文件太长）。症状另案。

---

## 1. 核心判断（经对抗评审修正）

**上帝类是症状。三个病根：**

1. **协议事实没有可用的引用点。** `PermissionErrorCode` 是**私有的**（无 `export`），全仓只用 1 次（`engine.ts:329`）。`permission-copy.ts:83-188` 那 14 个 `case` 与该类型**零连接**——分派靠裸字面量，类型是孤岛。测试只能写字面量，于是 14 个值散成 180+ 处。

2. **类型住错了地方。** `engine.ts:35-536` 兼职类型中枢，导致 `engine ↔ engine-clone`、`engine ↔ engine-fingerprint` 两条类型环。根因是抽象位置，不是文件大小。

3. **测试钉路径不钉性质。** `structure-invariants.test.ts` 用 `readFile` + 正则扫描源码文本。但它是 **S1-S9 唯一可执行的执法者**，本方案**不动它的断言形状**（见 §3.0）。

---

## 2. 目标结构（依赖方向）

```text
permissions/residual.ts     零 import 叶子
  · RESIDUAL_SIGNALS + ResidualSignal          （已有）
  · REVIEW_SOURCES + ReviewSource              （新增）
  · 既有先例：residual.ts:10-40 的 as const + typeof + cast 窄化
        ↑ 单向
engine-types.ts             类型图（零运行时值）
  · 22 个导出类型 + 16 个被引用的私有类型
  · 可 import residual.ts
        ↑ 单向
engine.ts                   运行时引擎
  · createEngine + :537-872 的运行时常量/辅助
  · 不再兼职类型中枢
```

**关键**：`ReviewSource` **不进** `engine-types.ts`。若两者都在 `engine-types.ts`，`residual.ts` 收窄签名就需反向 import，合成 `engine-types ⇄ residual` 真环。

**不建 barrel。** v0 用 `export type * from "./engine-types.ts"` 实现"零破损"，被评审否决：标尺 §2 将 barrel 列为"pi 样本里没有的东西"，且 `:71`「不做兼容垫片」。改为**显式改指向**（§3.1）。

---

## 3. 分步实施

### 3.0 Step 0 · 机械路径更新（不是改断言）

**v0 的 Step 0 被否**：它提议把 3 条结构不变量改成"性质断言"，评审逐条验出**3 条全部降低防护力、9 条无替换文本、无一条提升**。更关键的是 `valueEdges()` 过滤 `isType` 边，Step 1 的纯类型搬迁**根本不进 #10/#12 的视野**——改写它们无重构驱动，是放水。

**改为只做一件事**：

| 断言 | 现状 | 改为 | 性质 |
|---|---|---|---|
| `structure-invariants.test.ts:233` | `expect([...declarers].sort()).toEqual(["src/engine.ts"])` | `toEqual(["src/engine-types.ts"])` | **机械路径更新**（类型搬家后锚点跟随） |

同时把测试标题 `:223`「only the engine declares the authority-minting names」改成与新锚点一致（否则违反 S7）。

**其余 12 条原样保留**，每次步骤完成后重跑。#10/#12 的强化**挪到本方案完成后的独立护栏任务**，且届时必须保留：
- `node:child_process` spawn 白名单（`node:child_process` 仅 `guardian-worker-client.ts`）
- `src/pi-safety.ts` 禁令（现措辞只提 register，会漏）
- `sandbox.ts`（execution factories）与 `src/sandbox/`（被禁前缀）的区分（测试注释 `:305-307` 明确区分）

**验收**：`npm test` 绿；`git diff tests/` 只有 1 条断言 + 1 条标题。

---

### 3.1 Step 1 · 切类型接缝：`engine-types.ts`

**搬什么 —— 已机械算出闭包，非估算**：`:35-536` 共 **49 个声明**（33 导出 + 16 私有）。

| 档 | 数 | 内容 |
|---|---|---|
| **切环闭包** | **28** | `ApproveForMeMode`(:35)、`AdmissionRisk`(:36,**私有**)、`InvocationOwnership`(:39)、`RuntimeDenialPolicy`(:47)、`InvocationCall`(:49)、`AdmissionPlan`(:57)、`TurnSnapshot`(:81)、`CapabilityLease`(:93)、`CapabilityRequest`(:99)、`CapabilityRequestInput`(:108)、`NativeActionFailure`(:111)、`RuntimeOutcome`(:119)、`ExecutionAttempt`(:129)、`InvocationExecutor`(:150)、`PermissionAmendment`(:152)、`Invocation`(:158)、`RetryHandle`(:248)、`PermissionErrorCode`(:299,**私有**)、`BlockRecoverability`(:326)、`PermissionError`(:328)、`ExecutionOutcome`(:343)、`DenialNotice`(:348)、`TurnHandle`(:366)、`CapabilityAuthorizationInput`(:371)、`CapabilityRejectionInput`(:376)、`CapabilityAuthorizationDecision`(:381)、`PermissionStateView`(:385)、`Engine`(:408) |
| **产品决定增量** | **4** | `GuardianReviewInput`(:172)、`GuardianDecisionMetrics`(:195)、`ApprovalOverride`(:253,**私有**)、`ReviewEvent`(:264) |
| **合计搬** | **32** | |

**切环只需 8 个根**（`engine-clone.ts:15-22` 引 6 个、`engine-fingerprint.ts:20-25` 引 4 个，去重后 8 个），其传递闭包是 28。

**产品决定带来的增量代价**（2026-10-21）：搬 `GuardianReviewInput` 会拖进 `GuardianDecisionMetrics` 与 `ApprovalOverride`——正是 blindspots 轴 P0-1 预警的那条。**已接受，计入 32。**

**留在 `engine.ts` 的 17 个**（与运行期紧耦合，不搬）：`GuardianDecision`(:217)、`GuardianAdapter`(:225)、`PermissionPolicyCheck`(:232,**私有**)、`PermissionPolicyDecision`(:239,**私有**)、`PolicyCheckResult`(:241,**私有**)、`PermissionPolicy`(:244)、`AutoState`(:258)、`EngineOptions`(:355,**私有**)、`TurnState`(:426,**私有**)、`GrantRecord`(:437,**私有**)、`ApprovalCacheEntry`(:450,**私有**)、`ApprovalCacheEvidence`(:470,**私有**)、`RetryRecord`(:477,**私有**)、`ReviewRequest`(:491,**私有**)、`RuntimeAttemptContext`(:504,**私有**)、`InFlightAttempt`(:513,**私有**)、`ResolvedAdmission`(:523,**私有**)。

**运行时不动**：`createEngine`(:873)、`:537-872` 的常量与辅助函数。

> `engine-clone.ts:12-13` 的注释写着"this module adds no runtime edge back to `engine.ts` and the value graph stays acyclic"——作者**知道**类型边会成环，但只保证了值图。`guardian/errors.ts:1-4` 记载 madge 把 type 边也算进环检测，所以这个保证不够。

**7 条 import 改指向**：

| 文件:行 | 现状 | 改为 |
|---|---|---|
| `engine-clone.ts:15-22` | `from "./engine.ts"` | `from "./engine-types.ts"` |
| `engine-fingerprint.ts:20-25` | 同上 | 同上 |
| `delegation-policy.ts:3` | 同上 | 同上 |
| `risk-policy.ts:2` | 同上 | 同上 |
| `register-support.ts:3` | 同上 | 同上 |
| `permission-copy.ts:1` | 同上 | 同上 |
| `register.ts:62` | `matchesNetworkDomainPattern` from `engine.ts` | **from `network-domain-pattern.ts`**（砍掉无谓扇入） |

`pi-safety.ts:3-29`（22 类型）与 `pi-guardian-adapters.ts:16-21`（4 类型）**一并改指向** `engine-types.ts`（不靠 barrel）。

**biome 约束**：新 import 必须写 `import type { ... }`（`style/useImportType` = error）；`engine.ts` 搬走类型后顶部 import 列表必须重剪，漏一个即 `correctness/noUnusedImports`。

**验收（可证伪）**：
1. `npm run check` + `biome check` 绿
2. `rg -c "from \"./engine.ts\"" src/` 中不再出现 `engine-clone.ts` / `engine-fingerprint.ts`
3. `structure-invariants.test.ts:233` 断言为 `["src/engine-types.ts"]`
4. 类型图零环（可用 madge 验；`guardian/errors.ts:1-4` 记载本仓库把 type 边算进环检测）
5. `engine.ts` 扇入从 11 降至 ≤2

---

### 3.2 Step 2 · 协议常量（分组处置，非"机械替换"）

v0 称"180 处机械替换"。评审证实**四组情况完全不同**：

| 组 | 判定 | 落点 | 需连带改动 |
|---|---|---|---|
| `AutoReviewerFailureKind`（5 值） | ✅ **可直接改** | `guardian/errors.ts` 加 `AUTO_REVIEWER_FAILURE_KINDS` | 零签名改动。**注意**：`guardian/metrics.ts:238 narrowFailureKind(value: string)` 参数保持 `string` 是**正确的**（它就是外部守卫），不要动 |
| `ReviewSource`（4 值） | ⚠️ **需先改 3 处签名** | `permissions/residual.ts`（零 import 叶子） | ① `residual.ts:82` 参数 `string \| undefined` → `ReviewSource \| undefined` ② `residual.ts:97` 同上，**返回型是 `ReviewSourceTag`**（`"unknown"` 是指标哨兵不是 source，见下文定性）③ `pi-guardian-adapters.ts:279/284`、`engine.ts:205`、`guardian/metrics.ts:283` 的 `reviewSource?: string` |
| `ReviewStatus`（6 值） | ⚠️ **需先改 5 处签名 + 加运行时守卫** | `permission-copy.ts`（与 `ReviewPresentationEvent`(:13)、`PermissionNotice`(:29) 同文件才不散架） | `review-presenter.ts:21`、`review-renderer.ts:26/64/86` 收窄。**`review-renderer.ts:72 reviewStatusFromDetails(details: unknown)` 输入来自宿主 tool result**——窄化前必须在 `isDecoratedDetails` 加 `REVIEW_STATUSES.includes(status)` 运行时守卫，否则是用断言把未验证外部数据声称为封闭词汇（违反 boundary validation），穷尽 switch 缺分支会静默落空 |
| `PermissionNotice`（10 分支） | ❌ **不适用** | 保持现状 | 它是**判别式对象联合**（`permission-copy.ts:29`），各分支带不同 payload（`consecutiveDenials/recentDenials/windowSize`、`preferredModel/activeProvider/activeModel`…）。抽成 `as const` 只得到 tag 型，是把一张联合拆成两半，不是简化 |

**落点**（repo-native，照抄 `residual.ts:10-40` 既有先例）：

| 组 | 落点 | 为什么 |
|---|---|---|
| `ReviewSource` + `REVIEW_SOURCES` + `ReviewSourceTag` | `permissions/residual.ts` | 零 import 叶子；与 `RESIDUAL_SIGNALS`/`ResidualSignal`(:34) 并列 |
| `AutoReviewerFailureKind` + `AUTO_REVIEWER_FAILURE_KINDS` | `guardian/errors.ts` | 已在该处，零迁移 |
| `ReviewStatus` + `REVIEW_STATUSES` | `permission-copy.ts` | 与 `ReviewPresentationEvent`(:13)、`PermissionNotice`(:29) 同文件才不散架 |

### `"unknown"` 的定性（产品决定 2026-01-21）

**它不是 review source，是指标基数限流的兜底桶。** 实测链路（三处未类型化的哨兵）：

```text
input.source（外来）
  → mapReviewSource（residual.ts:97）
        4 认得 → 原样
        认不得 → "unknown"                        ← 哨兵 #1
  → pi-guardian-adapters.ts:279  reviewSource: string   ← 未标注
  → buildGuardianMetricsRecord:316
        sanitizeMetricTag(input.reviewSource ?? "unknown")  ← 哨兵 #2
  → sanitizeMetricTag（metrics.ts:262）
        空 / 清洗后空 → "none"                    ← 哨兵 #3
```

`sanitizeMetricTag` 只做**形状清洗**（剔非法字符、截 120、空转 `"none"`），**不做词汇校验**。所以 `"unknown"` 是 `mapReviewSource` 独有的分类语义：**有值，但认不得**。对比 `"none"` = **压根没值**。两个都不是 review source。

**解法**（3 行，行为一字不变）：

```ts
export const REVIEW_SOURCE_UNCLASSIFIED = "unknown" as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];
export type ReviewSourceTag = ReviewSource | typeof REVIEW_SOURCE_UNCLASSIFIED;
```

`mapReviewSource(source: string | undefined): ReviewSourceTag` 签名收窄，`tests/permissions-residual.test.ts:139` 原样绿。`buildGuardianMetricsRecord:316` 的 `?? "unknown"` 改引 `REVIEW_SOURCE_UNCLASSIFIED`——**与 `mapReviewSource` 的 default 共用一个声明点**（S5）。

**不选**扩词汇成 5 值：那会把指标层的限流策略泄漏进领域类型，此后任何 `source` 字段都得被迫接受 `unknown`。

### 签名连带收窄

| 类型 | 需改动 | 位置 |
|---|---|---|
| `AutoReviewerFailureKind` | **零** | `guardian/metrics.ts:238 narrowFailureKind(value: string)` 参数保持 `string` 是**正确**的（它就是外部守卫），不要动 |
| `ReviewSource` | 3 处 | `residual.ts:82/97` 参数；`pi-guardian-adapters.ts:279/284`；`engine.ts:205`、`guardian/metrics.ts:283` 的 `reviewSource?: string` |
| `ReviewStatus` | 5 处 + **1 个运行时守卫** | `review-presenter.ts:21`、`review-renderer.ts:26/64/86`；**`review-renderer.ts:72 reviewStatusFromDetails(details: unknown)` 输入来自宿主 tool result**——窄化前必须在 `isDecoratedDetails` 加 `REVIEW_STATUSES.includes(status)` 运行时守卫，否则是用断言把未验证外部数据声称为封闭词汇（违反 boundary validation），穷尽 switch 缺分支会静默落空 |

`review-renderer.ts` 取 `REVIEW_STATUSES` 走 `review-presenter.ts` **值再导出**（`review-renderer → review-presenter` 边已存在）——不新增 `review-renderer → permission-copy` 边。

### 字面量替换的范围（不搞地毯式）

v0 说"180 处机械替换"，那是错的。**很多裸字面量本来就该是字面量**——测试断言 `expect(err.code).toBe("policy-denied")` 是在断言具体值，改成 `PERMISSION_ERROR_CODES[3]` 只会更难读。

**要替换的只有一类**：测试需要**枚举或校验成员资格**时。此时给的是**守卫**而非替换，照抄 `isResidualSignal` 先例：

```ts
export function isPermissionErrorCode(value: unknown): value is PermissionErrorCode {
  return typeof value === "string" && (PERMISSION_ERROR_CODES as readonly string[]).includes(value);
}
```

**验收**：三组 union 各一处声明；三个守卫函数就位；`rg -c` 确认没有第二处声明。**不要求**替换全部字面量。

---

### 3.3 Step 3 · 切两个状态接缝

**前置：先写 4 条 pinning 测试**（v0 的红线全是散文、零测试固定，被评审列为最大方法论漏洞）：

| 红线 | pinning 测试要断言什么 |
|---|---|
| `commitActivation:817-826` 四元组同次赋值 | 失败回滚后 `loaded`/`loadedKey`/`baseSandboxConfig`/`sandboxState` 全部回到 previous |
| 回滚顺序 `sandboxState→loaded→loadedKey→baseSandboxConfig` | 中途抛错时已写的字段与未写的字段符合该顺序 |
| `applyPendingTurnModeRefresh` 两条路径顺序相反（沙箱 `:1118-1141` 先 `activateConfig` 后改快照；yolo `:1144-1154` 反之） | 两条路径各自的事件顺序 |
| `closeState:1032-1046` **不**清理 `inFlightCallIds` | `closeState` 后 `inFlightCallIds` 保持原值 |

**接缝一 · GuardianEvidence**（先做——写入点都在文件尾部，与激活路径只在 `:1251`/`:1162` 相交）

成员：`guardianTranscript`(:237)、`guardianTranscriptEpoch`(:238)、`inputFallbackTranscript`(:239)、`guardianInvalidationAfterModeChange`(:240)。

**写入点比 v0 说的"3 种变体"多**（评审纠正）：

```text
:399-402   reset 四元组
:717-719   turn 结束时消费并清 flag
:735       turn 活跃时置 flag
:738       非活跃时清 flag
:745-746   ★ 读时写：epoch+1 并清空 fallback（在 currentRawGuardianTranscript 里）
:790/:2190 shutdown 再清 flag
:2206-2211 input 追加
:2218-2220 message 追加
```

`:742-748` 的**读时写**是最难搬、最容易丢的部分。搬动必须保留「两条 transcript 同时非空时先 bump epoch 再清空 fallback」。

**接缝二 · ActivationCache**（后做）

成员：`loaded`(:228)、`loadedKey`(:229)、`configFailure`(:230)、`activationFailure`(:231)。

写入口（**修正 v0 错误行号**）：
- `loadActivationCandidate` 函数头 `:784`，写 `configFailure` 在 **`:793`**
- `commitActivation:809-836`（`:817-826` 四元组）
- 回滚事务在 **`:868-904`**（`loaded`/`loadedKey` 在 `:895-896`，`activationFailure` 在 `:900-903`）—— v0 标的 `:846` 是 `leaseWithRequests()` 的注释，与激活无关

**按簇整体搬，不按变量零散搬**（`noUnusedVariables` = error，零散搬会在 102K 闭包里留下无读取的 `let`）。

**不切缝**（一个 adapter 是假接缝）：`SandboxLease`（`baseSandboxConfig`+`sandboxState`，注释 `:223-227` 钉死禁止拆）、`ModeIntent`、`GuardianSelection`、`shutdownSettled`、`shellParserFailureReported`，以及 `engine.ts` 的 TurnCursor/DenialLedger/ReviewFlight 三组。

**验收**：
1. 4 条 pinning 测试全绿
2. `rg -n "let (loaded|loadedKey|configFailure|activationFailure|guardianTranscript|guardianTranscriptEpoch|inputFallbackTranscript|guardianInvalidationAfterModeChange)" src/register.ts` 只剩工厂内部声明
3. `rg -n "baseSandboxConfig|sandboxState|modeRuntime|pendingMode" src/register.ts` 仍在 `registerExtension` 体内（确认没多切）
4. `structure-invariants` 13 条全绿

---

### 3.4 Step 4 · 名实改名 + 同值归一

**改名**：`evaluateHostFirstRulesOnly` → `evaluateDenyRulesOnly`（体内零 host-first 逻辑）。共 **9 处 / 3 文件**，含注释：

- `risk-policy.ts:246`（定义）、`:262`（文档注释）、`:271`（调用）、`:376`（注释）
- `register.ts:138`（import）
- `tests/risk-policy.test.ts:9,303,310,320,2212`

**注释里的名字必须同步改**，否则制造新的名实不符。

**同值归一**——加一条判据：**同值 ≠ 同事实，只合并语义相同者**。

v0 按值合并，评审指出会**反向犯错**：

| 值 | 现状 | 判定 |
|---|---|---|
| `15_000` | `srt-coordinator.ts:19 SRT_DRAIN_TIMEOUT_MS` / `register.ts:680` 裸字面量 / **`srt-enforcer.ts:28 SRT_ACTIVATION_TIMEOUT_MS`（v0 漏）** | 前两个是**同一个 drain 窗口**→合并；第三个是 activation 超时→**不同事实，不合并** |
| `50` | `engine.ts:538 DEFAULT_DENIAL_WINDOW_SIZE` / `guardian-policy.ts:4 GUARDIAN_DENIAL_WINDOW_SIZE` | **同一事实，且当前未绑定**（潜伏 bug）→ 修法是**绑定不是去重**，见下 |
| `16_000` | `guardian-policy.ts:5 MAX_GUARDIAN_POLICY_CHARACTERS` / `auto-review-request.ts:102 MAX_ACTION_CHARACTERS` | **不同事实**（策略字符上限 vs action 描述上限）→ **不合并**，各自具名 |
| `10` | `engine.ts:539 DEFAULT_MAX_WINDOW_DENIALS`（窗口内几次拒绝熔断）/ `engine.ts:540 MAX_DENIAL_NOTICES`（保留几条通知供渲染，`tests/heap-soak.test.ts:75` 专门注释） | **不同事实 → 不合并**。一个是授权熔断阈值，一个是渲染内存上限 |
| `3` | `engine.ts:537 DEFAULT_MAX_CONSECUTIVE_DENIALS`（连续拒绝熔断）/ `guardian-policy.ts:2 GUARDIAN_REVIEW_MAX_ATTEMPTS`（`auto-reviewer.ts:154/176/377/505` 的评审重试上限） | **不同事实 → 不合并**。一个是授权控制，一个是重试策略 |
| `/bin/bash` | `sandbox.ts:61 WRAP_SHELL` / `srt-enforcer.ts:32 POSIX_SHELL` | 同事实→合并为 `POSIX_SHELL` |
| PATH | `sandbox.ts:233` / `guardian-worker-client.ts:211` | ⚠️ **`guardian-worker.mjs` 是自包含的**（`:10` 注释明说只依赖 `guardian-worker-limits.mjs`），**任何与 worker 共享的事实不能落在 TS 模块** |

**验收**：`rg -c` 计数各归一目标为 1；`npm test` 绿。

#### `50` 那对是真问题（2026-01-21 实测）

```text
engine.ts:538  DEFAULT_DENIAL_WINDOW_SIZE = 50
    → :892  options.denialWindowSize ?? DEFAULT_DENIAL_WINDOW_SIZE
    → :906-907  窗口裁剪（执行）
                        ↑ 从没有人传过 options
                          pi-safety.ts:313 createEngine 只传
                          { guardian, policy, onReviewEvent, onAutoStateChange }

guardian-policy.ts:4  GUARDIAN_DENIAL_WINDOW_SIZE = 50
    → register.ts:309  windowSize: GUARDIAN_DENIAL_WINDOW_SIZE
    → review-circuit-interrupted 的 UI 文案（展示）
```

**执行值与展示值来自两个互不相识的声明，中间无任何绑定。** 今天恰好都是 50；谁改其一，UI 就对用户说谎，**且没有任何测试会红**。

**修法是绑定不是去重**：`pi-safety.ts:313` 把 `GUARDIAN_DENIAL_WINDOW_SIZE` 作为 `denialWindowSize` 传进 `createEngine`，让展示与执行共用一个源。`DEFAULT_DENIAL_WINDOW_SIZE` 留作 engine 通用默认值——那是它的契约，**不是同一事实**。

> 这一条同时验证了「同值 ≠ 同事实」判据的**双向**价值：`10`/`3` 是同值不同事实，判据挡住了错误合并；`50` 是同值同事实，但合并理由是「必须绑定」而非「值一样」。

---

## 4. 明确不做的

| 不做 | 依据 |
|---|---|
| 拆 `engine.ts` | `beginTurn:2444-2474` 顺序跨组，拆了把代码顺序变成约定 |
| 按事件切 `register.ts` | 每个 `let` 被 3-6 类闭包碰到，横切后接缝更密 |
| 给单写入点切缝 | `modeRuntime`(33 次引用)、`sandboxState`(30) 只有一种写路径 |
| 建 `constants.ts` 大杂烩 | pi 8 样本无此物；常量归**拥有该事实的模块** |
| barrel re-export | 标尺 §2「样本里没有的东西」+ `:71`「不做兼容垫片」 |
| 改 structure-invariants 断言形状 | 它是 S1-S9 唯一执法者；只做 §3.0 的机械路径更新 |
| `PermissionNotice` 抽常量 | 判别式对象联合，抽 tag 是拆两半 |
| 合并 `16_000` 那对 | 同值不同事实，合并是 S5 要防的反向错误 |

---

## 5. 完整改动面（修正 v0 的低估 3 倍）

| 类别 | 量 | v0 的说法 |
|---|---|---|
| 工具名字面量 | **227 处 / 26 文件**（src 54/9，tests 171/17） | "约 80 处" |
| 测试断言 | 55 个 `*.test.ts`、3062 个 `expect(` | — |
| `scripts/` | **4 个文件完全未列** | 0 |
| 文档锚点 | 4 份 | 0 |

**`scripts/` 明细**（`tsconfig.json:12` 把 `scripts/**/*.ts` 纳入 tsc）：
- `scripts/host-turn-boundary.mjs:36` 硬编码 `join(repoRoot, "src", "register.ts")`，`:98` `jiti.import(registerTs)` —— **Step 1/4 直接影响；`.mjs` 不在 tsconfig，路径失效是静默的**
- `scripts/preflight-sibling.mjs:11-12` 硬编码 `packages/shared-tool-presentation/src/index.ts`
- `package.json` 4 条非 vitest 验收链：`check:host-turn-boundary`、`preflight:sibling`、`diagnose:guardian`、`report:guardian`

**文档锚点**：
- `docs/pi-safety.md` 13+ 处（`:33-35`/`:357`/`:540`/`:544`/`:550`/`:553`/`:555`/`:557`/`:560`/`:563`/`:566`/`:618`/`:623`/`:761`）
- `docs/overview.md` `:191-194`/`:234-240`/`:344-356`/`:425-435`
- `docs/extension-structure-standard.md` §5 现状快照（改完即失效，须同步）
- `extensions/pi-safety/AGENTS.md` —— **已失准**：`:157` 指向不存在的 `src/approve-for-me-engine.ts`、`:161` 指向不存在的 `src/pi-approve-for-me-adapters.ts`

**验收顺序**（`AGENTS.md:316-325`）：`preflight:sibling` → `check` → `lint` → `npm test`；改动落在 mid-turn mode apply 或 host lifecycle wiring 上时**必须加跑 `check:host-turn-boundary`**——Step 3/4 正好落在这里。

---

## 6. 总验收（每步可独立证伪）

| 步 | 做对了怎么验 | 做错了会怎样 |
|---|---|---|
| 0 | diff 只含 1 断言 + 1 标题 | 若改了 ≥2 条断言形状 = 又在放水 |
| 1 | 类型图零环 + 扇入 ≤2 + 全套绿 | 若 `engine-types` 出现 import `engine.ts` = 环回来了 |
| 2 | 三组 union 各 1 处声明 + residual 测试绿 | 若 `"unknown"` 语义丢失 = `permissions-residual.test.ts:139` 红 |
| 3 | 4 条 pinning 测试绿 + 13 条结构不变量绿 | 若 `closeState` 清了 `inFlightCallIds` = pinning 测试红 |
| 4 | `rg -c` 计数 + 全套绿 | 若注释里的旧名残留 = 违反 S7 |

**每步完成后必须跑**：`preflight:sibling` → `check` → `lint` → `npm test`（+ Step 3/4 加 `check:host-turn-boundary`）。

---

## 7. 被对抗评审推翻的原结论（记录在案，不重复采信）

| v0 的说法 | 推翻依据 | 出处 |
|---|---|---|
| Step 0 把 3 条断言改成"性质断言" | 13 条 = 3 条降级 + 9 条归零 + 1 条不变，**无一条提升**；`valueEdges()` 过滤 `isType`，Step 1 根本不触发 #10/#12 | principles 轴 |
| 搬 22 个纯类型就够 | 33 导出 + **16 私有**；私有类型不搬会**再造环**。精确闭包：切环需 **28**，加产品决定后 **32**，留 17 | blindspots P0-1 + 闭包实测 |
| `engine-types.ts` 编译产物 0 字节 | Step 2 的 `export const` 是运行时值，与纯类型文件互斥；`export type *` 转不出 const | blindspots P0-2 |
| `export type *` 实现零破损 | 标尺 §2/`:71` 禁 barrel 与垫片 | principles C4 / blindspots 文档冲突 1 |
| `ReviewSource` 没有类型声明 | **有**，内联在 `engine.ts:176` 的 `GuardianReviewInput.source` | feasibility-v2 纠正 |
| 4 组 union 都能 `as const` 改造 | 仅 1 组直接改、2 组需先改签名、1 组不适用 | feasibility-v2 |
| 180 处"机械替换" | `mapReviewSource` 返回 `"unknown"`（词汇外）；`reviewStatusFromDetails(details: unknown)` 是**外部数据边界**。且裸字面量多数**本就该是字面量**，地毯式替换是负优化 | feasibility-v2 P1 |
| ActivationCache 变体在 `:846` | `:846` 是 `leaseWithRequests()` 注释；真回滚在 `:868-904` | principles C5 |
| GuardianEvidence 只有 3 种写入变体 | 实际 8 个写点，含 `:742-748` 的**读时写** | principles §3 |
| 同值归一 5 对 | 是 6 对（漏 `10`）；且 `16_000` 那对**不同事实不能合并** | blindspots P1-2 / principles |
| `15_000` 两处 | **三处**（漏 `srt-enforcer.ts:28`） | principles C7 |
| 工具名约 80 处 | **227 处 / 26 文件** | blindspots |
| 改动面 20 文件 / 350-450 断言 | **30-40 文件 / 700-1200 触碰点** + 4 份文档 | blindspots |
