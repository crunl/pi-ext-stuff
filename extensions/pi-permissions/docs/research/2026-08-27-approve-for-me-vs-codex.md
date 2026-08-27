# Approve for me：pi-permissions vs Codex（2026-08-27）

对照当前实现与 `openai/codex` **main**，不是对照 7 月底的 pin。

| 侧 | 基准 |
|---|---|
| Codex | [`7625bd56657da7ce6d96b6d27e983e568757cdbc`](https://github.com/openai/codex/commit/7625bd56657da7ce6d96b6d27e983e568757cdbc)（2026-08-26，`Honor environment-resolved workspace roots`） |
| Pi | 本仓库 working tree：`src/register.ts` 的 `pi.on("tool_call")` + `makeGuardedExecute`，模式只剩 `auto` / `yolo` |

旧笔记（`docs/research/2026-07-30-codex-approve-for-me-alignment.md`、`2026-08-01-*`）钉的是 `789c72d` / `ee0247f`。Guardian **policy 文本**仍大体对齐；**运行时路由**已经漂移，尤其是 `request_permissions`。

---

## 1. 产品上什么叫「Approve for me」

Codex 把「何时问」和「谁来批」拆成两轴：

- `AskForApproval`: `untrusted` \| `on-request` \| `granular{...}` \| `never`
- `ApprovalsReviewer`: `user` \| `auto_review`（legacy 别名 `guardian_subagent`）

TUI 权限菜单把 **同一个 workspace-write + OnRequest preset** 标成两种名字：

- reviewer = `user` → 「Ask for approval」（Default）
- reviewer = `auto_review` → 「Approve for me」

证据：[`permissions_menu.rs`](https://github.com/openai/codex/blob/7625bd56657da7ce6d96b6d27e983e568757cdbc/codex-rs/tui/src/chatwidget/permissions_menu.rs)（`("auto", AutoReview) => APPROVE_FOR_ME_LABEL`）、[`ApprovalsReviewer`](https://github.com/openai/codex/blob/7625bd56657da7ce6d96b6d27e983e568757cdbc/codex-rs/protocol/src/config_types.rs)、[`builtin_approval_presets`](https://github.com/openai/codex/blob/7625bd56657da7ce6d96b6d27e983e568757cdbc/codex-rs/utils/approval-presets/src/lib.rs)。

Pi 把两轴压成一个模式开关：

| Pi 模式 | 对应 Codex |
|---|---|
| `auto`（状态栏 Approve for me） | OnRequest + workspace-write + `auto_review` |
| `yolo`（Full bypass） | Never + danger-full-access（跳过 evaluator / Guardian / sandbox） |
| **没有** | Default 人审 popup、Read Only 模式、Granular 细开关 |

Guardian 是否接管审批：Codex 是 `OnRequest|Granular && AutoReview`（[`routes_approval_policy_to_guardian`](https://github.com/openai/codex/blob/7625bd56657da7ce6d96b6d27e983e568757cdbc/codex-rs/core/src/guardian/review.rs)）。Pi 是 `privilegeMax !== yolo` 且 risk 不是 allow/block。

---

## 2. 端到端链路

### Codex（Approve for me）

工具执行走 **orchestrator**，审批发生在 **第一次 sandbox 尝试之前**，失败后可能再审一次：

1. Hook `permission_request` 可直接 Allow/Deny（先于 Guardian/用户）。
2. `exec_policy` 把命令判成 `Allow` / `Prompt` / `Forbidden`。
   - OnRequest + Restricted（workspace-write）+ 非危险 + 未请求 sandbox override → **Allow**，沙箱自己挡越权（[`render_decision_for_unmatched_command`](https://github.com/openai/codex/blob/7625bd56657da7ce6d96b6d27e983e568757cdbc/codex-rs/core/src/exec_policy.rs)）。
   - 危险命令、`sandbox_permissions` 升级、规则 Prompt → **NeedsApproval**。
3. `NeedsApproval`（或 turn 级 `strict_auto_review` 即使 Skip）→ `Session::request_approval` → Guardian。
4. Guardian 90s / 最多 3 次，只重试 overload / 连接失败 / parse；timeout 与失败 **fail-closed**，不回落人审。
5. 通过后 **第一次在沙箱里跑**。OnRequest **默认不**在沙箱拒绝后 unsandbox 重试（`wants_no_sandbox_approval(OnRequest) = false`）；网络拦截是例外，会再走一次审批。
6. `request_permissions` 在 AutoReview 下 **直接 Guardian**，不是用户弹窗。Guardian `Approved` → turn grant，`ApprovedForSession` → session grant。Deny/timeout → 空权限。

证据：[`orchestrator.rs` `run()`](https://github.com/openai/codex/blob/7625bd56657da7ce6d96b6d27e983e568757cdbc/codex-rs/core/src/tools/orchestrator.rs)、[`approvals.rs` `request_approval`](https://github.com/openai/codex/blob/7625bd56657da7ce6d96b6d27e983e568757cdbc/codex-rs/core/src/tools/approvals.rs)、[`session/mod.rs` `request_permissions_for_environment`](https://github.com/openai/codex/blob/7625bd56657da7ce6d96b6d27e983e568757cdbc/codex-rs/core/src/session/mod.rs)。

### Pi（auto）

审批发生在 **host `tool_call` 钩子**，执行是另一段：

**Phase A — `pi.on("tool_call")`**（谁可以跑）

1. `yolo` → return（不评）。
2. `request_permissions` → return（**故意跳过 Guardian**；批准在 execute 里 `ctx.ui.confirm`）。
3. `evaluateRiskRequest`（确定性：Git metadata、private host、protected path、规则）→ `allow` / `prompt` / `block`。
4. `allow` → 放行，不 mint grant。
5. `block` → 挡，不进 Guardian。
6. `prompt` → Guardian（paused 熔断则直接挡）。
7. Guardian approve → `GrantLedger.mint(authority: "auto-review")`（一次性，绑 toolCallId + fingerprint）。

**Phase B — `makeGuardedExecute`**（围栏什么）

1. abort 已触发 → 拒。
2. yolo → 原生 execute。
3. `authorize` 消耗 grant（fingerprint 不对则失败闭合）。
4. `runInLease`：nono profile +（可选）filtering-proxy；sticky world 的 hosts/write roots 与 grant 取并。

证据：`src/register.ts`（tool_call / request_permissions / grantApprovedCall）、`src/enforced-tool.ts`、`src/risk-policy.ts`、`src/sandbox/nono-enforcer.ts`。

---

## 3. 差异表（按处理优先级）

### 行为会分叉的

| # | 主题 | Codex Approve for me | Pi auto | 含义 |
|---|---|---|---|---|
| 1 | **`request_permissions` 谁批** | AutoReview：**Guardian**。User reviewer 才 elicitation 给人。Guardian 可给 turn 或 session。 | **永远 `ctx.ui.confirm`**，tool_call 里跳过 Guardian | P0 按「Codex 是用户确认」实现；那只对 Default 成立。当前 Codex AutoReview 已经把这个工具交给 Guardian。 |
| 2 | **谁先拦、拦什么** | `exec_policy` 规则 + unmatched fallback（危险→Prompt，普通 workspace 命令→Allow） | `classifyRisk` LOW/REVIEW/HARD + Git/private/protected **HARD block** | Pi 多一层确定性 HARD（private IP、畸形 git、protected `config.json`），这些 **不会** 送到 Guardian。Codex 同类 private 走代理 `NotAllowedLocal`，同样不审。 |
| 3 | **Guardian 子会话能力** | 整颗 Codex child：`AskForApproval::Never` + parent∩read_only profile，**标准 tool runtime**（含 shell 只读），清空 MCP/Apps/Hooks/WebSearch | 只暴露 `read`/`grep`/`find`/`ls`，nono 只读 profile，无 shell | Codex Guardian 能 `cat`/`rg` 查证据；Pi 不能跑任意只读命令。这是刻意偏离（`guardian-policy.ts` Execution Environment）。 |
| 4 | **沙箱失败后的升级** | `sandbox_permissions=require_escalated` 可 **bypass sandbox 首跳**；OnRequest 沙箱拒绝后默认 **不** unsandbox 重试（网络拦截除外） | 没有 unsandbox 重试。`with_additional_permissions` 只是给 **同一 nono profile** 加 write roots。唯一旁路：已批准的裸 `git init` | 同一句「升级」两边不是一个动作。 |
| 5 | **网络审批形态** | 独立 `ApprovalAction::NetworkAccess`；managed proxy；allow 可写成 `NetworkPolicyAmendment` | risk 抽出 hosts → grant.networkHosts → profile `allow_domain`（host 已设 HTTPS_PROXY 时再套 filtering-proxy） | Codex 审的是一次 CONNECT；Pi 审的是命令里的 host 列表。nono 默认外网开着（未写 `network.block`），和 Codex fail-closed 代理不是同一语义。 |
| 6 | **审批缓存 / 前缀记忆** | `with_cached_approval`；execpolicy 可提议 prefix amendment；session Remember | GrantLedger **一次性**。`commandPrefixes` 在 `risk-policy.ts` 仍能消费，但 sticky world 已不再写入 | Codex 可以「同类命令以后别问」；Pi auto 每次 prompt 都过 Guardian。 |
| 7 | **`strict_auto_review`** | turn grant 可把 **本来 Skip 的命令** 也送 Guardian（测例：`echo hi`） | 无此开关 | 用户一旦要「本回合所有命令都审」，Pi 做不到。 |
| 8 | **Guardian 之前的 hooks** | permission_request hooks 可短路 | 无 | — |
| 9 | **Guardian V2** | 普通评审可走 async scorer；`request_permissions` 与 retry **必须同步 Guardian** | 无 | — |
| 10 | **人审模式** | Approve for me 旁边仍有 Ask for approval | 人审 popup 已退休；`GrantAuthority "user"` 生产路径空着 | Codex 用户能从 Guardian 切回自己批；Pi 只能 yolo 或停。 |

### 已经对齐的

| 主题 | 双方 |
|---|---|
| 产品意图 | 「该问的时候让子 agent 代批，失败闭合，不弹给人」 |
| 超时 | 90s |
| 重试次数 | 最多 3 |
| 重试资格 | 大体同一集合：overload / HTTP 连接失败 / stream 断开 / 5xx / parse。timeout、cancel、auth **不重试** |
| 失败闭合 | timeout/parse/provider 失败都不打开人审 fallback |
| 连续拒绝熔断 | 连续 3 次 deny 打断 turn（Codex 另有 50 窗内 10 次；cyber 模型 1 次。Pi 未做 cyber 特例） |
| 拒绝后精确重批 | developer 首行同一句：`The user has manually approved a specific action that was previously \`Rejected\`.`；仍要 Guardian 再评 exact fingerprint |
| Guardian 政策模板 | Pi `guardian-policy.ts` 改编自 Codex `039eb58a` 的 policy_template；可信内容 / post-denial / payload 回溯已按 08-26 笔记对齐 |
| workspace 普通命令 | 两边都可以不审：Codex Allow+sandbox；Pi LOW+sandbox |
| sticky 权限形状 | `PermissionGrantScope` turn \| session；hosts + write roots |
| Guardian 自身不升级 | Codex child `Never`；Pi Guardian 无嵌套审批 |

---

## 4. 一条命令怎么走（具体例子）

假设 Approve for me + workspace-write，cwd 在项目内。

| 动作 | Codex | Pi |
|---|---|---|
| `echo hi` | exec_policy Allow → Skip Guardian → 沙箱执行 | risk LOW → 不审 → nono 执行 |
| `curl https://example.com` | 危险/网络 → Prompt → Guardian → 可能再走 NetworkAccess | 抽出 host，public → prompt → Guardian；private → **直接 HARD block** |
| `git push` 到 github.com | 可进 Guardian（NetworkAccess 或 Shell） | Git metadata 检查通过则 prompt；失败 HARD |
| `rm -rf /` | Prompt/Forbidden（危险启发式） | 危险段 HARD 标签但 `wouldPrompt` → **仍送 Guardian**（不是 block），除非命中别的 HARD 路径 |
| workspace `write` 文件 | apply_patch / 文件工具；workspace 内常 Skip | `writeRisk` 在 cwd 内 LOW，不审 |
| cwd 外 write | 要 additional permissions 或 patch approval → Guardian | REVIEW → Guardian；grant 带 writeRoots |
| `request_permissions` 要 `api.foo.com` | **Guardian** 批 turn/session | **用户 confirm**；规范化拒绝 private/protected |
| Guardian 超时 | `ReviewDecision::TimedOut`，工具拒绝，文案建议用户批或换做法 | 同：fail-closed + timeout 专文案 |
| 连续 3 次 Guardian deny | 打断 turn | `autoState.paused` + `ctx.abort()` |

---

## 5. 对先前结论的更正

1. **「Codex 的 request_permissions 是用户确认」只对 `ApprovalsReviewer::User` 成立。** 当前 AutoReview 在 `request_permissions_for_environment` 里 `routes_approval_policy_to_guardian` 为真时调用 `request_guardian_approval`。Pi P0 的 skip-Guardian 是 Default 路径，不是 Approve for me 路径。
2. **Guardian 工具面不是「也是 read/grep/find/ls」。** Codex child 是只读 **profile** 下的完整 runtime；Pi 是工具白名单。08-01 的 restrictions 笔记已经写过，现网代码没改这个分层。
3. **nono CLI 替换 srt 不改变 Approve for me 的「谁批准」**，只改变 Phase B 执法。网络默认开/关仍是两边最大的执行语义差。

---

## 6. 若要再对齐，值得做的（未实施）

按影响，不是建议立刻开工：

1. Auto 模式下 `request_permissions` 改走 Guardian（保留 normalize 拒绝 private/protected；Guardian deny = 空权限，不要再弹人）。
2. 明确 Pi HARD 是否应继续绕过 Guardian（private IP / 畸形 git：建议保持 HARD；危险命令目前送审，与 Codex Prompt 一致）。
3. Phase B：nono 默认 `network.block`，与 Codex 受限网络同向。
4. 不值得做：Guardian V2、hooks、execpolicy prefix 记忆、人审模式回归——除非产品要「Ask for approval」回来。

---

## 源码

- Codex：上表 SHA 下 `codex-rs/core/src/{guardian,tools/approvals.rs,tools/orchestrator.rs,tools/sandboxing.rs,exec_policy.rs,session/mod.rs,tools/handlers/request_permissions.rs}`，`codex-rs/tui/src/chatwidget/permissions_menu.rs`，`codex-rs/protocol/src/{config_types.rs,permissions.rs}`
- Pi：`src/register.ts`、`src/enforced-tool.ts`、`src/risk-policy.ts`、`src/permissions/risk.ts`、`src/auto-reviewer.ts`、`src/guardian-policy.ts`、`src/guardian-tools.ts`、`src/grant-ledger.ts`、`src/sticky-permission-world.ts`
