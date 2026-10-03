# pi-safety ↔ codex-rs 静态风险层行为差异清单（C1/B1/D1 对齐）

> 任务 A（把 pi-safety 静态风险分析层与 openai/codex 的 codex-rs 对齐——不更严也不更松）的 **C1/B1/D1 三条关键差异**部分，由目标 `murgifgg-u2he0e` 实现并核实。
>
> 基线：codex = `/tmp/codex-probe` HEAD `4dd51f4`（depth-1 浅克隆；钉住的 `129fd21` 已不可用，codex 已重构）；pi = 当前工作树。
> 每条标注「已对齐（等价）」并给出双侧 `file:line` 证据。

## 已对齐的三条

### C1 — 危险命令处置：已对齐（等价）

- **pi**：`extensions/pi-safety/src/permissions/risk.ts:303-311`——Tier 1 `if (segments.some((segment) => isDangerousSegment(segment)))` 返回 `{ disposition: "NeedsApproval", ...(substituted ? { dangerousSubstitution: substituted.source } : {}) }`（`disposition: "NeedsApproval"` 在 :308）。此前为无条件 `Forbidden`。
- **codex**：`codex-rs/core/src/exec_policy.rs:799-808`——`if dangerous_command_match.is_some() || windows_managed_fs_restrictions_without_sandbox_backend { return match approval_policy { AskForApproval::Never => Decision::Forbidden, AskForApproval::OnRequest | AskForApproval::UnlessTrusted | AskForApproval::Granular(_) => Decision::Prompt }; }`。
- **codex 测试**：`codex-rs/core/src/exec_policy_tests.rs:2121-2160`（`forced_rm_requires_approval_or_specific_rejection_on_all_platforms`）：`rm -rf /important/data` 在 `AskForApproval::OnRequest` 下 → `NeedsApproval`（:2124-2148），在 `AskForApproval::Never` 下 → `Forbidden`（:2150-2160）。
- **等价性说明**：pi 静态层无 `AskForApproval::Never` 模式——yolo 模式整体绕过静态层（`approve-for-me-engine.ts:1964`：`if (state.snapshot.mode === "yolo") return executeUnrestricted(state, request);`），故 pi 的 `NeedsApproval` 对应 codex 的 `OnRequest/UnlessTrusted/Granular → Prompt`；`Never → Forbidden` 分支在 pi 静态层不可达（yolo 不产生 `Forbidden`，而是绕过判定）。

### B1 — 解析失败 / 不完整输入：已对齐（等价）

- **pi**：`extensions/pi-safety/src/permissions/risk.ts:340-375`——Tier 4a：非 brace group 且存在 `lex_incomplete` 段时，回退原始命令向量 `return isDangerousWords(shellWords(command).words) ? { disposition: "NeedsApproval" } : { disposition: "Skip" }`（:365-367）。
- **codex**：`codex-rs/core/src/exec_policy.rs:876-904`（`commands_for_exec_policy_for_platform`）：`parse_shell_lc_plain_commands` 非空则用之（:880-887），否则回退 `ExecPolicyCommands { commands: vec![command.to_vec()], command_origin: Generic }`（:900-903）；外层包装 :872-874。
- **codex 测试**：`codex-rs/core/src/exec_policy_tests.rs:683-695`（`commands_for_exec_policy_falls_back_for_empty_shell_script`，`bash -lc ""`）与 :696-702（空白）——均返回整个原始命令向量为 Generic。
- **匹配器等价性**：pi `isDangerousWords`（`dangerous-commands.ts:47-65`）按首词匹配 `rm`(+force)/`sudo`/`env`；codex `dangerous_command_match_for_exec`（`shell-command/src/command_safety/is_dangerous_command.rs:123-147`，经 `dangerous_command_match_for_platform` :42 / `dangerous_command_match_with_depth` :49）按首词匹配 `rm`(+force)/`sudo`/`env`/`trap` 并递归 shell-literal。对到达 tier 4a 的命令（lex-incomplete / 无 plain command，且排除 substitution/heredoc/wrapper/group），`trap` 与 shell-literal 分支不出现（trap 命令本身是 plain command；危险的 shell-literal 含 plain command；substitution 被 tier 4a 排除并在 tier 4b fail-closed），故两集合在此重合——不更严不更松。

