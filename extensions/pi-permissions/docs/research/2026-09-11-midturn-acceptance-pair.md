# Mid-turn mode apply：clean-pair 验收记录（2026-09-11）

> **Codex pin 约定（standing）：** [`129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`](https://github.com/openai/codex/commit/129fd21687fbd4ac48133b7abfdcaf52cb6cb01f)。
> 本文不引入新的漂移快照。

## Scope

记录 `fda8d2a` + `aa93afa`（mid-agent auto/yolo 在 `turn_start` step boundary 生效）的
**clean revision-pair acceptance**，并声明这两条 commit body 里带 dirty sibling 的
结果为 **provisional**。不重述实现细节；行为契约见 `docs/host-api-boundaries.md`。

## 决策与被否决项

- **采用：** cycle 只更新 desired mode；下一次 `turn_start` 再 activate/teardown SRT
  并 patch 当前 snapshot（含 nested children），不 `beginTurn`、不清 grants。
- **否决：** cycle 瞬间热切换 sandbox profile；并行维护第二套 permission ledger。
- **失败关闭：** yolo→auto 激活失败保持 yolo，不降级放行。
- **Review 修复（`aa93afa`）：** step-boundary activate 必须 `force=false`。
  `force=true` 会走 `commitActivation` 的 `permissions.invalidate`，清掉 grants /
  nested / Auto circuit。

## 旧记录状态

`fda8d2a` / `aa93afa` commit body 中的 Acceptance 段均附带
`sibling pi-core@5f0cf17 dirty`。按仓库验收定义，那是 **blocked/provisional**，
不是 acceptance。不改写历史；以本节声明为准。

## Clean-pair acceptance（2026-09-11）

| 项 | 值 |
| --- | --- |
| pi-permissions | `aa93afa` |
| pi-core | `5f0cf17`（working tree clean） |
| 方法 | 临时 worktree pair，不动 live dirty sibling |
| 路径 | `work/accept-pair/{pi-core,pi-permissions}`（跑完即拆，非产品树） |

结果：

- `npm run preflight:sibling` → OK `@ 5f0cf17`（无 dirty）
- `npm run check` → green
- `npm run lint` → green
- `npm test` → 1089 passed / 1 skipped

同日补强：`npm run check:host-turn-boundary` 成为 mid-turn / host lifecycle
切片的 named check（offline real-host：`createAgentSession` +
`bindExtensions` + `ExtensionRunner` 驱动 `agent_start`/Shift+Tab/`turn_start`）。

复现：checkout 上述两个 SHA，使 `extensions/pi-core` 与 `extensions/pi-permissions`
（或等价相对布局）相邻，在 permissions 侧安装依赖后跑同一套命令。

## 本文不声称

- 不声称 live `../pi-core` 工作树当前 clean（验收时其 TUI WIP 仍 dirty）。
- 不声称真实 TUI Shift+Tab 人机路径已验证；step boundary 契约由
  `check:host-turn-boundary`、单测，以及 session 外 live-LLM harness
  （`work/e2e-midturn/`）共同支撑。
- 不引入 sibling SHA pin；pair 只钉定本次验收对象。
