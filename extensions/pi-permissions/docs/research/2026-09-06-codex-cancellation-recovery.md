# Codex 取消、清理与恢复边界

研究日期：2026-09-06。固定上游 `openai/codex@ac192cd7937b0d73edc6dffe009940ae53782dd4`；使用 `git show` / `git grep` 检查该对象，未切换或修改上游工作树。上游部分是源码与已有测试的静态核对，未运行 Codex Rust 测试、真实 LLM 或全量构建；本地验证另列于文末。

## 取消入口与作用域

默认 Esc 对应 `interrupt_turn`；运行中且无优先弹窗时，bottom pane 发 interrupt，TUI 经 `TurnInterrupt` RPC 转成 `Op::Interrupt`，再进入 `interrupt_task → abort_all_tasks → handle_task_abort`。后者取消当前 task token，给任务 100ms 合作退出时间，然后 abort task handle；工具分发也会 abort 尚未完成的 dispatch future 并写入 aborted 结果。这个终止通知并不证明所有底层资源已收尾。[按键](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/tui/src/keymap.rs#L1502)、[UI 入口](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/tui/src/bottom_pane/mod.rs#L798-L808)、[RPC](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/app-server/src/request_processors/turn_processor.rs#L1603-L1610)、[task](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tasks/mod.rs#L900-L942)、[tool](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/parallel.rs#L180-L205)。

## 本地进程并非一种生命周期

普通 `exec.rs` 的显式 Cancellation 分支先向进程组发 TERM，等待直接子进程最多 50ms，再 KILL 剩余组成员；stdout、stderr 分别最多 drain 2s，超时 abort reader。取消返回非 timeout 结果。已有测试覆盖 TERM cleanup trap 和忽略 TERM 的后代。[实现](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/exec.rs#L985-L1077)、[常量](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/exec.rs#L61-L92)、[测试](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/exec_tests.rs#L1211-L1317)。

必须保留限定：Esc 可能从外层直接丢弃执行 future；`user_shell` 就使用 `or_cancel`，spawn 则配置 `kill_on_drop(true)`。不能据上面的 Cancellation 分支断言所有 Esc 都完成 TERM 宽限和双管道 drain，也不能把直接 child 的 drop 保证提升为任意后代回收保证。[外层取消](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tasks/user_shell.rs#L246-L260)、[spawn](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/spawn.rs#L94-L136)。

`unified_exec` 在首次 yield 前把活进程存入 manager，明确让进程跨 turn interrupt 存活。显式 terminate/drop 才调用本地 process handle：杀进程组、abort 读写任务，同时 detach waiter 让它继续 reap；本地 `terminate_confirmed` 没有等待 OS exit 的屏障。已有测试检查 reader 关闭及 child reap。背景清理是独立的 `CleanBackgroundTerminals` 操作。[持久化](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/unified_exec/process_manager.rs#L565-L590)、[终止](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/utils/pty/src/process.rs#L219-L276)、[confirmed](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/unified_exec/process.rs#L240-L252)、[测试](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/utils/pty/src/tests.rs#L794-L872)、[独立清理](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/session/handlers.rs#L59-L65)。

`write_stdin` 的 Ctrl+C 是另一条路径：TTY 写入控制字符，非 TTY 将该输入转成 process interrupt；这不等于取消当前 agent turn。[实现](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/unified_exec/process_manager.rs#L920-L932)。

## Guardian 与下一轮

Guardian 审批取消会中断 reviewer 的对应 turn，最多 drain 5s，并区分 Aborted 与 TimedOut。匹配终止事件后允许复用 reviewer；失败则按实例身份移除该 trunk 并后台 shutdown。`invalidate` 清的是 reviewer trunk/ephemeral sessions；管理器自身取消发生在 shutdown。这是资源作用域的淘汰，不是把用户取消升级成宿主执行器永久失效。[drain](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/guardian/review_session.rs#L1489-L1524)、[5s 与终止事件](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/guardian/review_session.rs#L1715-L1739)、[淘汰](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/guardian/review_session.rs#L737-L744)、[invalidate](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/guardian/review_session.rs#L543-L563)。

恢复的正面证据是：每轮创建新 token；同会话中断工具后，已有测试继续提交下一轮并得到 TurnComplete；Guardian 测试还验证延迟批准不会执行旧命令，随后新一轮完成。因此已检查路径支持继续会话，没有经过进程级 poison 恢复门；这不是用“搜不到 poison”证明整个 Codex 无失效状态。上述下一轮测试主要验证会话与历史，没有穷尽下一条本地命令及所有 OS 后端。[新 token](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tasks/mod.rs#L306-L313)、[工具取消后续轮](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/tests/suite/abort_tasks.rs#L249-L269)、[Guardian 后续轮](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/tests/suite/guardian_review.rs#L1275-L1317)。

## 对 pi-permissions 的启示

推论：取消表达“调用者不要结果”，资源健康表达“后续执行是否仍可安全使用执行域”，应分别建模。Codex 本地命令把 argv/env/沙箱包装交给子进程；pi-permissions 的 SRT 则有宿主全局可变单例、独占 lease 与策略恢复义务，不能照搬丢 future 后继续执行。合理借鉴是：取消后保留 cleanup 所有权，确认 drain/恢复完成才复用；无法确认时隔离或淘汰对应执行域，由新实例恢复。绝不能仅清 poison 标志，同时放任旧 SRT mutation 继续运行。[命令构造与 spawn](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/exec.rs#L878-L937)、[本地架构约束](../../AGENTS.md)。

## 本地处理方案（经独立复核后实施）

修复前的本地基线为 `b137fb9aa110e7a2a4d72768140fe8fdb252aaa9`。问题不是缺少锁：`srt-coordinator.ts` 已让取消后的 operation 继续持有 lease。该版本 `srt-enforcer.ts` 的执行 abort callback 无条件 `markPoisoned()`，正常收尾不会解除它；只有成功 `activate()` 才清除。初始化取消后的 catch 也会设置 poison。错误文案却统一归因于 cleanup failure。[协调器](../../src/sandbox/srt-coordinator.ts)、[执行器](../../src/sandbox/srt-enforcer.ts)。

建议保留现有 `SandboxManagerLike` Interface 与 SRT Adapter，把变更收敛到执行生命周期：

1. **分离结果和健康。** 当前调用可以立即返回 cancelled/timed-out，已有 lease 进入 draining。draining 是当前 operation 的暂态，不是永久 fault；用带阶段/原因的故障记录替代无来源的 poison boolean，不另建全局恢复服务。
2. **独立收尾。** 取消后停止转发输出并终止当前进程组；子进程终止、管道处理、SRT cleanup、基础策略恢复、网络授权和 ticket 撤销分别完成。收尾不能复用已取消 signal。spawn 失败、运行中 child error 与真正 close 必须区分，不能把任意 promise rejection 当成退出证明。初始化中取消则在原初始化停止变更后完成 reset，回到可重新初始化的已知状态。
3. **有界等待，不越权解锁。** 新沙箱请求在原 lease 后可取消、有限等待。收尾失败或超过独立 lifecycle deadline 才产生持久 fault，并使等待者得到准确的执行器错误；到期不能释放仍有 SRT mutation/子进程未完成的 lease。draining 也不能让 bare escalation 健康检查误判为可执行。正常收尾直接结束暂态，无需调用全局 clearPoison，避免旧回调清除新故障。
4. **真实故障保持保守。** fault 只经成功的受锁保护 activate/reset-and-initialize 恢复。若旧操作一直不返回，同进程无法安全强制替换 SRT 单例，应提示重启 Pi，而非偷偷释放锁。普通取消不需要重启，也不每次全量重建 runtime。
5. **不改变授权和其他执行域。** 不重放旧命令，不复用旧批准，不改变 MCP 绕过策略，不修改 Pi host 或独立 Guardian worker。错误只携带有界的阶段、原因和已有调用标识，不泄露命令、环境或敏感路径。当前取消仍提示可能已有部分效果；后续确实无法执行时，不伪装成 reviewer 拒绝。

实施时先修改 coordinator/Adapter 的生命周期，再补行为回归：取消后成功执行下一条、初始化/包装阶段取消、子进程/管道收尾、真实 cleanup/restore 失败、收尾超时、排队取消、多 manager 串行、迟到回调与 escalation 健康门。更新现有“超时后必定 poison”断言，但保留真实 cleanup 失败必须阻止下一次执行的断言。最后运行 `npm run check`、`npm run test` 以及无 provider 的真实 SRT 取消后再执行 smoke；Guardian diagnostic 只作独立 worker 未受影响的检查，不当作宿主取消已修复的证明。

研究轮次运行 `npm run test -- tests/srt-enforcer.test.ts`：20/20 通过。这是旧行为基线，使用 Fake SRT 与真实本地子进程，不证明新方案已实现或真实 SRT 故障已修复。

## 实施复核与验证记录

Luna 独立审查确认取消与运行时健康分离的方向，要求落实 child `close`、停止迟到输出、初始化取消的安全 reset，以及不会提前释放 lease 的 watchdog。实现沿用现有 Interface 和宿主健康检查，不新增配置、worker、恢复服务或自动重试。主代理同步审查将重复取消 reset 分支收敛，并要求 guard 清理失败持久阻止执行、迟到网络授权绑定原执行身份。

- 修改前：`npm run check` 通过；全量测试 776 passed / 1 skipped。
- 修改前真实 SRT：本地子进程输出 ready 后取消，得到 `aborted`；下一次执行稳定复现永久 poison，无 reviewer/provider 参与。
- 实施中真实 SRT：同样取消后 `isHealthy()` 暂时为 false；不重新 activate，直接通过现有文件适配器在专用 `/tmp` 目录写入、读取微型 fixture 成功；命令超时后下一次执行成功，最终 reset 完成。
- 独立 Guardian：`npm run diagnose:guardian` 报告 evidence、cleanup 和 complete 全部通过，使用固定本地 reviewer stub。
- 外层沙箱默认禁止回环监听，首次真实 SRT 复现因此报 `listen EPERM`；随后仅为这些本地诊断请求提升执行权限。没有访问外网、调用真实模型或读写用户配置。

实现收口后重新运行相同真实 SRT smoke，取消后文件写入/读取、超时后下一次执行和最终 reset 均通过。Luna 补齐实现后的回归测试：SRT 专项 28/28，全量 35 个文件、784 passed / 1 skipped，类型检查与受影响文件的 Biome 检查通过。覆盖了 child error 等待 close、迟到输出丢弃、lease 排队与超时、真实故障保持禁用、初始化/包装阶段取消以及迟到网络授权不签发 ticket。

最终独立验证给出 PASS，重新运行类型检查、全量测试、受影响文件 Biome 和 diff 空白检查，结果一致。另以 Fake SRT 与真实 Node 子进程验证：取消与真实初始化错误交错时仍保留 initialization fault，reset 不清除、activate 才恢复；下一条执行复用相同 signal 和授权回调时，旧批准仍被执行身份拒绝，ticket 签发次数为零。专用 `/tmp` fixture 与空目录已清理，未提交改动。

验证范围为本地 macOS 真正 SRT 与测试替身；没有执行 Codex Rust 测试、真实 provider 请求或 Linux/Windows 实机验证。正常取消恢复对齐的是调用生命周期语义，不是对所有 Codex 后台进程模式作完全等价承诺。
