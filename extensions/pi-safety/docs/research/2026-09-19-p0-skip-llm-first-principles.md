# P0 skip-LLM：第一性原理盘点与最优雅调整方案（设计 only）

> **Superseded (partial) 2026-09-19 later product cut:** host-admission
> production review retired — see `2026-09-19-owned-tools-only-chain-cut.md`.
> This note remains authoritative for **owned** P0 residual fail-closed design;
> host `authorizeHostTool` / `evaluateHostRiskRequest` ask→prompt claims below
> are historical only.

## Scope

- Date: 2026-09-19
- Codex pin（standing）: `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
- Host pin: `@earendil-works/pi-coding-agent@0.85.1`
- Tree: `/Users/x1a2h1/.pi/agent/extensions/pi-permissions`（本 session 直接读 `src/**` + `docs/**` + `tests/**`；bash 策略拦了 shell，未重跑 `npm test` / 未重读 live `guardian-metrics.jsonl`）
- Question: 从第一性原理出发，P0「静态已可决定的动作如何不进 Guardian LLM」的库存、谓词与最小语义调整
- Deliverable: **设计 + 库存 only**。本 note **不实现**产品代码，不 commit/push

### First principles（北星，本 note 只 refine 不丢弃）

1. Guardian 只出现在静态 policy **无法安全决定**之处。
2. 任何 residual risk / input drift → fail-closed；skip 是静态路径 **挣来的特权**，不是默认。
3. **一个决策点**：回答「是否必须进 review」，而不是 adapter 里散落 `if low then skip`。
4. P0 **不引入** Jev/Luna 等第二决策模型。
5. Host boundary 不变（`docs/host-api-boundaries.md`）：host-admission 仍 review-only after allow；owned 工具保留 SRT/escalation 语义。
6. Codex/fx 对齐：静态 Skip/Allow 不进 model review；只有 unresolved/prompt-worthy 进 reviewer。Pi 应 **同构、不更松**。

### 相关既有 note（本 session 复核，不盲从）

- `2026-09-18-guardian-alignment-graphify.md`：N3 `strict_auto_review` **勿与 P0 混做**；N1/N2 是观测债。
- `2026-09-17-tool-call-turn-latency.md`：高价值是「根本不进 LLM」；曾提 same-turn fingerprint reuse 为可选。
- `2026-09-19-four-way-auto-mode-review.md`：Codex/fx/pi 双层同构；minimax 是云端 classifier 对照物。
- `2026-09-12-network-access-whole-open.md`：`network_access:true` = Codex Enabled；connect-guard / deniedDomains **不放松**。

---

## 1. 结论

**一句话：最优雅的 P0 不是「再加一层跳过模型」，而是把「是否必须进 Guardian」收成一个带穷举 residual 信号的纯函数，挂 Engine 唯一 review 闸门；v1 不新开权限，只钉死已有静态 allow/skip，并给 metrics 补上 static 侧观测。建议实施（设计落地时按此谓词写代码），但 v1 行为默认对「当前会进 LLM 的路径」保持 fail-closed。**

更硬的代码事实（本 session 在 `src/**` 验证）：

1. **真·静态 allow 今天已经不进 LLM。**  
   - `RiskDecision.action==="allow"` → `admissionPlanFromRiskDecision` → `{kind:"allow"}`（`src/pi-approve-for-me-adapters.ts:95-100`）。  
   - Engine：`reviewRequested=[]` 且非 `forcedManualReview` 时 **直接** `executeAttempt`，不调 `runReview`（`src/approve-for-me-engine.ts:2157-2278`）。
2. **capability 型 review 里已被 baseline 覆盖的请求会被滤掉。**  
   - `reviewRequested = admission.requested.filter((item) => !requestCovered(baseline, item))`（同上 `:2158-2163`）。覆盖集为空 → 同样不进 LLM。
3. **`risk-policy` 在默认公式下几乎不制造「无 residual 的 prompt+LOW」。**  
   - `wouldPrompt = promptedByRule || risk !== "LOW" || escalationRequested`（`src/risk-policy.ts:398-400`）。  
   - 因此 live `risk_level=low + outcome=approve + session_kind=trunk_*` **不能**读成「静态已 allow 仍进 LLM」；metrics 的 `risk_level` 来自 **Guardian 结果**，不是静态 `Risk`（`src/pi-approve-for-me-adapters.ts:325-327`）。
4. **默认配置下 shell 的主浪费源是连接级 inline review，不是 admission 误升。**  
   - DEFAULT：`sandbox.network.network_access` 缺省（非 true）、`allowedDomains: []`（`src/config.ts:196-215`）。  
   - 非 dangerous 的 sandboxed bash 静态是 `LOW` → admission allow（`src/risk-policy.ts:332-336,398-418`）。  
   - 执行中公网连接：production connect-guard 把 SRT `allowedDomains` **强制为空**（`src/sandbox/srt-enforcer.ts:125-129`）→ `createSandboxNetworkAuthorizer` 总会 `authorizeCapability`（`src/register.ts:1456-1459`）→ Engine `authorizeInlineCapability` 在 `!requestCovered` 时 `runReview(source:"inline", risk:"REVIEW")`（`src/approve-for-me-engine.ts:2416-2457`）。  
   - Guardian 常判 low/approve → 与 live metrics 形态一致。
5. **`network_access:true` / `allowedDomains` 命中 / turn grant 已覆盖的连接，今天已可 skip inline LLM**（`requestCovered` 读 `effectiveNetworkAuthority(...).wholeNetwork`，`src/approve-for-me-engine.ts:771-796`）。这是 **配置层已存在的 Codex Enabled 路径**，不是新代码特权。

**因此 P0 的优雅点是：谓词 + 单一 chokepoint + residual 类型化，而不是再造 skip 目录或第二 reviewer。** 把「public 默认不审」当成 P0 代码改动，等于偷偷放宽 connect-guard 产品姿态——**不建议**。

---

## 2. 必须进 Guardian（或 block）的 residual signals（穷举）

谓词概念形：

```text
staticAllowsExactly(action)
  && noResidualUncertainty(snapshot, admission, call)
  && authorityUnchanged(turnGeneration, configFingerprint, ownership)
→ skip LLM
else → must enter one chokepoint review / block
```

| # | Residual signal | 代码落点（证据） | 为何不能忽略（安全理由） |
|---|---|---|---|
| R1 | `rule.action === "ask"` | `risk-policy.ts:389-400,398-399`；host `evaluateHostRiskRequest:205-211` | 用户显式要求人/审；静态再聪明也不能吞掉规则 |
| R2 | `rule.action === "deny"` | `risk-policy.ts:292-293,202-203` | hard deny；进 block，不是 skip |
| R3 | `risk !== "LOW"`（REVIEW/HARD） | `classifyRisk` / bash dangerous：`risk.ts:1035-1067`；`risk-policy.ts:332-336` | 静态已标出危险/不透明/越界；Guardian 可做 **上下文** 判断，但不是「已 allow」 |
| R4 | `escalationRequested` / `executionMode==="escalated"` | `shell-permissions.ts:86-105`；`risk-policy.ts:241-254,398-414`；Engine 校验 `:1851-1878` | 执行离开 sandbox，批准≠被 SRT 强制；host boundary 要求保留 escalation 审 |
| R5 | 未覆盖的 `filesystemWriteRoots` / write path outside roots | `resolveAdditionalWriteRoots` 只收 **outside allowed** 根（`shell-permissions.ts:193-200`）；`risk-policy.ts:338,381-383`；`register.ts:1892-1900` | 写权限扩张；`requestCovered` 为 false 时必须审 |
| R6 | 未覆盖的 `networkHosts` / `network-all` | Engine `requestCovered` + private deny（`:771-796,1886-1907`）；inline `:2416-2457` | 网络目标不在授权集合；一次 endpoint 批准不得扩成整命令重放 |
| R7 | private/special-use 网络 | `privateNetworkBlocked` `:614-623`；`risk-policy.ts:315-320`；boundary deny | 硬策略 block；不是「审一下就能过」 |
| R8 | `review === "action"`（无 capability 字段的 action review） | `admissionPlanFromRiskDecision:103-108`；Engine `forcedManualReview:2165,2203` | 动作身份本身未静态闭合（escalation / rule-ask / REVIEW 无 caps / host prompt） |
| R9 | `ownership === "host-admission"` 且 admission 为 review | `hostAdmission` 强制 `review:"action"`（`pi-permissions.ts:161-166`）；boundary review-only after allow | Host 工具批准后无 SRT；不能把 opaque side effect 当静态已强制 |
| R10 | `permission-amendment` / `request_permissions` 非空 | `evaluateRequestPermissions` 恒 prompt REVIEW（`risk-policy.ts:145-160`）；Engine `:2090-2102` | turn 权限世界变更；host 无 session grant，amendment 是唯一权威变更点 |
| R11 | `source === "manual-retry"` / `approvalOverride` | Engine armed retry `:2063-2088,2173-2201`；`armRetry:2496-2516` | 上一决策是 **deny**；用户 `/approve` 是要重新审，不是免审 |
| R12 | native write/edit preparation recovery | `handleNativeActionFailure` → `runReview` `:1685-1697`，risk 硬编码 REVIEW | 失败动作残余 effects + 新 write root；非 proven sandbox denial |
| R13 | inline network 且 `!requestCovered(baseline, host/port)` | `authorizeInlineCapability:2416-2457` | 默认空 allowlist + connect-guard 下，公网 endpoint 不在静态授权集 |
| R14 | circuit open / reviewer unavailable / policy error | `runReview:1177`；policyCheck error | fail-closed block，不是 skip |
| R15 | sandbox not ready / mode auto enforcement unavailable | Engine `:1827-1835` | 无强制器时 allow 等于裸执行 |
| R16 | delegation envelope 违例 | `register.ts:1564-1590,1709-1737,2232-2267`；network authorizer `:1419-1431` | 子代理不得扩权越过父 ceiling |
| R17 | stale generation / configFingerprint / cwd drift | `isCurrent`；`executeInvocationOwned:1811-1815`；beginTurn 清理 `:2524-2532` | authority 已变；旧决定不可复用 |
| R18 | yolo | `:1826,1174-1175` | 不是 skip-LLM 特权的证明，是 **另一模式**（unrestricted） |

**Metrics 陷阱（必须写进方案）：** JSONL `risk_level` 是 Guardian 自己的 risk 分类（low/approve 很常见），**不是**静态 `Risk=LOW` 且 admission=allow。P0 观测若只盯 `risk_level=low` 会把 R3/R13 误判成「假 skip 缺口」。

---

## 3. 入库盘点（runReview / force-review 路径）

`runReview` 定义：`src/approve-for-me-engine.ts:1168`。调用点共 **4** 处；另有静态层把动作变成 `AdmissionPlan.kind="review"` 的入口。下表按 **能否由静态挣得 skip** 分组。

### 3.1 可 skip（静态已能决定；今天多数已 skip）

| 路径 | call site | 静态 risk/action | 为何曾/仍可能进 LLM | can static earn skip? |
|---|---|---|---|---|
| Owned bash，sandboxed，非 dangerous，无 ask 规则，无 escalation，无 outside write roots | risk：`risk-policy.ts:332-336` + allow 返回 `:418`；admission：`adapters.ts:99-100`；Engine 无 review：`:2277-2286` | `allow` / `LOW` | **不进**（admission allow） | **yes（已实现）** |
| Owned write/edit 路径在 `allowWrite`∩非 protected | `writeRisk` `risk.ts:957-975`；`risk-policy.ts:370-386` allow | `allow` / `LOW` | 不进 | **yes（已实现）** |
| Host 工具无规则 / `rule.allow` | `evaluateHostRiskRequest:213-217` → admission allow+external-tool（`pi-permissions.ts:161-164`） | `allow` / `LOW` | 不进 | **yes（已实现）** |
| Review admission 的 requested 已被 baseline 覆盖 | Engine filter `:2158-2163`；`requestCovered:771-796` | review 但 caps covered | **不进**（filter 后空） | **yes（已实现）** |
| 连接 host 已在 `allowedDomains` / turn hosts / `network_access:true` | `requestCovered` network 分支 `:787-794`；`effectiveNetworkAuthority` `config.ts:47-57` | bash 可为 LOW；连接已覆盖 | 不进 inline review | **yes；facts = 静态网络授权集已包含 endpoint** |
| `rule.allow` 且非 HARD、无 write roots、无 escalation | 短� `risk-policy.ts:389-396` | allow（risk 可为 REVIEW） | 不进 | **yes（已实现；规则优先）** |
| yolo 模式 | Engine `:1826`；`runReview:1174-1175` | undefined risk | 不进 Guardian | n/a（另一模式，不是 P0 skip 谓词的成功例） |

### 3.2 不可 skip（residual 仍在；fail-closed 进 Guardian 或 block）

| 路径 | call site | 静态 risk/action | 为何仍进 LLM | can static earn skip? |
|---|---|---|---|---|
| Shell owned + `require_escalated` | risk prompt `risk-policy.ts:404-414`；Engine escalated 校验 `:1851-1878`；admission review action + escalated | 常 `LOW` 仍 prompt（R4） | `wouldPrompt` 因 `escalationRequested`；`review:"action"` → `forcedManualReview` | **no**（R4+R8；host boundary） |
| Shell + `rule.ask` | `risk-policy.ts:398-408` | 可 `LOW` + prompt | R1 | **no** |
| Shell substitution / non-sandboxed `classifyRisk` REVIEW / deletion hard carve-out | `risk.ts:1062-1066`；`risk-policy.ts:341-367` | `REVIEW` + 多为 action review | R3+R8：静态无法闭合命令效果 | **no** |
| Write/edit outside roots / protected elevation | `risk-policy.ts:370-386`；`register.ts:1892-1900` 把 target 塞进 `filesystemWriteRoots` | `REVIEW`/`HARD` + capability | R5；target outside baseline | **no**（除非 facts=路径已在 allowWrite——则静态本就 allow） |
| `request_permissions` / permission-amendment | register execute `:2200-2346`；Engine `runReview:2090-2102`；source `permission-amendment` 或 `manual-retry` | 恒 `prompt`/`REVIEW` | R10；Engine 对 intent 路径 **无条件** review | **no**（v1；no-op amendment 也保留审，见 §4.5） |
| Host-admission 且 risk prompt（rule ask 等） | `authorizeHostTool:1542-1610`；`hostAdmission` `:161-166`；Engine `runReview:2212` | `prompt`/`REVIEW` → action + external-tool | R1+R9 | **no** |
| Inline network，endpoint 未覆盖 | authorizer `register.ts:1456-1459` → `authorizeInlineCapability` `engine.ts:2438-2457`；source `inline` | bash 静态可 `LOW`；连接 `REVIEW` | R6/R13：默认空 allowlist + connect-guard `srt-enforcer.ts:129` | **only-with-extra-facts**：`network_access:true` **或** allowedDomains/turn grant 已含 host（此时代码已 skip） |
| Native write/edit recovery | `engine.ts:1685-1697` source `inline` risk `REVIEW` | 失败证据驱动 | R12 | **no** |
| Manual `/approve` armed retry | `recoverDeniedAction` `pi-permissions.ts:487-522`；Engine `:2173-2201` source `manual-retry` | 记录原 denial risk | R11 | **no** |
| Nested/delegated 越 ceiling | register 检查 + authorizer reject（见 R16 行号） | 多在 review 前 **block** | R16；不进 skip | **no**（block） |
| Private network / rule deny / policy error / circuit open | 见 §2 R2/R7/R14 | HARD/错误 | block 或 review-unavailable | **no** |

### 3.3 Engine `runReview` 调用点对照（file:line）

| # | site | source | 静态/入参 risk | 进入条件（摘） | skip? |
|---|---|---|---|---|---|
| 1 | `approve-for-me-engine.ts:1685` | `inline` | `risk:"REVIEW"` | native recovery 全门槛通过后 | no |
| 2 | `approve-for-me-engine.ts:2090` | `permission-amendment` \| `manual-retry` | `risk:"REVIEW"` | `request.intent` 存在且 policyCheck allow | no |
| 3 | `approve-for-me-engine.ts:2212` | `preview` \| `manual-retry` | admission.risk | `reviewRequested.length>0 \|\| forcedManualReview` | 仅当 filter 后空且非 forced（已是 skip） |
| 4 | `approve-for-me-engine.ts:2438` | `inline` | `risk:"REVIEW"` | inline capability 未 covered 且非 restricted-deny | only-with-extra-facts |

**引用的 Engine 条件（原文级）：**

```text
// preview 路径
let reviewRequested =
  admission.kind === "review" && admission.review === "action"
    ? admission.requested
    : admission.kind === "review"
      ? admission.requested.filter((item) => !requestCovered(baseline, item))
      : [];
let forcedManualReview = admission.kind === "review" && admission.review === "action";
// ...
if (reviewRequested.length > 0 || forcedManualReview) {
  // policyCheck → runReview(...)
} else {
  // executeAttempt without Guardian
}
```

```text
// risk-policy
const wouldPrompt = promptedByRule || risk !== "LOW" || escalationRequested;
if (rule?.action === "allow" && risk !== "HARD" && filesystemWriteRoots.length === 0 && !escalationRequested)
  return { action: "allow", risk, reason: "Allowed by permissions rule" };
```

```text
// inline capability
if (requestCovered(baseline, normalized)) return { kind: "allow", capability: normalized };
// restricted/proxy without inlineReview → permission-required (no review)
// else runReview(source:"inline")
```

---

## 4. 方案（chokepoint + predicate + 伪代码 + 默认行为）

### 4.1 单一 chokepoint

**落在 Engine `executeInvocationOwned` 进入 `runReview` 之前的那一个闸门**（今天已是 `if (reviewRequested.length > 0 || forcedManualReview)`，约 `:2203`），并 **同一谓词** 复用于 inline/amendment/recovery 的 review 入口（可选薄封装，但 **逻辑只定义一次**）。

- 不放 register：register 是 host 适配器，已有多入口（bash/write/edit/host/request_permissions），散落 skip 会破坏原则 3。
- 不放 `admissionPlanFromRiskDecision` 单独决定：那是投影，不是授权（文件头注释已写明）。
- 纯函数可放 **`src/permissions/residual.ts`（新）** 或 `src/risk-policy.ts` 旁；Engine 与 adapters 只消费结果。
- **Defense in depth：** risk-policy 应保证「无 residual 的 prompt」不存在；Engine 谓词是第二道闩，防止未来 adapter 误造 `kind:"review"`。

### 4.2 谓词（概念 TypeScript，非完整 patch）

```ts
export type ResidualSignal =
  | "rule_ask"
  | "rule_deny"
  | "risk_not_low"
  | "escalation"
  | "capability_uncovered"
  | "action_review"
  | "host_admission_review"
  | "permission_amendment"
  | "manual_retry"
  | "native_recovery"
  | "inline_network_uncovered"
  | "policy_or_runtime_unavailable";

export type SkipDecision =
  | { skip: true }
  | { skip: false; residuals: readonly ResidualSignal[]; block?: boolean };

/** ONE predicate. Call only after normalizeAdmission + hard policyCheck allow. */
export function decideGuardianSkip(input: {
  mode: "auto" | "yolo";
  ownership: InvocationOwnership;
  admission: ResolvedAdmission;          // allow | review | deny
  baseline: CapabilityLease;
  reviewRequested: readonly CapabilityRequest[]; // post-requestCovered filter
  forcedManualReview: boolean;
  source: GuardianReviewInput["source"];
  escalation: boolean;                   // executionMode==="escalated"
  circuitOpen: boolean;
  sandboxReady: boolean;
  configFingerprint: string;             // must match turn snapshot
  turnGenerationCurrent: boolean;
}): SkipDecision {
  if (input.mode === "yolo") return { skip: true }; // existing unrestricted path
  if (!input.turnGenerationCurrent || input.circuitOpen || !input.sandboxReady)
    return { skip: false, residuals: ["policy_or_runtime_unavailable"], block: true };
  if (input.admission.kind === "deny") return { skip: false, residuals: ["rule_deny"], block: true };
  if (input.admission.kind === "allow" && input.reviewRequested.length === 0 && !input.forcedManualReview)
    return { skip: true }; // static allow — already the free path

  const residuals: ResidualSignal[] = [];
  if (input.source === "manual-retry") residuals.push("manual_retry");
  if (input.source === "permission-amendment") residuals.push("permission_amendment");
  if (input.source === "inline") {
    // inline = uncovered connection or native recovery; both residual
    residuals.push(input.ownership === "sandbox-owned" ? "inline_network_uncovered" : "native_recovery");
  }
  if (input.escalation) residuals.push("escalation");
  if (input.forcedManualReview) residuals.push("action_review");
  if (input.ownership === "host-admission" && input.admission.kind === "review")
    residuals.push("host_admission_review");
  if (input.admission.kind === "review") {
    if (input.admission.risk !== "LOW") residuals.push("risk_not_low");
    if (input.reviewRequested.length > 0) residuals.push("capability_uncovered");
  }
  // R1 cannot be seen inside Engine alone: risk-policy must stamp it on the plan.
  const stamped = (input.admission as { residuals?: readonly ResidualSignal[] }).residuals ?? [];
  for (const r of stamped) if (!residuals.includes(r)) residuals.push(r);

  if (residuals.length === 0) {
    // Defensive only: review plan claimed but no residual after coverage filter.
    return { skip: true };
  }
  return { skip: false, residuals };
}
```

**risk-policy 侧最小语义强化（同一谓词的生产端）：**

```ts
// prompt 必须带非空 residuals；allow 不得带 residual
type RiskDecisionPrompt = {
  action: "prompt";
  risk: Risk;
  reason: string;
  residuals: [ResidualSignal, ...ResidualSignal[]]; // NEW
  // existing summary/networkHosts/...
};
```

`wouldPrompt` 构造处显式推导：`rule_ask` / `risk_not_low` / `escalation` 等，禁止裸 prompt。

### 4.3 默认行为变化

| 类别 | v1 默认 |
|---|---|
| 静态 `allow` + covered caps | **无变化**（已 skip） |
| rule ask / escalation / REVIEW·HARD / amendment / retry / native recovery / uncovered inline network / host review | **无变化**（仍进 Guardian 或 block） |
| 无 residual 却 `kind:"review"` | **收紧为 skip 或直接在 adapter 拒绝生成**（防御；现网应几乎不出现） |
| metrics | 可选增加不阻塞字段（见 4.4） |
| 连接级公网默认 | **仍审**（不把 public internet 变成静态 allow） |

### 4.4 Metrics（可选、不阻塞 P0、不与 N1/N2 打架）

- 不要求完成 N1 `requestSource` / N2 `tokenUsage`。
- 建议 **加性** 字段（schema 仍可保持兼容缺省）：
  - `static_risk`：来自 `RiskDecision.risk` / admission.risk（`none|LOW|REVIEW|HARD`）
  - `review_source`：`preview|inline|permission-amendment|manual-retry`（Engine 已有）
  - `residual_signals`：低基数 tag 串或 bitmask
  - 可选 counter：`skipped_static`（Engine skip 时写一条非 Guardian 事件，或仅 debug logger）
- Sink 已透传 `event.metrics.*`（`register.ts:220-257`）；**不要**在 P0 重写 metrics schema 语义。

### 4.5 Same-turn / fingerprint reuse：**P0 v1 明确 NO reuse**

**推荐：P0 v1 不做同回合 fingerprint 授权复用。**

理由：

1. 原则 2：skip 必须由 **静态** 挣得；reuse 是把 **先前 LLM 决定** 当授权缓存——另一类特权，不是 skip-LLM ladder 的同一语义。
2. pi Engine 设计明确 **禁止第二本可变授权账本**（`docs/host-api-boundaries.md`：无 session grant；turn grants 是 exact one-shot）。Reuse cache 会变成影子 session grant。
3. Codex pin 有 `strict_auto_review`（Skip 仍审）；pi **没有** 对应闸门。若 v1 同时引入 reuse 又无 strict，会比 Codex 默认更松——违反原则 6。
4. Fingerprint 漂移面大（cwd/metadata/justification/timeout/mode/delegation/config）；fail-closed 测试成本高，容易变成复杂性陷阱（latency note 自己也把 reuse 标成 optional）。

P1 若做：仅 `sandbox-owned` + 非 escalated + 非 dangerous + 本 turn **已 Guardian approve 的同一** `fingerprintValue({sessionId,turnId,configFingerprint,ownership,tool,input,cwd})`，任一字段不同立即回 review；仍不得 host-admission / amendment。

### 4.6 运营层（零代码、可与 P0 并行）

若 first-week metrics 显示 residual 以 `inline_network_uncovered` 为主：

- 指导用户配置 `sandbox.network.network_access: true`（Codex Enabled 语义，`docs/research/2026-09-12-network-access-whole-open.md`），或写入精确 `allowedDomains` / 使用 `request_permissions` turn hosts。  
- 这些路径 **已** 能让 `requestCovered===true` 并 skip inline LLM；connect-guard 仍强制 SRT 列表为空，但 Engine 授权已由静态网络权威覆盖。  
- **不要** 把「默认 public 全开」写进 P0 代码。

---

## 5. 测试与验收

### 5.1 命令（实现阶段）

```text
npm run preflight:sibling   # sibling pi-core 在位且 clean；dirty = 结果不可验收
npm run check
npm run lint
npm test
# 仅当改动 mid-turn mode apply / host lifecycle 时：
npm run check:host-turn-boundary
```

本 note 为设计交付，**本 session 未跑**上述命令（bash 受限；且未改产品代码）。

### 5.2 必须通过的 hermetic cases（建议文件名）

| 文件 | Case 列表 |
|---|---|
| `tests/permissions-residual.test.ts`（新） | 谓词：allow→skip；prompt+rule_ask→review；escalation→review；covered caps→skip；uncovered caps→review；manual-retry→review；amendment→review；inline uncovered→review；inline covered→skip；circuit/sandbox down→block；yolo→既有 unrestricted |
| `tests/risk-policy.test.ts`（扩） | 每个 prompt 分支 `residuals` 非空；allow 分支无 residuals；`filesystemWriteRoots` 仅 outside 时才 prompt；sandboxed non-dangerous bash 仍 allow LOW；rule.allow 短路仍 allow |
| `tests/approve-for-me-engine.test.ts`（扩） | `admission.kind=allow` 时 `guardian.review` **0 次**；review+全部 covered 时 0 次；review+uncovered 时 1 次；escalated action review 仍 1 次；armed retry 仍 1 次；amendment 仍 1 次 |
| `tests/pi-approve-for-me-adapters.test.ts`（扩） | `admissionPlanFromRiskDecision` 透传/校验 residuals；allow 仍 `{kind:"allow"}`；host allow 仍带 external-tool requested |
| `tests/register.test.ts`（扩） | host 无 rule → submit 后无 Guardian call；rule ask → 有 Guardian call；bash LOW allow → 无 call |
| `tests/guardian-metrics.test.ts`（可选扩） | 若加 `static_risk`/`review_source`：缺省兼容；skip 事件不破坏 JSONL enums |
| 既有 dirty sibling 规则 | 不得在 dirty `../pi-core` 上宣称 acceptance |

**明确不进 P0 测试范围：** Jev/Luna stub、strict_auto_review 默认开、worker residency、黑名单删除回归（除非误触）。

---

## 6. 明确不做（P0）

| 不做 | 原因 |
|---|---|
| Jev / Luna / 第二决策模型 | 原则 4；thin by **not entering** LLM |
| `strict_auto_review` 默认开 | 与 skip-LLM 相反；对齐笔记 N3：勿混做 |
| 删除/掏空 `shellCommandIsDangerous` 黑名单 | 09-18 已关闭伪前提；pin 仍有 danger gate |
| Worker residency / warm pool | 延迟路径 P2，不改变授权语义 |
| Session-scoped grants / ApprovedForSession | host boundary 明确禁止第二账本 |
| Same-turn fingerprint **授权** reuse | §4.5 |
| 默认 `public network = static allow` | 放宽 connect-guard 产品姿态；应用配置轴 |
| HARD → 永不进 Guardian（强制 block） | 会改变「dangerous + 上下文」审批语义；若要做需独立产品决定（更接近 Forbidden/minimax HARD_BLOCKED），**不是**本 P0 skip 谓词的必选项 |
| 用 Guardian 的 `risk_level=low` 证明静态可 skip | metrics 语义错误（§2 末） |
| 在 adapters 里散落 `if (risk==="LOW") return allow` | 违反原则 3；host/owned 语义会漂 |

---

## 7. 风险与 first-week 观测

### 7.1 若 skip 过宽会发生什么

| 过宽形态 | 后果 |
|---|---|
| 对 uncovered network 也 skip | 等价于默认公网自动放行；一次 tool call 可 exfil；与 connect-guard 设计目的相反 |
| 对 escalation skip | unsandboxed bash 无 action review；denyRead/delegation 语义被绕过 |
| 对 rule.ask skip | 用户配置失效；信任崩坏 |
| 对 host-admission review skip | MCP/custom 在 host 原生权限下静默执行；无法 SRT 强制 |
| 对 amendment/retry skip | turn 权限变更与 deny 后重放失去闸门 |
| Reuse + 无 strict + 漂移不 fail-closed | 输入已变仍按旧 approve 执行 → 原则 2 直接破产 |
| 把 metrics low 当 allow | 误删「本应审」的路径，形成静默回归 |

### 7.2 First-week 观测计划（实现后）

1. 打开 `static_risk` + `review_source` + `residual_signals` 后，按 residual 分桶统计 Guardian `duration_ms` 与条数。  
2. 期望：`capability_uncovered` / `risk_not_low` / `escalation` / `inline_network_uncovered` 占大头；**不应**出现 residual 空却仍 `reviewing` 的行（若出现 = 谓词漏洞）。  
3. 若 `inline_network_uncovered` 主导：产品输出是 **配置指南**（network_access / allowedDomains / turn grant），不是立刻改默认。  
4. 若 `rule_ask` 主导：检查用户 `permissions.json` 是否过宽 ask。  
5. 对比 skip 前后：同一工作负载的 `guardian-metrics.jsonl` 条数；skip 路径 `blocked`/`review-denied` 率不得上升。  
6. 回滚条件：出现「静态 allow 却仍审」以外的 **安全回归**（本应 block 的被放行）→ 立刻 revert 谓词改动。

---

## 8. D. 被拒绝的替代方案

| 方案 | 为何更差 |
|---|---|
| **每个 adapter 自己 skip**（register bash/write/host 各写 if） | 违反原则 3；同一 residual 在 owned/host/nested 表现不一致；测试矩阵爆炸；无法回答「唯一闸门是否 fail-closed」 |
| **配置 flag 森林**（`skipLowRisk` / `skipNetwork` / `skipHost` / `skipAmendment`…） | 每个 flag 都是一条扩权旋钮；无 residual 分类学；默认值错误即全局放行；与原则 2「skip 必须挣得」相反 |
| **在 Guardian 内做 fast-path**（模型先自称 static-ok） | 仍付 RTT；原则 1 要求静态决定则 **不进** LLM |
| **P0 就上 Jev/Luna classifier** | 原则 4；引入第二失败面与第二观测语义 |
| **P0 默认 reuse** | §4.5；影子 session grant + 无 strict 比 Codex 更松 |
| **只改 metrics 不写谓词** | 解决不了「未来误造 review admission」；也回答不了「唯一决策点在哪」 |
| **只写谓词不钉 risk-policy residuals** | Engine 不可知 R1（rule_ask）等静态事实；chokepoint 会退化成「只看 caps 是否 covered」——与今天重复，零增量 |

**对比一句话：** 单谓词把「何为 residual」变成 **可测试的类型**；散落 skip 与 flag 森林把授权语义稀释成调用点口味，审计时无法证明 fail-closed。

---

## 9. 实施切片建议（仍属设计，非本 note 交付）

1. **Slice A（纯化，零行为变化）：** `residual.ts` + risk-policy 给 prompt 打 `residuals` + Engine 闸门改调 `decideGuardianSkip` + 表驱动测试。  
2. **Slice B（观测）：** metrics 加性字段 + first-week 分桶。  
3. **Slice C（仅当 metrics 证明）：** 配置文档/模板推荐 `network_access` 或 allowlist；**不**改默认。  
4. **明确不排进 P0：** reuse、strict、Luna/Jev、HARD→Forbidden 产品化、worker residency。

---

## Grok 对立审查（2026-09-19，`grok -p` @ grok 1.0.34）

外部 CLI 对本 note + 源码抽查后的**异议**（非设计方背书）：

| 主题 | Grok 立场 | 证据 / 可证伪点 |
|---|---|---|
| 主张1 静态 allow 已 skip | **同意**（preview 闸门） | adapters `:95-100`；engine `:2157-2286`；metrics risk 为 Guardian 自评 |
| 主张2 主浪费=inline network | **部分同意**：因果链成立，**未测主浪费** | 需 `review_source` 分桶；AllowOnce 删缓存 → 同 host 可再审（`:2480-2485`） |
| 单 chokepoint 钉 `:2203` | **不同意** | `runReview` 四入口仅 preview 经 `:2203`；公共点是 `runReview` 本身（`:1168`） |
| residual 空 → skip | **反对：fail-open** | 漏 stamp/未知 review=免审；应「无 residuals 的 prompt **拒绝发出** / 未知 review **仍审**」 |
| R3 `risk!==LOW` 一律必审 | **与活代码冲突** | `rule.allow` 短路可让 REVIEW+allow 不进 LLM（`risk-policy.ts:389-396`） |
| R12 native recovery | 设计伪代码可能 **误标**为 inline_network | recovery 也是 `sandbox-owned`+`source:inline`（`:1685-1696`） |
| P0 拒绝 reuse | **同意** | 与 AllowOnce/in-flight 去重区分；同 attempt 同 host 多次审是产品选择可另开 P1 |
| 若只改一处 | **adapters `admissionPlanFromRiskDecision`** | `action:"prompt"` 必须带非空 `residuals`，否则不发 `kind:"review"`；risk-policy 负责填空 |

**最不同意点（Grok 原文大意）：** 把「residual 为空」当成 skip 特权的核心；空数组=未证明有 residual，≠证明无 residual。

### 修订后的 P0 形状（吸收异议后）

```text
1. 不新做 Engine 内 18 路 residual 再推导（会与四入口/双写 stamp 漂移）。
2. 保持现有 skip 语义：allow / requestCovered 滤空 / yolo / 各 call-site 条件。
3. P0 增量 = 投影层硬约束：
   - risk-policy / host ask / request_permissions 的 prompt 必须带 residuals[]
   - admissionPlanFromRiskDecision：prompt 无 residuals → 拒绝或降级为明确 residual
   - 未知 kind:"review" fail-closed（仍审或 reject），禁止空 residual skip
