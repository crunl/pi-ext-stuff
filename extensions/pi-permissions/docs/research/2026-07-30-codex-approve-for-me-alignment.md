# Codex「Approve for me」/ Guardian 对齐调研

## 基准与结论

- 规范上游基准：[`openai/codex` commit
  `789c72dcf62d7439863d4d2846454f05b3d51db6`](https://github.com/openai/codex/tree/789c72dcf62d7439863d4d2846454f05b3d51db6)。比较范围是 Guardian
  的 policy、prompt、review parser 和拒绝后精确重试语义；未来上游变更不会自动继承。
- 当前上游 drift 基准：Codex `main`
  [`6751b54cae32b23786001e2414d749a9916201e1`](https://github.com/openai/codex/tree/6751b54cae32b23786001e2414d749a9916201e1)。从原始
  pin 到该 SHA 的 compare 为
  [`789c72d...6751b54`](https://github.com/openai/codex/compare/789c72dcf62d7439863d4d2846454f05b3d51db6...6751b54cae32b23786001e2414d749a9916201e1)。
  该 drift 显示 current-main runtime integration 已在 `mcp_tool_call.rs`、
  `session/handlers.rs` 和 app-server 协议层继续演进；P1 未声明复制这些
  runtime/lifecycle/telemetry 细节。
- 本地实现基准：Task 1--4 当前实现快照。本文件记录该实现，而不是把 Pi
  的整套权限执行面宣称为 Codex 的复制品。
- 核心分层：Guardian parser 只验证结构化响应契约；高风险是否可允许、授权证据的含义仍由 Guardian prompt/policy 决定。Pi 的 shell、Git metadata、受保护路径及网络判断是进入 Guardian 前的确定性本地策略，不属于 Guardian parity。

## Guardian 对齐项

| 主题 | 已对齐的实际行为 | 边界 |
| --- | --- | --- |
| policy、prompt 与输出契约 | `src/auto-review-request.ts` 的模板、默认 policy 和结果字段以固定 commit 的 Guardian 源文件为准；只要求 `outcome`，其余字段使用相应的 allow/deny 默认值。 | 本地命名可以提及 Pi，但不改变 policy 含义。 |
| parser | 先解析完整 JSON；失败时只尝试首个 `{` 到最后一个 `}` 的单对象恢复。非对象、缺失/非法 `outcome`、非法 enum 和非字符串 rationale 仍会拒绝；额外字段会被忽略。高/critical `allow` 不会被 parser 二次拒绝。 | 这是结构验证，不在 parser 重写 Guardian 的风险或授权 policy。 |
| bounded evidence / tools | Auto request 向 Guardian 传入 bounded role-tagged transcript（`user`、`assistant`、`tool` 与 tool error state）和 exact planned action。Guardian 可使用 bounded read-only local tools（`read`、`grep`、`find`、`ls`）补充证据；这些工具没有 write、shell、network、MCP/custom tool 或 nested approval 能力。绝对路径保持可读，不额外收紧为 workspace-only；这与 Codex `PermissionProfile::read_only()` 的全盘只读语义一致。 | Parent transcript、tool result 与 action arguments 均是不可信 evidence，不是 policy。parent `filesystemDenyRead` 作为 permission context 供 Guardian 判断待批准 action，不改写 Guardian child 的只读工具 allowlist；真正的 Codex child deny-read/写入边界由 OS sandbox 执行。read-only tool error 后的 allow 会 fail closed；deny 可保留为 bounded history。 |
| Auto failure block | provider、parse、timeout、cancelled 和未知 reviewer failure 在 Auto 中均 fail closed；UI 和 headless 都不会自动打开人工 approval fallback，也不会创建 exact grant。 | 用户若需要人工判断，必须切回 Default 或提交新的明确 action。 |
| 拒绝后精确批准 | approval ledger 将批准绑定到原 tool、input、cwd、config 与 action fingerprint；仅可消费一次，并由 Guardian 重新评估。传给可信 developer context 的首行精确为：`The user has manually approved a specific action that was previously \`Rejected\`.` 随后是序列化的 exact action。 | 人工批准不是直接执行，也不会扩大到相似命令或后续 action。 |
| retry / failure 边界 | Pi 保持 90 秒总 deadline、最多 3 次，且 review 异常不会自动执行 action。 | 具体 provider 错误分类和 UI 人工交接仍是 Pi 产品行为，不是对 Codex 内部实现逐行复刻。 |

固定 pin 对应的上游 Guardian 资料位于
[`policy.md`](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/policy.md)、
[`policy_template.md`](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/policy_template.md)、
[`prompt.rs`](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/prompt.rs)、
[`review.rs`](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/review.rs)
和 [`mod.rs`](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/mod.rs)。

## Pi 确定性策略：有意独立于 Guardian parity

| Pi 行为 | 目的与实际边界 |
| --- | --- |
| quote/escape-aware shell scanner | 只对活跃的 substitution、redirect 和真正以 `-c`/`--command` 执行的 shell 判为结构风险；普通参数里的 `bash` 或 `fish` 不是 nested shell。完整命令扫描还记录未引用、未转义的 `&`、`;`、`|`、换行和括号，因而 leading/trailing separator、background 与 outer grouping 都不能获得 Git metadata grant；引用或转义的字面 control 保持可用。 |
| Git metadata ownership | `.git` 以 `lstat` 开始检查，拒绝 symlink，并验证普通仓库、linked worktree 与 submodule 的 metadata/back-pointer/`core.worktree` 所有权。失败闭合；只把验证后的 metadata roots 授予合格的直接 mutation。SSH remote 保持 SSH，读取配置不会重写 remote。 |
| Git invocation / executable 边界 | Git global option 按真实 arity 解析；`-C`、`--git-dir`、`--work-tree`、`-c`、`--config-env` 等改变 target/config 的 option，以及未知或缺值 option，仍会暴露其后的 mutation/network candidate，但 metadata grant 失败闭合。只信任 plain `git`/`gh`、明确的只读系统 binary 路径及安全 wrapper context；`./git`、`/tmp/git`、command-scoped `PATH`/`GIT_*` 和 `env`/`sudo` cwd override 均确定性 HARD block。 |
| Git remote 的网络目的 | 按 Git subcommand grammar 解析 remote operand，不扫描后续 refspec；`push --repo`、`fetch --multiple` 和 `submodule add` 的 option arity 分别保留显式 remote、检查全部 remotes、跳过 option value。显式 `http`、`https`、`ssh`、`git` 与 SCP-like operand 共用 host normalizer，支持 IPv4、IPv6 与 ambiguous numeric target；确定的 local path 不进入网络策略，remote-helper `transport::address` 失败闭合。named/omitted remote 的 `fetch` 对每个 remote 只使用 `url`；`push` 优先该 remote 的 `pushurl`，没有时才回退 `url`，local `pushurl` 会抑制回退。未知 remote option 或无法解析且非确定 local 的 remote 产生 typed unsafe 结果并 HARD block。 |
| `git init` | 只为语法安全、单段、当前目录的 `git init` 或 `git init .` 处理初始化；bare、空参数或其他目标一律不获 metadata grant。当前目录没有 `.git` 时，prospective root 仅是 `realpath(cwd)/.git`；不会借用父仓库 metadata，存在 malformed/unsafe 当前 metadata 时仍失败闭合。 |
| Default / Auto / YOLO 分层 | Default 与 Auto 都先经过 Pi 确定性策略；仅 review-eligible 的 Auto 请求到 Guardian。YOLO 在风险 evaluator、Guardian、人工 approval 和 sandbox execution 前返回原生工具执行。 |

这些 Git/shell 规则解决 Pi 的权限边界问题；它们不是 Codex Guardian policy 的等价实现，也不应被用来推断两者的 ARC 或 sandbox 语义完全相同。

## P1 回归覆盖结论

- Default 与 Auto 初始化相同 workspace sandbox runtime config，并且 Auto reviewer 收到
  `sandboxProfile: "workspace-write"`、当前 allow/deny network snapshot、请求的
  network hosts 与 filesystem roots。
- Guardian allow 只授予 exact normalized tool/input、当前 cwd 和当前 config
  fingerprint；同一 tool-call ID 改 input、重复执行或 config reload 后执行都会失败闭合。
- Guardian deny 会记录 recent denial；`/approve` 只能选择该 exact denial，触发新 turn
  后仍需 Guardian 用 exact `approvalOverride` 重新评估，且不能扩大到相似 action。
- provider、parse、timeout failure 在 UI 与 headless Auto 中都 block；不会 re-open
  interactive approval fallback，也不会泄漏原始 provider 错误文本。
- YOLO 是唯一跳过 permission evaluator/Guardian/sandbox 的路径。Auto snapshot 中已获
  Guardian approval 的 call 即使 future mode 切到 YOLO，也继续通过该 snapshot 的 sandbox
  execution path。
- Git/private-network 额外 hard blocks 在 Auto 下仍作为外层 `pi-permissions:` policy
  block 返回，且不进入 Guardian review。
- 无 MCP metadata 的 custom-tool action 作为 `custom_tool_call` 送审，不会发明
  `connectorId` 或 `connected_account_email`。

## 最新验证证据

- 本轮 P1 review fix 的 focused suite：5 files、199/199 tests 通过；
  `npm run check`（`tsc --noEmit`）通过。
- 受限 sandbox 内的完整 `npm test` 首次记录为 9 个
  `tests/filtering-proxy.test.ts` case 无法 `listen 127.0.0.1`（`EPERM`）；
  在获准的 loopback 环境重跑后，23 test files、547 tests 通过，1 test file、
  1 test skip。该结果证明完整 suite 在允许 loopback 的环境中通过。
- `npm run core:test` 最近一次为 1/1 failed；`npm run core:check` 报告
  repository patch 支持 `pi-agent-core 0.82.1`，当前安装的是 `0.83.0`。
  因此 core regression 也不能宣称通过。
- `git diff --check` 通过；YOLO targeted suite 的历史结果仍为 28 tests 通过、
  67 tests 因名称筛选 skip。

## 已知非目标

- 不复刻 Codex 的 Guardian lifecycle events、`GuardianAssessment` telemetry 或 app-server 协议事件。
- 不实现相同的 review sandbox internals；Pi 的 Guardian 仅暴露本扩展拥有的 bounded
  read-only local tools，并不声称复制 Codex 的 OS-level child-session sandbox handoff。
  因而绝对路径读取不做 workspace containment；也不把 parent `filesystemDenyRead` 伪装成
  Guardian child 的 deny-list。Pi 仍保留自身 sandbox profiles、network allowlist 和
  native completion 调用模型。

## 剩余 P2 边界

1. Codex catalog `auto_review_model_override` / provider preferred review model
   metadata 尚未由当前 Pi model registry 暴露。
2. Pi 的 retry error taxonomy 与 Codex Rust classifier 行为相近，但不是逐 case 等价。
3. 当前 Codex `main` 的 `mcp_tool_call.rs` 和 `session/handlers.rs` runtime integration
   已超出 pinned prompt/policy 文件范围。
4. Pi 的 deterministic pre-Guardian Git、protected-path、private-network hard blocks 是
   有意保留的额外安全层；若未来要求 exact allow/deny parity，需另行设计且不能默认削弱。
5. app-server lifecycle / telemetry parity 不属于本 P1。

## 结论

本次 P1 对齐的承诺是固定 pin 下 Guardian 的 prompt、结构 parser、bounded evidence/read-only
review tools、Auto fail-closed、exact post-denial approval context 与 mode/sandbox
boundary；Pi 的确定性 Git/shell hardening 额外且独立。因而“对齐”不表示相同的 review
sandbox/network internals，也不扩展到 Codex 的 app-server lifecycle/telemetry。
