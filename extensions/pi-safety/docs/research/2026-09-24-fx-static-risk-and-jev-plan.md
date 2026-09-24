# 静态风险分析：fx 对照研究与 Jev/Transport 计划

- 日期：2026-09-24
- fx 快照：`vercel-labs/fx` @ `759001b3c0bf715d149702f63f45db3498afa406`（2026-09-19）
  本地 clone：`~/.graphify/repos/vercel-labs/fx`
- Codex standing pin：`129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
- Pi 工作树：pi-ext-stuff `main` @ `aa6e2db`（含 `4b7e8a7` 捆绑 flag + trap 深度界修复）
- 本文只做研究与计划，**不修改产品代码**。

---

## 1. 结论先行

1. **pi-safety 的静态层在"危险识别"上强于 fx，在"可证明只读"上弱于 fx。** 这是两个不同轴，混为一谈会得出错误结论。
2. **最值得补的不是危险黑名单，而是 fx 的 `plan` 语义：一张严格只读白名单。** 我们的 `LOW` 只证明"argv 可静态分解"，不证明"命令只读"。
3. **已实测的 fail-open：`timeout`/`nice`/`su` 包住 `rm -rf` 在 pi 判 LOW。** fx 明确识别这些包装器，且最终一律进审批。这是本次研究确认的最高优先级缺口。
4. **Jev/Transport 计划不进入本轮实施。** 计划本身有 3 个硬伤（见 §5），且在静态层完善之前，reviewer 层优化收益有限。

---

## 2. fx 静态层结构

```text
raw shell text
   │
   ├── command_lex.zig（708 行，21 test）
   │     pipe_segments / tokenize_argv / unsafe_compound_indicator
   │     逐字节状态扫描：引号、转义、尾反斜杠、未闭引号、NUL、非法 UTF-8 → LexError
   │
   ├── command_effect.zig（1748 行，19 test）
   │     plan() → Admission{ .direct_read_only | .approval_required(ApprovalReason) }
   │     knownReversibleAutoCommand() → bool（auto 模式开发命令白名单）
   │
   └── command_classification.zig（437 行，27 test）
         command_requires_literal_pattern / base_command_token / analysis_command_tail
         三类包装器：shell / delegating / privilege
