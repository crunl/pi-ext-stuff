# Codex CLI：工作中切换权限模式的策略

## 调研范围

- 上游仓库：[`openai/codex`](https://github.com/openai/codex)，通过 `gh repo clone openai/codex --depth=1` 检查当前源码。
- 重点：Full Access（Pi 的 YOLO 对应物）切换到 Default/Ask for approval 时，是否中止当前 turn，以及新权限何时生效。

## 结论

Codex 不会因为权限模式切换而中止当前 turn。TUI 把选择转换成 thread/session settings 更新；更新路径没有调用 interrupt/abort。新的权限设置立即写入 session，供后续 turn 使用；当前 turn 继续使用它创建时的 `TurnContext` 快照。这是从源码结构得出的行为判断：当前 turn 的 context 在 turn 开始时按 session configuration 创建，之后的 `Session::update_settings` 只更新 session configuration。

| 场景 | Codex CLI | 当前 `pi-permissions` |
| --- | --- | --- |
| 工作中 Full Access/YOLO → Default | 立即更新 thread/session 权限，不 abort；当前 turn 继续，后续 turn 使用 Default | 已对齐：立即更新 UI/session mode，不 abort；当前 run 保留 YOLO 快照，下一 run 使用 Default |
| 工作中 Default → Full Access/YOLO | 立即更新 session 权限，不 abort | 已对齐：当前 run 保留 Default 快照，下一 run 使用 YOLO |
| 当前 turn 是否被“追溯降权” | 不追溯；权限属于该 turn 创建时的 context | 已对齐：mode、config、sandbox profile 均按 run snapshot 固定 |
| Plan/Default 等 collaboration mode | 另有运行中切换保护；不要把它和 permission profile 切换混为一谈 | — |

## 关键源码路径

1. `codex-rs/tui/src/chatwidget/permission_popups.rs` 的 `approval_preset_actions` 发送 `AppCommand::override_turn_context(...)`，并更新 approval policy、permission profile、reviewer；该 action 本身没有 abort。
2. `codex-rs/tui/src/app/event_dispatch.rs` 的 `UpdateAskForApprovalPolicy`、`UpdateActivePermissionProfile` 和 `UpdateApprovalsReviewer` 更新运行时配置并同步当前 thread；这些分支没有 interrupt/abort。
3. `codex-rs/app-server/src/request_processors/turn_processor.rs` 的 `thread_settings_update_inner` 提交 `Op::ThreadSettings`。
4. `codex-rs/core/src/session/handlers.rs` 的 `update_thread_settings` 调用 `Session::update_settings`；`codex-rs/core/src/session/mod.rs` 的 `update_settings` 只应用新的 session configuration。
5. `codex-rs/core/src/session/turn_context.rs` 的 `new_turn_with_sub_id` 在新 turn 开始时创建 `Arc<TurnContext>`。因此“当前 turn 保持旧快照、下一 turn 使用新设置”是基于实现结构的推断，建议后续用 Codex 的运行中切换测试进一步确认。
6. `codex-rs/tui/src/chatwidget/input_flow.rs` 的 “Cannot switch collaboration mode while a turn is running” 只针对 collaboration mode，不是权限模式切换的限制。

官方源码：[`permission_popups.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/permission_popups.rs)、[`event_dispatch.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/app/event_dispatch.rs)、[`turn_processor.rs`](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/turn_processor.rs)、[`handlers.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/handlers.rs)、[`session/mod.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/mod.rs)、[`turn_context.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn_context.rs)。

## 对 `pi-permissions` 的含义

如果目标是对齐 Codex，不能只删除 `ctx.abort()`：Pi 的工具执行、sandbox 和审批上下文若直接读取可变的全局 `modeRuntime`，单纯删除 abort 可能让一个已经以 YOLO 开始的 turn 在中途看到 Default 配置，形成半程权限语义。更稳妥的实现是为每一轮建立 effective permission/sandbox snapshot：切换时立即更新 UI/session 的 future policy，当前 turn 保留自己的 snapshot，下一轮采用新模式。

## Pi permission-turn 生命周期契约

- `agent_start` 创建一个 permission turn 的权限与 sandbox 快照；`agent_end` 是该快照的权威结束边界。
- Shift+Tab 工作中切换只更新可见状态和 future mode，保留当前 permission turn 的审批、风险评估及 native/sandbox 执行语义，不调用 `ctx.abort()`。
- `agent_end` 后，旧审批上下文和快照不得延续或重建。紧随其后的 `agent_start` 必须创建最新 mode 的新快照，即使排队 continuation 使 `ctx.isIdle()` 始终为 `false`。
- `agent_settled` 只作为 outer-run cleanup fallback：它可以清理尚未由 `agent_end` 清理的状态，但不能定义 permission-turn 边界。
- 若运行中缺少 `agent_start` 事件，工具入口可以保守地捕获快照以避免半程降权；该兼容路径不得把 `agent_end` 到下一次 `agent_start` 的间隔误判为一个 active turn。

### 为什么不是 `turn_start` / `turn_end`

`turn_start` / `turn_end` 描述的是模型采样与工具调用的单个 round。同一个 Pi permission turn 可以跨越多个这样的 round，因此用它们创建或释放权限快照会把一次用户授权语义切碎：后续模型采样或工具调用可能不当地看到中途切换后的权限。`agent_start` / `agent_end` 才围住一次完整的 permission turn；`agent_settled` 则围住更外层的运行收尾。

## Turn 与 working/idle 的边界

- 一个 Codex turn 从一次独立的用户输入/触发任务开始，在同一个 `TurnContext` 中可以包含多次模型采样、工具调用和继续请求；工具调用不是新的 turn。
- Core 在任务完成后发出 `TurnComplete`，清理 `active_turn`，再发出 thread-idle 生命周期事件。TUI 随后把 `agent_turn_running` 设为 false。
- 若没有排队输入，此时就是可见的 `working → idle`，之后用户提交的消息才会创建下一个 turn。
- 若已有排队 follow-up，TUI 会在完成处理后立即提交一个新 turn，因此可能看不到 idle 的绘制间隙；语义上仍然存在 `TurnComplete → 新 TurnStarted` 的边界。
- working 中输入还可能作为 steer/pending input 合并进当前 turn；不能仅凭“用户又输入了一条消息”判断已经进入 next turn。

对应源码：[`core/tasks/mod.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/mod.rs)、[`core/session/turn.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs)、[`tui/chatwidget/turn_runtime.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/turn_runtime.rs)、[`tui/chatwidget/input_flow.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/input_flow.rs)。
