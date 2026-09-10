# Auto-approve / Approve for me：四方对比（2026-09-10）

对照对象：**Codex**、**kimi-code**、**MiMo-Code**、以及本项目 **pi-permissions**。

> **Codex pin 约定（standing）：** Approve for me 对齐正文统一钉
> [`129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`](https://github.com/openai/codex/commit/129fd21687fbd4ac48133b7abfdcaf52cb6cb01f)。
> 本文的 Codex 列是 2026-09-10 当日 main tip 快照 `b348fc2`，用于四方横向对照；产品对齐结论请回到 standing pin 复核。

| 侧 | 基准 |
| --- | --- |
| Codex | [`b348fc2`](https://github.com/openai/codex/commit/b348fc26674189f758d5941cdab3f78f258b2aa7)（当日 main tip 快照；standing pin=`129fd216`） |
| kimi-code | [`d3dc594`](https://github.com/MoonshotAI/kimi-code/commit/d3dc5945548d3353a5e6cfc457a3a8cf84d7da71)（blobless + sparse） |
| MiMo-Code | [`df9f3c9`](https://github.com/XiaomiMiMo/MiMo-Code/commit/df9f3c9df50f1969bad779b1d3236478b4e22ed5)（blobless + sparse） |
| Pi | 本仓库工作树（`src/**` 未提交改动即当前事实） |

> 本文只陈述**已取证**的事实，每条附 `文件:行号`。未检出/无法确认的一律标注"未确认"，不推测。

---

## 0. 一句话结论

**四个项目里，"auto-approve" 其实是三种完全不同的东西，只有本项目与 Codex 属于同一种。**

| 项目 | 本质 | 决策者 | 有真实沙箱兜底？ |
| --- | --- | --- | --- |
| **Codex** | **替换审批者**（reviewer substitution） | 第二个隔离 LLM | ✅ 有（且批准不扩大权限） |
| **Pi** | **替换审批者 + 执行尝试冻结** | Guardian LLM（独立子进程） | ✅ 有（批准不扩大权限） |
| **kimi-code** | **策略链短路**（policy chain short-circuit） | 本地静态规则 | ❌ 无 |
| **MiMo-Code** | **运行时旁路开关**（runtime bypass flags） | 本地静态规则 | ❌ 无 |

本项目是四者中**唯一**同时具备「LLM 审批者 + 真实 OS 沙箱 + 执行尝试级授权冻结」的组合。
但本项目也是四者中**唯一没有"问人类"作为一等模式**的 —— 三个上游全部把人审作为默认路径。

---

## 1. 模式与命名

### 1.1 模式枚举

| 项目 | 内部枚举 | UI 名称 | 默认值 |
| --- | --- | --- | --- |
| Codex | `AskForApproval{UnlessTrusted,OnRequest,Granular,Never}` × `ApprovalsReviewer{User,AutoReview}` | Read Only / Default / **Approve for me** / Full Access | Default（人审） |
| kimi-code | `'manual' \| 'yolo' \| 'auto'` | **Always Ask** / **Ask When Needed** / **Never Ask** | `manual` |
| MiMo-Code | 无 mode 枚举；tri-state 规则 + 3 个运行时开关 | 无模式名 | `allow` 为主的宽松默认 |
| **Pi** | `"auto" \| "yolo"` | **Approve for me** / **Full access** | `auto` |

取证：

- Codex `codex-rs/protocol/src/protocol.rs:992-1013`、`config_types.rs:175-190`；菜单 `tui/src/chatwidget/permissions_menu.rs:101-109,188-192`；标签常量 `tui/src/chatwidget.rs:512-514`。
- kimi `packages/agent-core-v2/src/agent/permissionPolicy/types.ts:8`；默认值 `permissionMode/permissionModeOps.ts:23`；UI 名 `apps/kimi-code/src/tui/utils/permission-mode.ts:3-13`。
- MiMo `packages/opencode/src/permission/index.ts:37` `Action = ["allow","deny","ask"]`、`:65` `Reply = ["once","always","reject"]`。
- Pi `src/state.ts:5`；标签 `src/permission-copy.ts:67`；状态栏 `src/register.ts:361`；严重度 `src/mode-runtime.ts:64-66`。

### 1.2 命名最容易踩的三个坑

1. **kimi 的 `yolo` 比 `auto` 更保守。** 这是反直觉设计，务必别误读：
   - `auto` = `'Never Ask'` = "Never interrupts you; everything runs and is decided automatically."
   - `yolo` = `'Ask When Needed'` = "Routine edits and commands run automatically; **risky actions, questions, and plans still ask**."
   （`apps/kimi-code/src/tui/utils/permission-mode.ts:3-13`）
   名字与实际严格程度**相反**：真正的全自动叫 `auto`，而叫 `yolo` 的反而保留危险询问。

2. **MiMo-Code 没有"approve for me"模式**，只有四个不同层的东西，常被混为一谈：

   | 名词 | 层次 | 作用 |
   | --- | --- | --- |
   | `--yolo` / `--dangerously-skip-permissions` | CLI flag | 在用户规则**之下**注入 `{"*":"allow"}` 基线 |
   | `skip-all`（`/skip-permissions`） | per-Instance 运行时布尔 | 放行普通 ask；**排除** forced-ask |
   | `autoApproveDelete` | per-Instance 运行时布尔 | **只**放行不可逆删除的二次确认 |
   | `auto-respond` | 前端 web/desktop UI | 客户端决定是否自动回复，不是服务端规则 |

   取证：`cli/cmd/tui/thread.ts:204-208,251-263`、`config/config.ts:984-988`、`permission/index.ts:186-201,239-241,298,310`、`packages/app/src/context/permission-auto-respond.ts`。

3. **Codex 把"何时问"和"谁来批"拆成两轴**，本项目把它压成了一个开关。Codex 的 `permissions_menu.rs:101-109` 里，"Approve for me" 就是把 `OnRequest + AutoReview + :workspace` 三件套打包成菜单项。

---

## 2. 决策者

| 项目 | 决策链 | 有 LLM 审批者？ |
| --- | --- | --- |
| **Codex** | 静态 exec-policy → **guardian LLM** → 人 | ✅ 是，且是核心机制 |
| **Pi** | 静态 risk → Engine 硬策略 → **Guardian LLM** → 人（仅 `/approve`） | ✅ 是 |
| **kimi-code** | **13 条硬编码策略链**，首个返回非 `undefined` 者胜 | ❌ 无（grep 无 classifier/reviewer/llm 命中） |
| **MiMo-Code** | `evaluate()` 静态规则 + 运行时开关 | ❌ 无（无 LLM/子代理审批者） |

**Codex 的接管条件**（`core/src/guardian/review.rs:132-140`）：

```rust
matches!(approval_policy, AskForApproval::OnRequest | AskForApproval::Granular(_))
    && approvals_reviewer == ApprovalsReviewer::AutoReview
```

**Pi 的接管条件**：静态 risk 输出 `prompt` → `admissionPlanFromRiskDecision()` 投影为 `AdmissionPlan{kind:"review"}`（`src/pi-approve-for-me-adapters.ts:92`）→ Engine 硬策略 `policyCheck()`（`approve-for-me-engine.ts:1096`）→ `runReview()`（`:1113`）→ Guardian。yolo 在 `:1730` 直接 `executeUnrestricted()` 短路。

**kimi 的策略链顺序**（`permissionPolicy/permissionPolicyService.ts:57-73`，硬编码）：

```text
1  auto-mode-ask-user-question-deny   ← auto 模式下唯一还能 deny 的
2  user-configured-deny
3  dangerous-command-ask               ← nonInteractive 时整条移除 (:60-62)
4  auto-mode-approve                   ← ★ auto 在这里短路
5  session-approval-history
6  user-configured-ask
7  user-configured-allow
8  sensitive-file-access-ask
9  git-control-path-access-ask
10 yolo-mode-approve                   ← ★ yolo 在这里短路
11 default-tool-approve
12 git-cwd-write-approve
13 fallback-ask                        ← 无条件兜底
```

> **这两个项目对"auto"的实现差异是本质性的**：Codex/Pi 的 auto = *换个审批者*（决策仍然逐次发生）；
> kimi/MiMo 的 auto = *在策略链上跳到更早的短路点*（决策被结构性跳过）。
> 前者保留"每次都评估"，后者把危险命令策略整条**从链上摘掉**（`dangerous-command-ask.ts:122` `if (this.modeService.mode === 'auto') return undefined;`）。

---

## 3. 决策时机与授权粒度

| 项目 | 时机 | 粒度 | 持久化 |
| --- | --- | --- | --- |
| **Codex** | 每次工具调用 | 单次行动；`request_permissions` 支持 `Turn`/`Session` | 审批作为证据缓存复用，除非 `FreshRequired` |
| **Pi** | 每次调用 → **执行尝试创建时冻结** | one-shot grant / per-turn / 无 session 持久 | turn 结束即清；无跨 session 持久授权 |
| **kimi-code** | 每次工具调用 | `once` / `session` 两档 | `session` 批准落 **durable** 事件，按字面 pattern 复用 |
| **MiMo-Code** | 每次工具调用 | `once` / `always` / `reject` | `always` 落 **DB**（跨进程存活）；runtime 开关不持久 |

**本项目独有的"冻结点"语义**（四者中唯一有此概念的）：

- 显式字段：`src/pi-approve-for-me-adapters.ts:222` `authorityFreezePoint: "execution-attempt-after-review"`
- 保证结构：`cloneSnapshot()`（`approve-for-me-engine.ts:523`，`beginTurn` 时深拷贝）+ 每次尝试现算并 `Object.freeze` 的 lease（`:1382-1404`）+ `generation`/`closed` 门禁（`:1055-1056`）
- 回归：`tests/register.test.ts:2063`、`tests/approve-for-me-engine.test.ts:2357`

```text
仍在运行的 A ──继续旧限制──┐
                          │  (不可回溯改变)
request_permissions ─审查─┤
                          │
新建尝试 B ────获得新权限──┘
```

Codex 最接近，但它用 `PermissionGrantScope{Turn,Session}` 表达（`protocol/src/request_permissions.rs:10-16`），
**没有**"运行中执行保持旧权限"的显式不可变投影。MiMo 的 `once/always` 与 kimi 的 `session` 都是**模型层**授权，无尝试级隔离。

**MiMo 的委托授权值得一提**：`forward`/`inherit` 模式下父会话可 `grant-approval` 子代理，
经 `grantAllowed()` 查 DB，**跨进程/重启存活**（`permission-forward-ref.ts:setGrant`、`permission.sql.ts`）。
本项目对应能力是 delegation ceilings（`src/delegation.ts`），语义是**收窄交集**而非授权传递 —— 方向相反。

---

## 4. 规则模型（优先级语义三家都不同）

| 项目 | 数据结构 | 优先级语义 |
| --- | --- | --- |
| **Codex** | `Decision{Allow,Prompt,Forbidden}` + `GranularApprovalConfig` 5 个布尔 | 静态 exec-policy；LLM 策略是**自然语言 prompt** 不是 pattern |
| **Pi** | `"allow"\|"ask"\|"deny"` + tool/pattern glob | **最强动作胜出**（`actionRank` reduce 取最大） |
| **kimi-code** | `{decision, scope, pattern, reason}`，pattern = `Tool(argGlob)` | **策略链位置优先**，链内每档取首个匹配 |
| **MiMo-Code** | `Rule{permission, pattern, action}` | **最后匹配胜出**（`findLast`） |

取证：Codex `execpolicy/src/decision.rs:9-16`、`protocol.rs:1016-1056`；Pi `src/permissions/rules.ts:35,55-58`；kimi `permissionRules/permissionRules.ts:13-22`、`matchesRule.ts:32-56`；MiMo `permission/evaluate.ts:9-14`。

> ⚠️ **本项目是四者中唯一"最强动作胜出"的** —— 既不是 first-match 也不是 last-match。
> 这不是 bug（deny 天然压倒），但对从 Codex/MiMo 迁过来的用户是**静默语义差异**：
> MiMo 下「`"*":"ask"` 在前、`"git *":"allow"` 在后」能放行 git；本项目的等价写法结果相同，
> 但「`"*":"allow"` 在前、`"rm *":"ask"` 在后」在 MiMo 会**放行**（last wins），在本项目会 **ask**。
> 建议在文档里显式写出该差异。

**kimi 的一个有意思设计**：`git-cwd-write-approve` 在 **manual 模式**下也会自动 approve Write/Edit，
条件是「所有写路径都在 workspace 内」且「cwd 在 git 工作树内（可回滚）」（`policies/git-cwd-write-approve.ts:23-53`，
测试 `permissionPolicyService.test.ts:546-555`）。它把"可回滚性"当成了自动批准的依据。

---

## 5. 危险命令 / 敏感路径兜底

| 项目 | 硬编码黑名单 | "不可被通配授权覆盖"的兜底 |
| --- | --- | --- |
| **Codex** | ❌ 无命令黑名单；改用**自然语言风险分类法** | 路由兜底：不满足条件则回落人审 |
| **Pi** | ✅ `rm -f`、删除类可执行文件、私有网段、受保护路径 | ✅ 受保护路径 + 私有网络 + escalation 冲突 |
| **kimi-code** | ✅ 显式黑名单 + `rm -rf` 判定 + 不可分析命令 | ✅ `dangerous-command-ask`（yolo 下仍问） |
| **MiMo-Code** | ✅ 删除/git 破坏性命令检测 | ✅ `FORCED_ASK = {bash_delete}` |

**Codex 明确不做命令黑名单** —— 它把 `rm -rf` 交给 LLM 按风险分类判断：
> "User-requested deletion of a specific local path with `rm -rf` is usually `low` or `medium` risk…"
> （`assets/guardian/policy.md`）

这是与本项目最大的哲学分歧：本项目在 `src/permissions/dangerous-commands.ts` 里硬编码了
镜像自 Codex 的 `is_dangerous_command.rs` 规则（文件头注释自陈），但 Codex 自己**已经改用 LLM 分类**了。
值得思考：本项目的静态黑名单是否与"Guardian 逐次审查"存在职责重叠。

**kimi 的两个值得借鉴的原语**：

1. **不可分析 → 问人**（fail-safe，非 fail-open）：`dangerous-command-ask.ts:132-135`
   `UNSAFE_OPERAND` 导致变量/通配/命令替换无法静态判定时返回 `{kind:'ask', reason:{unanalyzable_command:true}}`。
   本项目在 bash 侧是 `shellCommandIsDangerous()` 静态判定 + SRT 运行时拦截，路径不同但有类似意图。

2. **`dangerousCommandGuard` 可配置关闭** + `KIMI_CODE_DANGEROUS_COMMAND_GUARD` env（`configSection.ts:45-61`）。

**MiMo 的 `FORCED_ASK` 精确语义**（`permission/index.ts:222`）：

```ts
const FORCED_ASK = new Set(["bash_delete"])
```

任何 `allow`（**含** `"*":allow` 通配、**含**持久 `always`）都无法预授权它；
唯一绕过是独立的 `autoApproveDelete` 开关（`index.ts:283-293,573`）。
设计注释写得很清楚：*"trusting the model with deletes is its own, louder decision."*
（`index.ts:190-197`）

> 本项目没有完全对应的原语。本项目的保护是 `denyWrite` 路径级（`.git`/`.agents`/`.codex`/config），
> 而 MiMo 是**动作类别级**的"永不可预授权"。二者可以互补 —— 例如"仓库根的全量删除"这类
> 既不在受保护路径内、又不可逆的操作，本项目目前会走正常审查，MiMo 会强制问人。

---

## 6. 底层强制：decision-only vs enforced

**这是四者中差距最大的一维。**

| 项目 | 沙箱 | 批准后是否真受限 |
| --- | --- | --- |
| **Codex** | ✅ linux-sandbox / seatbelt / mxc / windows | ✅ 批准**不扩大**权限 |
| **Pi** | ✅ `@anthropic-ai/sandbox-runtime` 0.0.74 | ✅ 批准**不扩大**权限 |
| **kimi-code** | ❌ **全仓库无沙箱实现** | ❌ 批准 = 放行 |
| **MiMo-Code** | ❌ 无 OS 级隔离 | ❌ 批准 = 放行 |

取证：

- kimi：`git ls-tree -r --name-only HEAD | grep -iE "sandbox|seatbelt|bubblewrap|landlock|seccomp"` → **空**；
  Bash 是裸 spawn `processService.spawn(env.shellPath, ['-c', shellCommand], {env: noninteractiveEnv})`
  （`agent/tools/os/bash/bashTool.ts:158-171`）。
- MiMo：`packages/opencode/src/permission/` 与 bash 工具内 grep 无 seccomp/namespace/bubblewrap 命中。
  唯一近似强制的是 git worktree 保护 `IsolatedGit.assertIsolatedGitAllowed`（`tool/bash.ts:1242-1249`），**不是** OS 沙箱。

**kimi/MiMo 的真实硬约束只有一层**：文件工具的路径守卫（`resolvePathAccessPath` → `PathSecurityError`，
`toolExecutorService.ts:392-397`）。这一层与权限模式**正交**，auto/yolo 也绕不过 —— 这是它们唯一 fail-closed 的地方。

**Codex 与 Pi 共有的关键不变式**：审批者**只能放行，不能扩权**。

- Codex 显式写在代码里：*"Completion must invalidate stale approvals and **may only satisfy the review gate, never expand the action's execution authority.**"*（`ext/guardian-reviewer/src/review.rs:22-25`）
  Guardian 会话被强制 read-only + `approval_policy=never` + 清空 MCP（`core/src/guardian/reviewer_config.rs:87,41-47,94-96`）。
- 本项目的对应保证：`policyForReview()` 对 host-admission 返回 `undefined` 并附 `sandboxEnforcesAction=false`
  （`src/pi-approve-for-me-adapters.ts:197-214`），Guardian worker 自持只读 SRT（`allowWrite:[]`、`deniedDomains:["*"]`、`allowLocalBinding:false`，`src/guardian-worker.mjs:276-289`）。

**⚠️ 但本项目有两处 decision-only 缺口，Codex 不存在**：

1. **host-admission 工具**（MCP/custom/external）：`sandboxEnforcesAction=false`，代码注释自陈
   *"does not mean an external MCP/custom tool is isolated by the sandbox adapter"*（`adapters.ts:212-214`）。
2. **escalated Bash**：`policyForReview()` 注释 *"A one-shot escalated lease carries no sandbox policy"*（`adapters.ts:194-197`），
   即批准的是**真出沙箱**的一次执行。

Codex 对应路径同样存在（`SandboxPermissions::RequireEscalated` → `BypassSandboxFirstAttempt`，
`tools/sandboxing.rs:262-270`），但 Codex 在 denied-read 限制存在时会**抑制** bypass（`sandboxing.rs:255-260,283-295`）。
本项目的等价抑制是 delegation ceilings 与显式 deny 冲突检查（`src/risk-policy.ts:245-260`）。

---

## 7. 拒绝 / 失败路径

| 维度 | Codex | Pi | kimi-code | MiMo-Code |
| --- | --- | --- | --- | --- |
| **重试次数** | 3 次 / 90s，指数退避 | 3 次 / 90s | 无 | 无 |
| **Circuit breaker** | ✅ 3 连续 或 50 内 10 次 | ✅ 3 连续 或 50 内 10 次 | ❌ 无 | ❌ 无 |
| **人工放行一次** | `/approve` | `/approve` | — | `always`（规则级） |
| **超时行为** | `TimedOut` | `review-timeout`（blocked） | — | 自动拒绝 |
| **fail-closed** | ✅ 解析/会话失败 → Deny | ✅ | ❌（fail-open 到人） | ❌ |
| **escalation lease** | `require_escalated` → fresh review | ✅ `mode:"escalated"` 一次性 | ❌ | `forward` grant（DB 持久） |

本项目与 Codex 的 breaker 阈值**完全一致**（3 连续 / 10-of-50）：
Pi `approve-for-me-engine.ts:439-441,950-959`；Codex `ext/guardian-reviewer/src/circuit_breaker.rs:3-6,70-95`（Cyber 模型为 1/1）。

**本项目独有的保守设计（值得保留）**：

- **Bash 不自动重放**："no safe whole-command replay after a mid-execution denial"（`engine:2338-2344`）。
  Codex 有 `/approve` 重试；本项目网络中途拒绝连 retry handle 都不铸。
- **原生文件操作窄恢复**：仅在**内容写入前**、且 errno 严格匹配 `^(EACCES|EPERM|EROFS):` 时允许一次恢复（`engine:1492-1530`）；
  第二次失败终止并保留原始证据（`:1618`）。

**kimi 的一个细节**：拒绝后只对**子代理**追加"别重试"引导（`toolApprovalService.ts:257-259`），
主代理不给 —— 因为主代理可以与人类交互澄清。本项目对所有执行统一走 `renderPermissionErrorForAgent()`
的"不得 workaround"指令（`src/permission-copy.ts:97-110`）。

---

## 8. 本项目相对位置的诚实评估

### 8.1 明确领先的地方

1. **执行尝试级授权冻结** —— 四者唯一。Codex 的 `Turn/Session` scope 是模型层，没有"运行中执行不被回溯改变"的显式投影。
2. **真实 OS 沙箱 + LLM 审批者的组合** —— 只有 Codex 可比。
3. **网络授权绑定到连接边界** —— `allowedDomains: connectGuard ? [] : [...]` 强制所有请求走同一决策 + 父进程 connect guard 绑定已解析 DNS（`srt-enforcer.ts:112-114`、`network-boundary.ts`）。
   这是比 Codex 更细的一层：Codex 的 approval 是 per-action，本项目能到 per-connection。
4. **Guardian worker 的进程级隔离** —— 独立 Node 子进程 + 净化环境 + 自持 SRT 单例（`guardian-worker-client.ts:506-511,208-224`）。
   Codex 的 guardian 在同一进程内以受限配置运行（`reviewer_config.rs`），隔离强度弱于独立进程。
5. **deny 不可被批准解锁** —— 有回归测试（`tests/approve-for-me-engine.test.ts:616,649`）。
   MiMo 也做到（`FORCED_ASK`），kimi 也做到（deny 在链首），Codex 靠 LLM 判断。

### 8.2 明确缺失或弱于上游的地方

1. **没有"问人类"作为一等模式** ⚠️ 最大差异。
   本项目的 `default`/`plan` 模式已被移除（`src/state.ts:8` legacy 恢复为 `auto`），人只在 `/approve` 处
   **对已发生的 denial** 介入（`src/pi-permissions.ts:409`）。三个上游**全部**以人审为默认。
   本项目的 `auto` 严重度是 `"warning"`（`mode-runtime.ts:64-66`），即默认状态就带告警色 —— 这本身就是信号。

2. **无 per-agent / per-project 规则覆盖**。kimi 支持 agent frontmatter 权限（`~/.config/opencode/agents/review.md` 式），
   MiMo 支持 agent 级 `permission` 合并与优先级（`docs/permissions.mdx` Agents 段）。
   本项目只有全局 `rules[]` + delegation 收窄。

3. **规则优先级语义与上游都不同**（见 §4），且无迁移文档。

4. **无"永不可预授权"的动作类别原语**（对应 MiMo 的 `FORCED_ASK`），只有路径级保护。

5. **无"不可分析 → 问人"的 fail-safe 兜底**（对应 kimi 的 `UNSAFE_OPERAND`）。
   本项目在 bash 静态分析不确定时的行为需单独确认（`shellCommandIsDangerous()` 之外的分支）。

6. **kimi 的 `auto-mode-ask-user-question-deny`**：auto 模式下 `AskUserQuestion` 被 **deny**，
   因为"全自动模式不该停下来问问题"。本项目 auto 模式下模型仍可发起 `question` 工具 —— 语义上不一致，
   人已被移出审批环，但模型仍能阻塞在人身上。这是个**真实的行为漏洞**，值得评估。

### 8.3 已知未解决问题（沿用本仓库既有记录，非本次新发现）

- **Guardian 进程生命周期 P1（未修复）**：`docs/approve-for-me-handoff.md:168-195`。
  Codex 侧对应组件无此问题（guardian 在同进程内），这是独立进程方案**额外引入**的复杂度代价。
- **端到端验收未完成**：`approve-for-me-handoff.md:12`；R1–R10 审计未做（`:230-247`）。
- **启动协议实验 v4 失败**：`control=FAIL`，`primary=RuntimeError: unexpected target/prefix stderr`，stderr 原文未保留（`:200-210`）。
- **SRT 补丁依赖未固化**：`patches/` 与 `pnpm-workspace.yaml/lock` 仍在工作树未提交（`git status` 确认）。

---

## 9. 可借鉴项（按性价比排序）

| # | 借鉴点 | 来源 | 理由 |
| --- | --- | --- | --- |
| 1 | **补一个 `manual`/`Always Ask` 模式** | 三家共有 | 当前无"人审优先"路径；`/approve` 只覆盖 denial 后的重试 |
| 2 | **auto 模式下 deny `question` 类工具** | kimi `auto-mode-ask-user-question-deny` | 修复"全自动模式下仍阻塞在人"的语义漏洞 |
| 3 | **动作类别级 `FORCED_ASK` 原语** | MiMo `FORCED_ASK` | 路径级保护覆盖不到"仓库根全量删除"这类 |
| 4 | **"不可分析 → ask" fail-safe** | kimi `UNSAFE_OPERAND` | 静态分析不确定时应偏向问人 |
| 5 | **规则优先级差异显式文档化** | — | 三家语义各不相同，静默差异会导致误配置 |
| 6 | **per-agent 权限覆盖** | kimi frontmatter / MiMo agent 段 | 子代理比主代理更严是常见需求 |
| 7 | **Codex 的 denied-read 抑制 bypass** | Codex `sandboxing.rs:255-260,283-295` | 本项目 escalated bash 缺等价的自动抑制检查 |

**不建议借鉴**：kimi/MiMo 的"策略链短路"范式。它们的 auto 把 `dangerous-command-ask`
**整条从链上摘掉**（`dangerous-command-ask.ts:122`），配合无沙箱兜底，等于 auto 模式下 `rm -rf` 直接执行
（测试 `permissionPolicyService.test.ts:238-253` 明确断言 `rm -rf /tmp/build`、`dd of=/dev/sda`、`reboot` 一律 approve）。
本项目用 LLM 逐次审查 + SRT 强制，语义更强，不应退化为短路。

---

## 10. 取证局限（必须声明）

1. **kimi-code 与 MiMo-Code 为 blobless + sparse 克隆**，部分路径未落盘。
   已用 `git show HEAD:<path>` 回补（blobless clone 支持），但 `apps/kimi-code/src/tool/` 等仍属**部分取证**。
2. **两处"未确认"**（已在正文标注，未做推测）：
   - kimi `permission.rules` 配置注入运行时的调用方未找到（`IAgentPermissionRulesService.addRules` 在检出范围内无调用者）；
   - kimi `IAgentPermissionGate.authorize()` 在检出范围内无可达调用方，实际生效的是 `adjudicate()` 路径。
3. **上游为快速演进仓库**，本文结论仅对上述三个 commit 有效。
4. **本项目的"设计意图 vs 代码实际"**：本文以工作树当前内容为准；`docs/approve-for-me-handoff.md` 中的部分陈述是历史状态。
5. **本文是静态源码分析**，未运行任何上游项目做行为验证。
6. 本次调研为只读，**未修改本仓库任何源码**；`src/guardian-worker-client.ts:660`（biome `useOptionalChain`）
   与 `:974`（重复 `else if (lifecycle.retirementAcknowledged)`，死分支）是**既有**问题，未纳入本次范围。
