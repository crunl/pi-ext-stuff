# Codex 静态风险深核（pin `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`）

- 日期 2026-09-24；范围：`src/permissions/risk.ts`、`dangerous-commands.ts`、`rules.ts`、`src/risk-policy.ts`。只读源文件，仅写本笔记。
- Codex 结论全部来自该 pin 的 GitHub raw 全文（一手源）；行号为 pin 下实号。无来源标“未验证推断”。
- 纠正：`shell-command/src/command_safety.rs` 在 pin 下不存在（404），入口是 `command_safety/mod.rs`；policy crate 名 `execpolicy`。

## 1. Codex 原文（pin）

**`shell-command/src/command_safety/is_dangerous_command.rs`**（324 行，全读）：深度界 8，超界→`Other`（L34/L54，测试 L254–259）；`with_depth` 三段：exec 直判→`parse_shell_lc_literal_commands` 递归（L66–72，depth+1）→仅 Windows 跑 windows 规则（L74–75）。exec 仅四臂（L123–146）：`rm`+force（L133）、`sudo` 直递无 flag 跳过（L138）、`env`（L143）、`trap`（L146）；**无 git/rmdir/eval/find/xargs/解释器臂**。`rm_args…`（L196–208）：`take_while(!="--")`，`--force` 或单`-`含`f`；`rm -- -f` 不命中（测试 L280）。`env`（L153–175）只跳 `-i/--ignore-environment/NAME=`，`-u/-C` 中断（故 `env -u X rm -rf` 在 Codex 下 miss）。`trap`（L177–194）取首个非`-`操作数包 `sh -c` 递归。基名归一（L96–121）：POSIX 取 `/` 尾段不转小写；Windows 去盘符+小写+去 `.exe/.cmd/.bat/.com`。

**`shell-command/src/bash.rs`**：word-only allowlist（L29，`has_error` 直接拒 L30）；`parse_shell_lc_plain_commands`（L124）只认 `[bash|zsh|sh, -c|-lc, script]`（`bash -i -c` 不展开）；literal 版注释（L129–135）“suitable for identifying dangerous literal commands, **but must not be used to prove that a command is safe**”（fail-closed 原文之一）；literal 词拒绝 `{}*?[]\~^#$``/首=`（L260）。

**`core/src/exec_policy.rs`**：拆段失败→整条 argv 单命令回退（L876–904）；unmatched 启发式（L770–855）注释 L793–798 “never allow it to run **without approval**”（Prompt；仅 `Never`→Forbidden，L801–802；非危险+`Never`→Allow 靠沙盒，L810–814）；`bypass_sandbox` 要求**所有**段显式 Allow（L440–454，fail-closed 原文之二）；`Prompt` 被政策拒→`Forbidden`（L411–425）；危险理由 L1110–1119（ForcedRm→“rm -f style commands are not permitted…”）；`BANNED_PREFIX_SUGGESTIONS`（L~60–120，含 `python -c/perl -e/php -r/node -e/deno eval/env/sudo/rm/git`）——Codex 用“禁建 allow 前缀”管解释器，无 danger 名单对应物。

**阶段**：`Forbidden→直拒`，`Prompt→NeedsApproval`（L394–439，Forbidden 永不到 Guardian）；Guardian 仅 `OnRequest|Granular+AutoReview`（`guardian/review.rs:213-234`）；`unsandboxed_execution_allowed = !has_denied_read_restrictions`（`tools/sandboxing.rs:275-279`，注释 L269–274 deny-read 只存于沙盒内）；escalated 丢代理（`:297-306`）。

**Git**：`fc073c9`（sha `fc073c9c…`，2026-02-13T01:33:02Z，API 实测）删 248 行 git 臂；pin 全文无 git——“已删”成立。

**“cannot safely split ⇒ never allow”字面原文在 pin 中不存在**（`exec_policy.rs` 无 `safely` 字符串，实测零命中）。最接近：L793–798（never allow *without approval* = Prompt）与 L440–454。请改引这两处，勿沿用转述。

## 2. 对照表