### D1 — 网络判定：已对齐（等价）

- **pi**：`extensions/pi-safety/src/permissions/risk.ts`——移除两条网络子句（`!networkApproved && request.networkTargets?.length` 与 `!networkApproved && invocationUsesNetwork(segment)`），并从 `classifyRisk`/`classifyRiskWithCause` 移除 `networkApproved` 参数；`extensions/pi-safety/src/risk-policy.ts:377-390`（`createFilesystemPolicy` :377 / `classifyRiskWithCause` 调用 :390）——移除 `sandboxedBashNetwork` 计算与私有/特殊地址静态拦截块，分类器现为网络无关。
- **codex**：`codex-rs/core/src/exec_policy.rs` 无命令级静态网络阻断——其 6 处 network 引用均为 execpolicy 规则管理（:15/:21 导入 `NetworkRuleProtocol`/`blocking_append_network_rule`，:514 `append_network_rule_and_update`，:518/:538/:555 `add_network_rule`）；C1 判定逻辑（:799-808）只查 `dangerous_command_match`。网络出口在运行时把关：`codex-rs/core/src/tools/network_approval.rs:57`（`NetworkApprovalSpec { network: Option<NetworkProxy>, ... }`，用 `codex_network_proxy::{NetworkProxy, NetworkPolicyDecider, NetworkDecision}`）。
- **等价性说明**：pi 运行时对应物——逐端点网络边界（`network-boundary.ts:170/:278/:292`）未改动且仍强制出口，故移除静态网络块并未放宽 pi（运行时兜底完好）。

## 验证

- `tsc --noEmit`：0 错误。
- pi-safety 全量（独立复核运行）：1819 passed | 1 skipped | 0 failed（共 1820）。执行侧一次运行出现的 2 个 connect-guard IPv6 超时（`connect-guard.test.ts:79-81`/`:107-110`）未复现——抖动/环境性，范围外，该测试文件未改动。
- 残留：`networkApproved`/`sandboxedBashNetwork` 已从分类路径移除；无无条件 `Forbidden`、`lex_incomplete` 阻断或静态网络 `Forbidden` 残留。

## 附：F1 修正（B1 收窄）

初版 B1 用 `some` 判定触发条件，在多段命令且各段 unproven 原因混杂时（一段 `lex_incomplete` + 另一段更强的 `command_word_unproven`）会把整段落入首词 fallback，非危险首词即 Skip——fail-open（`cmd=rm; $cmd -rf /tmp/x`）。已改为 `every`：

- **pi**：`extensions/pi-safety/src/permissions/risk.ts:369-375`——`if (!segments.some((segment) => segment.grouped) && segments.every((segment) => segment.unprovenCause === "lex_incomplete"))`。只有所有段都是 `lex_incomplete`（整段毫无 token 级展开，等同 codex 的整向量回退）才走 Tier 4a 首词 fallback；任一段带更强 unproven 原因（`command_word_unproven`/`substitution_unproven`/`heredoc_unproven`/`wrapper_unreduced`/`nested_git_program`/`program_reinterpreted`/`grouped`）一律落 Tier 4b fail-closed（NeedsApproval）。
- **codex**：`codex-rs/core/src/exec_policy.rs:900-902`——回退是**整条原始命令向量**（`ExecPolicyCommands { commands: vec![command.to_vec()], command_origin: Generic }`）交给 `dangerous_command_match_for_platform` 判定，不区分段混杂；危险词在 `exec_policy.rs:799-807` 的 `AskForApproval::OnRequest` 下 → `Prompt`、非危险 → `Allow`、仅 `Never` 才 `Forbidden`。
- **测试同步**：`extensions/pi-safety/tests/risk-policy.test.ts:473-514`——`cmd=rm; $cmd -rf /tmp/x` 从 Skip 期望改回 `NeedsApproval`（移出 auto-run 表，并入上方的 unclassifiable 表）；`cat <<`/`FOO=1`/`>out` 仍 Skip。全作业树仅 `shapes[24]`（`cat <<`）为全段 `lex_incomplete`，故 substitution shapes 数组其余条目不受影响。