4. metrics：static_risk / review_source / residual_signals（先分桶再谈 inline 默认）
5. 仍不做：reuse 授权、Jev、默认 public=allow、动 SRT/host-admission 双通道
```

---

## This note does not claim

- 未实现任何产品代码；未修改 `src/**`。
- 未重跑 `preflight:sibling` / `check` / `lint` / `test` / `check:host-turn-boundary`（本 session bash 受限；且无代码变更可验收）。
- 未读取本机 live `~/.pi/agent/guardian-metrics.jsonl`；关于 low+approve 的解释来自 **源码路径 + 既有 note 的观测描述**，不是本 session 重新统计。
- 不声称 Codex/fx 在 pin 外的后续提交已有不同 Skip 语义；Codex 对齐仅基于 pin `129fd216…` 与仓库内既有研究。
- 不声称 `network_access:true` 在所有 SRT/TLS 组合下零审（system TLS / deniedDomains / delegation 仍有硬否决）。
- 不声称 HARD→Guardian 是错误设计；本 note 只主张 **metrics 的 low 不等于静态 allow**，以及 residual 空才可 skip。
- 不批准、不实现 N1/N2/N3；不与 P0 混做。

---

## 附录：关键 file:line 索引

| 主题 | 位置 |
|---|---|
| `runReview` | `src/approve-for-me-engine.ts:1168` |
| preview 闸门 | `src/approve-for-me-engine.ts:2157-2275` |
| inline network review | `src/approve-for-me-engine.ts:2416-2457` |
| amendment review | `src/approve-for-me-engine.ts:2090-2102` |
| native recovery review | `src/approve-for-me-engine.ts:1685-1697` |
| `wouldPrompt` | `src/risk-policy.ts:398-416` |
| sandboxed bash LOW | `src/risk-policy.ts:332-336` |
| host risk | `src/risk-policy.ts:186-218` |
| request_permissions prompt | `src/risk-policy.ts:103-160` |
| admission 投影 | `src/pi-approve-for-me-adapters.ts:95-113` |
| hostAdmission | `src/pi-permissions.ts:161-178` |
| connect-guard 空 allowlist | `src/sandbox/srt-enforcer.ts:125-129` |
| network authorizer | `src/register.ts:1392-1469` |
| DEFAULT_CONFIG network | `src/config.ts:196-215` |
| Guardian 默认 reasoning | `src/auto-reviewer.ts:68-69` (`"low"`) |
| metrics sink | `src/register.ts:217-257`；`src/guardian/metrics.ts` |
| Host boundary | `docs/host-api-boundaries.md` |