```

**关键：`Admission` 是二态，没有 risk 三值。**（`command_effect.zig:291-302`）

```zig
pub const Admission = union(enum) {
    direct_read_only: DirectReadOnlyPlan,
    approval_required: ApprovalReason,
};
```

`ApprovalReason` 共 12 项（`:248-261`）：`filesystem_write`、`network_access`、`process_or_system`、`background_process`、`dynamic_shell`、`unsupported_shell`、`unsupported_platform`、`unsupported_input_redirect`、`unsupported_argument`、`command_owned_input`、`unknown_command`、`planning_failure`。

**语义差别（这是本研究最核心的一点）**：

- fx 问的是：「我能**证明**这个命令只读且可逆吗？」不能证明就 `approval_required`。
- 我们问的是：「这个命令**危险**吗？不可分吗？」都不危险且可分就 `LOW`。

于是 `touch x`、`mkdir x`、`npm install` 在 fx 全部需要审批；`ls $DIR`（argv 可分）在我们是 LOW。

---

## 3. 三类包装器（fx 明确识别，我们部分遗漏）

`command_classification.zig:23-52`：

| 类别 | fx 列表 | pi-safety |
|---|---|---|
| shell | `sh bash zsh dash ksh csh tcsh fish cmd powershell pwsh` | `bash sh zsh fish dash` |
| delegating | `env xargs nice stdbuf unbuffer nohup timeout time` | `env command builtin nohup time` |
| privilege | `sudo doas su` | `sudo` |

`analysis_command_tail`（`:95-144`）只透明剥离已知 env assignment、`env SAFE=…`、`nice`、`stdbuf`、`unbuffer`/`nohup`/`time`、合法 duration 的 `timeout`；`xargs`、shell、`sudo`/`doas`/`su` 保持锚定（不剥离，交由后续审批）。

### 3.1 实测确认的 fail-open

用 jiti 调 `classifyRisk`（非沙盒路径，`/tmp`）：

| 命令 | pi 现状 | fx 结论 |
|---|---|---|
| `timeout 1 rm -rf /tmp/x` | **LOW** | `approval_required(unknown_command)` |
| `nice rm -rf /tmp/x` | **LOW** | `approval_required(unknown_command)` |
| `su root -c 'rm -rf /tmp/x'` | **LOW** | `approval_required(unknown_command)` |

根因：pi 的 `executableContext`（`risk.ts:223-339`）只剥离 `command/builtin/nohup/time/env/sudo`，`timeout`/`nice`/`su` 成了 executable 本体，`isDangerousWords`（`dangerous-commands.ts:50-63`）只看到 `timeout`，判不危险；`decomposable`（`risk.ts:602-608`）也判 true。

**注意：Codex 同样漏这三种**（`is_dangerous_command.rs:123-146` 只有 `rm/sudo/env/trap` 四臂）。所以这是 pi 相对 Codex 的**同向缺口**，而 fx 相对二者更严。

---

## 4. 逐能力对照

| 维度 | fx | pi-safety | 结论 |
|---|---|---|---|
| 词法切分 | 逐字节状态机；引号/转义/未闭引号/NUL/非法 UTF-8 → `LexError`；`unsafe_compound_indicator` 标记 `$(...)`/反引号/括号/分组/短路/后台（`command_lex.zig:43-138`） | 字符切分 `[;&\|()\n]`（`risk.ts:129-163`）；`scanShellSyntax:348-410` 标记替换/重定向/控制流/heredoc；**不报未闭合引号** | pi 缺"词法错误即不可证明"的显式通道 |
| heredoc | 不解析正文，`<<`/`<<<`/`<&` 归 `unsupported`（`:260-293`），direct planner 拒绝（`command_effect.zig:395-413`） | `hasHereDocument` → REVIEW | 语义等价，fx 更细（区分 `<&`） |
| 字符串再执行 | **不解析**。`sh/bash/env/xargs` 归审批，其余解释器归 `unknown_command`（`command_effect.zig:464-482,894-905`） | **能解析**：`eval/source/trap/xargs/find-exec`、shell `-c` 递归展开、Python/Node inline/stdin（`risk.ts:31-111,479-566,612-632`） | **pi 强于 fx**。这是我们已提交 `4b7e8a7` 的资产 |
| 只读白名单 | 两级：`plan` 严格矩阵（≤8 段 pipeline、固定绝对 executable、operand/行数上限）+ `knownReversibleAutoCommand`（`npm test/run`、`zig build`、`git fetch` 等，仅 `&&` 连接）（`command_effect.zig:15-183,304-482`） | **无** | **最大缺口** |
| 危险命令 | `command_policy.zig` 识别 `rm/rmdir/unlink/shred`、git `reset/clean/rm`，但**仅 UI 标签，不参与准入**（唯一调用点 `tool_presentation.zig:773-790`） | `isDangerousWords` 只认 `rm -f`（`dangerous-commands.ts:50-63`） | 两者都不强；Codex 也只认 `rm -f` |
| 不可判定态 | 二值 + 12 种 `ApprovalReason` | 三值 `LOW/REVIEW/HARD`（`risk.ts:13,1307-1350`） | pi 能区分"危险"与"不可分"，这是优势 |
| 决策流 | `tool_admission.zig:1084-1135`：direct → EXECUTE；known-reversible + auto → EXECUTE；其余 reviewer | `risk-policy.ts:359-366` → `LOW` allow / `REVIEW` prompt / `HARD` block | fx 白名单窄但强制力强 |

### 4.1 fx 有而 pi 没有

- 严格只读矩阵：固定绝对 executable、规范化 argv、环境 profile（`basic_read_only` / `git_read_only`）（`command_effect.zig:304-482,723-864`）。
- 泛化的效果分类：`filesystem_write` / `network_access` / `process_or_system` 三类覆盖所有写文件、联网、进程命令（`:464-482,873-906`）。
- 规模上限：命令 8KB、ls operand ≤64、git pathspec ≤64、pipeline ≤8 段、输出行数 ≤10000、git log ≤1000（`:4-9`）。
- 词法错误的显式拒绝通道（`LexError`）。

### 4.2 pi 有而 fx 没有

- 字符串再执行机制识别 + shell `-c` 递归展开（`risk.ts:612-632`）。
- `LOW/REVIEW/HARD` 三值分类。
- `command`/`builtin` 包装器穿透（`risk.ts:235-257`）。
- 删除目标逐项结合 sandbox 写根检查（`risk.ts:1275-1293`、`risk-policy.ts:369-396`）。

### 4.3 双方共同盲点

均按命令文本分析，不检查项目文件。`npm install/test/run`、`zig build` 都会执行 package script，lifecycle 可隐藏写入/网络/子进程。fx 用 `known_reversible_auto_command` 白名单放行（`command_effect.zig:147-170`），pi 把它当可分解命令（`risk.ts:1130-1132,1343-1350`）——**两边都有这个洞**。

---

## 5. Jev / Transport 计划：复核结论（**本轮不实施**）

曾设计：给 `PiAutoReviewer` 加 fx 式 `Transport` 抽象，`TypeSafe Jev` 作为可选 transport（`reviewer.transport: "chat" | "typesafe-jev"`），Jev 先答、灰区回退 Chat。

复核发现 3 个硬伤：

1. **Transport outcome 类型自相矛盾。** 计划枚举 `completion|transient|permanent|timeout|cancelled`，却要求产生 `unavailable` 与 `parse`（映射到 `AutoReviewerFailure` 的 kinds），二者 codable 不进。且 `send` 只收组合 `signal`，而现有实现必须区分 caller-abort 与 deadline-timeout（`auto-reviewer.ts:383-420`），传组合 signal 会误分类。
2. **`trusted_user_context ≤1K` + 截断即 HOLD 会永久锁死 `/approve`。** 1K 是 fx 的 `rootUserRequestContext` 上限（它只放用户请求文本）；我们的复批路径把完整序列化 action 当 trusted context（`auto-review-request.ts:102-121,202-218`），action 允许 16K。
3. **`evidence_complete` 没有可靠输入源。** `guardian-transcript.ts:22-25,98-113` 对超限 raw transcript 是"丢头 + 递增 epoch"，没有"本次证据完整"标志；epoch 也无法区分"曾截断但后来稳定"。计划未改这两个文件。

其他遗漏：最终决策者未定义（Jev 中间 deny 会污染熔断，`engine.ts:1013-1023,2250-2261`）；90s 预算在 Jev/Chat 之间如何分配未定义；session cursor 语义未定义（`guardian-session.ts:239-271`）；完整 tenant policy 缺失（floor 只拦 critical 与 high+低授权，medium + concrete injection 仍可能通过，`guardian-policy.ts:107-115`）。

### 5.1 配置兼容性（结论仍然有效）

- **不需要 config version 升级。** `transport` 可选，缺失即现有 chat reviewer；旧三键 `provider/model/reasoningEffort` 原样解析（`config.ts:384-407`）。
- `reviewer` 保持判别联合**整体替换**（现有 `config.ts:606` 的 structuredClone 方向正确）。
- **冲突直接 `ConfigError`**：`transport:"typesafe-jev"` + `provider:"openai"` 不得静默吞掉——那等于把授权决定送去非预期信任域。
- `transport` 需进 `fingerprintValue`（`config.ts:719`），与 provider/model 同级；副作用是 trunk 重建 + 持久化 permission state 失效（`state.ts:83-92`），属期望行为。缺省值不应 materialize，否则旧配置升级即 fingerprint 抖动。
- 未来若升 v2，必须同时接受 1/2，不能把 `!==1` 改成只接受 2（`config.ts:380-383` 会直接拒绝所有显式 `version:1` 的既有配置）。

### 5.2 API Key 存储（结论仍然有效）

推荐 `{agentDir}/auth.json` 的 `typesafe` credential，用 host 已导出的 `readStoredCredential()` 读。

- host auth.json 按 provider ID 存 `{type:"api_key", key}`，权限 0600（`pi-coding-agent/dist/core/auth-storage.js:14-30,185-202`）。
- **不写 safety.json**：受写保护的普通配置，且整份参与 fingerprint（`AGENTS.md:84-94`、`config.ts:719-727`）。
- **不走 env**：Guardian worker 用严格 allowlist，刻意不传 env（`guardian-worker-client.ts:209-224`），reviewer 必须在主进程读。
- `ModelRegistry.getAuth("typesafe")` 对未注册 provider 返回 undefined（`pi-ai/dist/models.js:276-281`），**必须直接调 `readStoredCredential()`**。
- 失败语义：缺失/读取失败/格式错误 → `AutoReviewerFailure("unavailable")`，fail-closed，不回退旧 reviewer。
- 禁止：key 进 config/fingerprint、metrics、rationale、异常文本、URL/body、debug trace。只放 `Authorization` header。

---

## 6. 静态层改进建议（按优先级）

### P0 — 补包装器穿透（实测 fail-open）

扩充 `executableContext`（`risk.ts:223-339`），对齐 fx `command_classification.zig:37-52`：

- delegating：`nice` `stdbuf` `unbuffer` `timeout`（`env`/`nohup`/`time` 已有）
- privilege：`doas` `su`（`sudo` 已有）
- shell：`ksh` `csh` `tcsh` `cmd` `powershell` `pwsh`（现有 5 个）

注意 `timeout`/`nice` 的选项消费规则（`timeout 1 cmd` 的 `1` 是 duration，`nice -n 10 cmd` 的 `-n 10` 是值），不能像 fx 那样直接当透明剥离——fx 用 `analysis_command_tail`（`:95-144`）做"合法 duration 的 timeout"，非法的直接 fail-closed。

预期：`timeout 1 rm -rf x` / `nice rm -rf x` / `su root -c 'rm -rf x'` 从 LOW 变 HARD。

### P1 — 引入"可证明只读"判定（对齐 fx `plan`）

现在 `LOW` 的语义是"argv 可静态分解"，这不足以直接执行。应在 `classifyRisk` 之上加一层**只读白名单**，或把 `LOW` 拆为：

```text
LOW_PROVEN_READONLY   只读白名单命中 → 可直接 allow
LOW_DECOMPOSABLE      仅可分解     → 需要独立的只读判定才可 allow，否则 REVIEW
REVIEW / HARD         不变
```

白名单起步范围（对齐 fx `command_effect.zig:464-482`）：`pwd` `ls` `wc` `cat` `head` `tail` `grep` `git status|diff|log`，每项带 operand/flag 上限。

**这条会显著改变现有行为**（`cat README.md` 这类目前是 LOW，改后若不命中白名单会变 REVIEW），需要产品决策：是"白名单外一律 REVIEW"还是"白名单命中直接 allow、白名单外沿用现状"。前者安全更强，后者迁移成本低。

### P2 — 词法错误显式化

`splitShellSegments`/`shellWords`（`risk.ts:129-211`）不检测未闭合引号、尾反斜杠、NUL、非法 UTF-8。fx 用 `LexError`（`command_lex.zig:43-75,483-486`）显式失败 → `planning_failure` → 审批。

建议加 `ShellSyntax.lexComplete: boolean`，未完成即不可证明 → REVIEW。

### P3 — 效果分类（可选）

fx 的 `filesystem_write` / `network_access` / `process_or_system` 三类（`command_effect.zig:464-482,873-906`）比我们的"危险命令黑名单 + 已知网络命令列表"更系统。我们已有 `invocationUsesNetwork`（`risk.ts:1106-1143`）可复用，但写文件/进程两类目前只靠 `deletionExecutables`（`risk.ts:1272`）。

### 明确不做

- 不引入 shell AST（fx 也没有，它是逐字节状态机 + 词法标记）。
- 不扩到 Windows/PowerShell 危险规则（Codex 仅在 Windows 生效，`dangerous_powershell_words_match`）。
- 不做 Guardian 后复核或并行 shadow（延迟收益为 0，见 `2026-09-17-tool-call-turn-latency.md`）。
- 不在本轮接 Jev（§5 硬伤未解，且 §6-P0 未修时 reviewer 层优化意义有限）。

---

## 7. 实测数据（本次研究附带）

`/private/var/folders/.../T/opencode/pi-safety-latency.ts`（真实 reviewer `volcengine/doubao-seed-2-0-mini-260428`）：

| 阶段 | p50 | 说明 |
|---|---|---|
| `static_policy_evaluate` | 2.8–3.4 ms | 纯 CPU |
| `auth_getApiKeyAndHeaders` | 0.1–0.3 ms | |
| `llm_first_content`（TTFT） | 640–755 ms | 约占 review 10% |
| `llm_round_total` | 6.5–7.3 s | **占 review 99%+** |
| `review_total` | 7.3–7.9 s | |
| `tool:inspect`（一次证据轮） | 319 ms | 含 worker 冷启动 |

生产 `~/.pi/agent/guardian-metrics.jsonl`（192 条，approved shell 167 条全部 `risk_level=low`）：p50 3.4s / p90 5.3s / p99 9.2s。

含义：静态层当前耗时可忽略，**但静态结论直接决定是否进 LLM**。把本应进 Guardian 的命令误判为 LOW（§3.1 的三种包装器）= 直接绕过 3.4s 的安全检查，这是比延迟更严重的问题。

---

## 8. What this note does not claim

- 未修改任何产品代码。
- 未在 fx 上运行 e2e 或 benchmark；所有 fx 结论均来自 HEAD `759001b3` 源码阅读与行号引用。
- 未验证 `readStoredCredential()` 在本机 Pi 版本的实际导出签名（结论基于 `pi-coding-agent@0.86.0` 的 `dist/index.d.ts` 存在该导出）。
- 未评估 fx 的 `plan` 白名单迁移到 pi 后的性能影响（白名单外的命令会从 LOW 变 REVIEW，可能显著增加 Guardian 调用量）。
- 未对 Jev 做任何真实 API 调用。
- 不主张 fx 的架构整体优于 pi-safety——两者优化目标不同（fx 求"可证明只读"，pi 求"不可证危险时交 Guardian"）。