## F2 留档

**结论：非沙箱路径（yolo/unrestricted 与 escalated）确无私网执法点；此缺口与 codex 同源，是 D1 有意对齐的结果，不更严也不更松。留档备查，本次不修。**

- **pi 静态层已无力**：D1 之后 `risk.ts` 与 `risk-policy.ts` 均为网络无关，静态层不再对私有/特殊地址做硬阻（见上 D1 节）。
- **pi 运行时执法点仅存在于沙箱 bash**：`NetworkBoundary` 在全仓库只在 `extensions/pi-safety/src/register.ts` 三处出现——声明 `:178`、构造 `:219`（`options.networkBoundary ?? new NetworkBoundary()`）、以及唯一调用 `resolveEndpoint` 于 `extensions/pi-safety/src/register.ts:1407`。该调用位于 `createSandboxNetworkAuthorizer`（`register.ts:1364`）内部，而该 authorizer 只被 `createSandboxedBashOperations` 包入沙箱 bash（`register.ts:1715` 起的 `networkAuthorize: createSandboxNetworkAuthorizer(policy, ...)`）。
- **非沙箱路径走裸后端，不经过网络仲裁：`register.ts:1654-1662`——“Unrestricted and escalated leases share the bare local backend”，`if (mode === "unrestricted")` 分支直接 `localBash().execute(...)`；`mode === "escalated"` 分支（`register.ts:1673` 起）在健康检查后同样走本地后端（不接 `createSandboxedBashOperations`，因此不带 `networkAuthorize`）。故 unrestricted 与 escalated 两条路径都完全绕过 `NetworkBoundary`。
- **codex 同源语义**：`codex-rs/core/src/tools/sandboxing.rs:319-322`——`pub(crate) fn managed_network_for_sandbox_permissions(network: Option<&NetworkProxy>, sandbox_permissions: SandboxPermissions) -> Option<&NetworkProxy> { if sandbox_permissions.requires_escalated_permissions() { None } else { network } }`：升级（escalated）即返回 `None`，即**摘掉受管网络代理**。唯一调用方 `codex-rs/core/src/tools/runtimes/unified_exec.rs:288` 把它交给 `attempt.network_proxy(...)`，因此 codex 在 escalated 下同样没有网络代理执法。
- **等价性判定**：pi 的 escalated/unrestricted 无私网执法 == codex 的 escalated 无 `NetworkProxy`。故 D1 移除静态私网硬阻既未比 codex 更严（不再额外硬阻 codex 会放行的命令），也未比 codex 更松（运行时逐端点边界在沙箱路径仍完好）。缺口同源，不在“不更严也不更松”的对齐目标内修理。
- **若将来要收紧**：应当在下一次对齐中连同 codex 一起改（先给 codex 的 escalated 路径加回网络代理，再谈 pi），否则会变成比 codex 更严。

## 与 codex 4dd51f4 的差异（已复核）

> 复核：reviewer subagent 对 11 条重点做双侧真源核实；下表为可落盘的结论，行号已按当前 HEAD 修正。