| 轴 | Codex | 本地 | 结论 |
|---|---|---|---|
| `rm -f` | L196–208 | `dangerous-commands.ts:11-19` | **忠实** |
| `sudo` | L138 直递（`sudo -u x rm -rf` miss） | `risk.ts:305-331` 跳 `-u/-g/-h/-p/-C` | 本地**更严**（Codex 真漏） |
| `env` | L153–175（`env -u X rm -rf` miss） | `risk.ts:262-303` 处理 `-u/--unset/-C/-i` | 本地**更严** |
| `trap` | L177–194 经 AST literal 递归 | `risk.ts:1258-1269` 字符切分递归 | **基本忠实**（control-flow 靠保留字剥离 `:421-448` 近似） |
| 深度 8 | L34/54 超界→Other | `:8/:57` 超界→true | **忠实** |
| Windows | `windows_dangerous_commands.rs` 全文 | 无 | 缺口（非目标平台，低） |
| Git | `fc073c9` 删光 | danger 无 git | **对齐** |
| 切分 | AST 双轨（plain 证可拆 / literal 只找危险） | `splitShellSegments:129`+`shellWords:166`+`scanShellSyntax:348`+`decomposable:602-608` | 自研近似，fail-closed 意图对齐（不可分→REVIEW `:1339-1346`），证明力低一档 |
| 三态阶段 | Allow/Prompt/Forbidden；Forbidden 直拒 | allow/prompt/block；沙盒 Bash HARD 仍 prompt（`risk-policy.ts:359-366`） | 顺序**对齐**；无 Never 类似物（已知 deliberate） |
| 沙盒网豁免 | 无静态网判定，授权在沙盒/代理层（私网 `network_policy_decision.rs:63`） | `sandboxedBashNetwork`（`risk-policy.ts:329-333`）+ 非沙盒私网 block（`:334-340`） | 架构**对齐**；私网 block 是超集 |
| Guardian 输入 | dangerous 带强理由（L1110–1119） | `staticRisk+staticReason`（`auto-review-request.ts:145-146`）+ rm -rf 可降级（`guardian-policy.ts:74,182`） | tier 有、规则级 provenance 无（见 G2） |

## 3. 上一轮两问（以 Codex 为准）

- **`/[cep]/` 漏 `r`/`E`：部分属实、窄 fail-open、低。** 捆绑形正则（`risk.ts:512`）只含小写 c/e/p；`php -r` 捆绑、`perl -wE` miss；独立形全在 `inlineProgramFlags:66-75` 不受影响。多数 miss 仍 fail-closed（`scriptOperand` 为空→`reExec=true`，`:561-564`）；残余需“被漏捆绑 flag + 后跟脚本样词”，如 `perl -wE 'say 1'`（`-wE` 被当值 flag 跳过 `:479-505`，`'say 1'` 成 operand → 可能 LOW）。Codex 根本无此检查（只 `BANNED_PREFIX_SUGGESTIONS`），同样放行进沙盒；本地 LOW 仍在 SRT 内——影响限于标签错误。修法：捆绑字母表扩为 `cCeEpPr`。
- **`xargs --version`：非问题，过度保守。** `xargs` 无条件 `reExec=true`（`risk.ts:551`），余者有 `--version/--help` 豁免（`:521-523/:554-555`）；Codex 无 xargs 概念→放行。本地多一次 REVIEW，无缺口。对齐 Codex 可加同款豁免（GNU `--version` 语义为**未验证推断**，先实测再改）。

## 4. 新缺口（按严重度）

- **G1（中低）PowerShell 危险规则缺失。** `powershell` tool 走同一 POSIX 解析器（`risk.ts:671-672`），无 `Remove-Item -Force`/`del /f`/`start+URL`（Codex windows 全文 + `powershell.rs:43,77-88`）。`powershell -Command "Remove-Item C:\tmp -Force"` 本地约 LOW。缓解：POSIX 少用+沙盒内。建议：加 `remove-item|ri|del|erase|rd|rmdir + -force` 同段规则，否则标 REVIEW。
- **G2（低）`$()` 隐藏 `rm -f` 只到 REVIEW。** `bash -lc 'echo $(rm -rf /)'`：`splitShellSegments:155` 在括号处撕碎，`isDangerousSegment` 只见 `echo`，靠 substitution 进 REVIEW；Codex literal 递归直接 `ForcedRm`（pin 自带测试 L~286）。tier 差一级，但 provenance 丢了（Guardian 仅 tier+通用 reason），而 `guardian-policy.ts:74,182` 允许 rm -rf 降级。建议：对 substitution 段递归扫内层 words，或写命中来源进 `staticReason`。
- **G3（低）`rm` 基名归一弱（Windows 向）。** 本地 `basename().toLowerCase()`（`risk.ts:581`）不去盘符/后缀；Codex L96–121 去。`rm.exe -f` Windows 漏检。非目标平台。
- **G4（记录，正向偏离）**：`command/builtin/nohup/time` 剥离（`risk.ts:234-257`，Codex `command rm -rf` 两条路径都 miss）、大小写归一（Codex POSIX 敏感）、`bash -*c*` 任意展开（`:584-587,611-631`；Codex 仅 `-c|-lc`）。本地更严，无需改。
- **G5（极低）trap 递归无深度计数**（`risk.ts:1260-1266`；Codex 每次 descent +1 受 8 界）。受输入长度限，加深度参数即合拢。

## 5. Verdict

rm 判定/`--`/深度界/trap 形状/Git 删除：**忠实**；sudo/env/包裹类：本地**更严**（多为 Codex 实测漏检点）；Windows/PowerShell：缺口但非目标平台（G1 除外）；切分是自研近似，fail-closed 意图一致、证明力低一档。本轮无 P0/P1 fail-open，最高 G1（中低）。