| 主题 | 结论 | pi 证据 | codex 证据 |
|---|---|---|---|
| 危险命令默认处置 | 机制性差异：pi 单层 NeedsApproval；codex 按 AskForApproval 三档（Never→Forbidden，其余→Prompt） | `risk.ts:303-311`, `dangerous-commands.ts:57-59` | `exec_policy.rs:799-807` |
| 大小写折叠 | pi 更严：pi `basename().toLowerCase()`，codex POSIX 不折叠（仅 Windows 折叠） | `shell-segment.ts:817` | `is_dangerous_command.rs:96-106` |
| 解析失败回退 | 等价（Allow≡Skip）：codex 整向量回退，非危险命令在 OnRequest 下 Allow；pi 全段 `lex_incomplete` 回退，非危险词 Skip | `risk.ts:368-375` | `exec_policy.rs:876-904`, `:818-836` |
| substitution `$(...)` | pi 更严：pi 任意 `$`/反引号置 `hasExecutableSubstitution` 进 tier4b；codex 仅在 shell-literal 递归中触及 | `shell-lexer.ts:659-674` | `is_dangerous_command.rs:65-72`, `:278` |
| wrapper | pi 更严·机制性差异：codex 仅 rm/sudo/env/trap 四臂；pi 额外 timeout/nice/stdbuf/unbuffer/nohup/setsid/exec/time/command/builtin，展开失败→wrapper_unreduced | `shell-segment.ts:330-537` | `is_dangerous_command.rs:123-147` |
| git nested program | 暂不落盘：codex 全仓 grep 0 命中只能证明「当前 HEAD 无 git 臂」，无法证明 `fc073c9` 已删除（仅对旧 pin 成立） | `git-exec-entries.ts:216` | grep 0 命中 |
| 网络静态层无关 | 等价（D1 对齐）：两侧静态层均网络无关，网络由执行层 NetworkBoundary/代理逐端点强制 | `risk.ts:300-302`, `risk-policy.ts:377-390` | `exec_policy.rs` 无命令级网络阻断 |
| 升级摘网络代理 | 等价（同源）：codex `requires_escalated_permissions()→None`，pi escalated/unrestricted 裸后端 | `risk-policy.ts:263-264`, `register.ts:1654-1690` | `sandboxing.rs:315-324`, `unified_exec.rs:288` |
| 写保护 | pi 更严：pi protectedWritePaths 硬 Forbidden（不可批准）；codex `assess_patch_safety` 产出 AutoApprove/AskUser/Reject，Reject 仅 Never 或沙箱不可用 | `risk.ts:190-195`, `risk-policy.ts:433-453` | `safety.rs:67-125` |
| yolo vs Never | 机制性差异：pi yolo 是整层绕过（跳过静态危险命令层 + 关沙箱）；codex Never 是静态层内一条分支（危险命令仍 Forbidden、保留沙箱） | `approve-for-me-engine.ts:919,1964`, `state.ts:5` | `exec_policy.rs:799-813`, `sandboxing.rs:333-338`, `network_approval.rs:191-193` |
| 网络授权机制 | 机制性差异（位置等价）：pi 每连接回调 JS authorizer；codex 声明式 NetworkProxy 对象由 `enforce_managed_network` 开关 | `sandbox.ts:168-171` | `sandboxing.rs:411`, `:478-486` |

补充（已核实、随行确认）：
- 未匹配命令默认：codex 在 OnRequest+Restricted+无 override 下 Allow（靠沙箱兜底）；pi 对应 tier-4b fail-closed NeedsApproval——pi 更严，与「解析失败回退」同源，合并为一条。
- 深度界：两侧均为 8，等价。
- `risk.ts:16-20` 头注释仍把 tier1 写成「proven dangerous -> Forbidden」，与实际 `:303`（NeedsApproval）矛盾，为过期描述；以 `:303` 为准。

## 范围说明

本文件覆盖 C1/B1/D1（目标 `murgifgg-u2he0e`）、B1 的 F1 修正，以及 F2 留档。上一 session 的完整审计（24 条差异）基于旧 codex @ `129fd21` + 旧 pi @ `67879f3`——codex 已重构（`129fd21` 不可用；`exec_safety_policy.rs`/`dangerous_command.rs`/`network_approval_policy.rs`/`network_safety.rs` 在当前 HEAD 已不存在于原路径）。其余差异需对当前 HEAD `4dd51f4` 重新核实后才能采信或对齐——不在本次改动范围内。
