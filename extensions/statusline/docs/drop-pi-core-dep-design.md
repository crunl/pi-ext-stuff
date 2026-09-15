# statusline 去除 pi-core 依赖 — 研究与设计

> 状态：设计定稿，未实施。
> 范围：只分析 `statusline` 对 `pi-core/standalone.ts` 的两处 import
> （`applyAutocompleteAbove`、`outputPaddingController`），不改代码。
> 对照源码：Pi `origin/main` @ `f9bcd35`（`/Users/x1a2h1/.pi/agent/work/upstream-src/pi`），
> 本机安装 npm 包 0.85.1。下列 file:line 均以 origin/main 为准；与 0.85.1
> 在相关 seam 上无差异（ExtensionContext / setFooter / settings 路径均未变）。

---

## 1. 第一性原则

1. **footer 与聊天区的水平对齐是 host 布局契约的一部分，但 host 并未把它 API 化。**
   Pi 的 `outputPad`（`0 | 1`，默认 `1`）只作用于 chat message 组件
   （user / assistant / custom message），**内置 footer 根本不用它**
   （见 §2.3）。自定义 footer 若要「与聊天 gutter 对齐」，这是 statusline
   自己的呈现目标，不是 host 自动保证的布局。

2. **extension 应优先消费 host 公开 API，再退回「读 host 同一份事实源」，
   最后才考虑 sibling 扩展依赖。**
   对 `outputPad` 这类 *host settings 事实*，sibling 依赖（pi-core）不是
   正确归属：pi-core 是 TUI *呈现* 扩展，不是 settings 的 owner。真正的
   owner 是 Pi 的 `SettingsManager` + `settings.json`。

3. **依赖应按「所有权」划分，而不是按「现在碰巧有导出」划分。**
   - `outputPad` 的值 → host settings → statusline 自读（或未来等 host API）。
   - autocomplete-above 浮层 → editor 私有字段补丁 + 多文件 TUI 子系统
     → 天然属于 pi-core（TUI 呈现层），statusline 只是 *组合* 它。

4. **footer 是持续渲染组件，不是 message renderer。**
   任何「通过 message renderer 回调拿 outputPad」的路径在架构上就错位了
   （§2.4）。

---

## 2. 源码事实清单

### 2.1 ExtensionContext / ExtensionUIContext：没有 outputPad，没有 settingsManager

`packages/coding-agent/src/core/extensions/types.ts`：

| 符号 | 位置 | 结论 |
| --- | --- | --- |
| `ExtensionContext` | `:309-349` | 字段为 `ui, mode, hasUI, cwd, sessionManager, modelRegistry, model, scopedModels, thinkingLevel, isIdle, isProjectTrusted, signal, abort, hasPendingMessages, shutdown, getContextUsage, compact, getSystemPrompt`。**无 `settings` / `settingsManager` / `outputPad`。** |
| `ExtensionUIContext` | `:133-284` | dialogs、`setStatus`、`setWidget`、`setFooter`、`setHeader`、`setEditorComponent`、theme 读写、`get/setToolsExpanded` 等。**无任何 settings / padding getter。** |
| `isProjectTrusted()` | `:334`；实现在 `core/extensions/runner.ts:768-771` → `agent-session.ts:2649` → `settingsManager.isProjectTrusted()` | **live getter**（每次调用读当前 trust），不是快照。 |
| `ExtensionContextActions` | `:1717-1730` | 同样无 settings 面。 |

⇒ 「从 Pi API 直接读 outputPad」在 0.85.1 与 origin/main 上都 **不存在**。
用户质疑「output padding 难道读的不是 Pi 的 api 吗」——答案是：
**Pi 管这个值，但没有把它暴露给 extension。** 这是 host 的 API 缺口，
不是 statusline 读错了地方；statusline 当前只是选错了 *中介*（pi-core）。

### 2.2 没有 settings 变更事件

`ExtensionAPI.on(...)` 全部事件见 `types.ts:1257-1301`：

- 有 `session_start`（含 `reason: "reload"`，`/reload` 时会再发，`:563-570`），
  有 `session_info_changed`——但 payload **只有 session name**
  （`types.ts:572-577`：`{ type, name }`）。
- **没有** `settings_changed` / `settings_reload` / 任何携带 settings 的事件。

⇒ statusline 无法「订阅变更 + 读当前值」。能依赖的只有：

1. 每次 `footer.render()` 时主动读事实源；或
2. 自己 watch 文件（pi-core 现状）；或
3. 等 host 补 API（上游提案，见 §5）。

### 2.3 footer / statusline 在 Pi 原生怎么拿 outputPad

**结论：原生 footer 不拿。**

- `modes/interactive/components/footer.ts:50-244` `FooterComponent.render(width)`
  直接用满宽排版（`truncateToWidth(..., width)`），**全文无 `outputPad`**。
- `interactive-mode.ts` 把 `outputPad` 存在 mode 自身并只喂给 chat 组件：
  - `:438` 字段 `private outputPad = 1`
  - `:574` / `:1950`（`applyRuntimeSettings`）/ `:6017`（reload 路径）
    `this.outputPad = this.settingsManager.getOutputPad()`
  - `:3234, 3602, 3644, 3653, 3670, 4275` 传给 User/Assistant/Custom message、
    streaming、错误 Text
  - `:4591` 作为 settings-selector 当前值；`:4717-4736` `onOutputPadChange`
    → `settingsManager.setOutputPad` + 重建 chat（**不通知 footer，不发 extension event**）
- `setFooter` 契约（`types.ts:185-189`）：
  `(tui, theme, footerData) => Component`，`render(width)` 收到的是
  **完整可用宽度**，没有 pad 参数，`ReadonlyFooterDataProvider` 也只有
  git branch / extension statuses / provider count。
- 官方示例 `examples/extensions/custom-footer.ts` 同样不做水平 gutter。

⇒ **没有可复用的公开 seam。** statusline 的对齐是自加的目标，必须自己取值。

### 2.4 custom message / entry renderer 路径

- `MessageRenderOptions`（`types.ts:1195-1199`）确实有 `outputPad`，
  但只经由 `registerMessageRenderer(customType, renderer)`（`:1352`）
  在渲染 **该 customType 的消息** 时传入。
- `EntryRenderOptions`（`:1209-1211`）只有 `expanded`，无 pad。
- footer 不是 message。为拿 pad 而注册一个永远不触发的 message renderer
  是错误 seam；注册一个会触发的又等于把 footer 状态绑到聊天流上。

⇒ **否决**：不值得，架构错位。

### 2.5 settings 合并与文件读取（statusline 自读的正确性依据）

`core/settings-manager.ts`：

| 事实 | 位置 | 含义 |
| --- | --- | --- |
| 路径 | `:229-233`；`config.ts:504, 528-534` | global = `getAgentDir()/settings.json`；project = `join(cwd, CONFIG_DIR_NAME, "settings.json")`。`getAgentDir` / `CONFIG_DIR_NAME` 均为 **公开导出**。 |
| 合并 | `:183-186, 345, 559` | `deepMergeSettings(global, project)`，project 覆盖 global。 |
| trust 门闩 | `:405-407, 518-522` | `!projectTrusted` 时 project 视为 `{}`。 |
| 读值 | `:1372-1374` | `getOutputPad(): this.settings.outputPad === 0 ? 0 : 1`（默认 1，非 0 一律 1）。 |
| 写值 | `:1376-1379` | `setOutputPad` **只写 globalSettings**。project 里的 `outputPad` 只能手改。 |
| 文件 watch | 无 | host **不 watch** settings 文件；手改后要 `/reload` 才进内存。 |

对顶层标量 `outputPad` 而言，「project 文件里有该键则取 project，否则 global」
与 `deepMerge` 等价。pi-core 的实现正是如此
（`pi-core/src/tui/output-padding.ts:103-110`），且有测试钉住 trust 行为
（`pi-core/tests/output-padding.test.ts:85-99`）。

### 2.6 现有 pi-core `outputPaddingController` 对 statusline 的过重与瑕疵

`pi-core/src/tui/output-padding.ts`：

- 职责：缓存值 + `watchFile` 轮询（500ms）+ `track(toolCallId, invalidate)`
  给 tool-call 行做失效 + 跨 jiti 的 `Symbol.for` 单例
  （`:124-135`）+ `registerOutputPaddingSync` 在 `session_start`/`shutdown`
  启停（`:137-148`）。
- **statusline 只用 `getOutputPad()`**（`statusline/src/footer.ts:204`），
  从不 `track` / `start` / `stop`。启动完全依赖 pi-core 的 register 图先跑过。
- **竞态**：`/settings` 改 outputPad 时 host 是「写文件 → 内存生效 →
  立刻 rebuild chat」（`interactive-mode.ts:4717-4736`）；controller 要等
  `watchFile` 最多 500ms 才刷新。这期间 footer gutter 与 chat **短暂错位**。
  statusline 若在 `render()` 里直接读文件，则与 host 的写盘同步，无此窗口。
- footer 每帧都会 `render()`，**不需要 watcher、不需要单例、不需要 track**。

### 2.7 `applyAutocompleteAbove` 在 statusline 里干什么

`statusline/src/index.ts:79-92`：

```ts
ctx.ui.setEditorComponent((tui, theme, keybindings) => {
  const editor = new ModelLineEditor(tui, theme, keybindings);
  // ...注入 model/stats/permissions/badge providers...
  return applyAutocompleteAbove(editor, tui);
});
```

原因（`pi-core/src/tui/autocomplete-above.ts:175-178` 注释已写明）：
pi-core 的 `registerAutocompleteAbove` 在自己的 `session_start` 里 wrap
「当时的」editor factory；statusline **之后**再 `setEditorComponent` 会把
wrap 过的 factory 整个替换掉，于是 statusline 必须对自己的
`ModelLineEditor` 再调一次。

该函数是多文件子系统，不是薄工具：

| 文件 | 作用 |
| --- | --- |
| `autocomplete-above.ts` | patch `Editor.autocompleteList`（**私有字段**）/ `render` / `handleInput`；tab/shift+tab/enter 重映射 |
| `editor-float-panel.ts` | 零位移浮层 |
| `selector-float.ts` | selector 容器补丁 |
| `selector-tab-nav.ts` | 导航锚点 |
| `frame.ts` | 边框几何 |

Pi 公开 API 只有 `setEditorComponent` / `addAutocompleteProvider`
（`types.ts:227, 262`），**没有**「autocomplete 显示在上方」的等价物。
`pi-core/tests/pi-api-compat.test.ts` 专门钉住这些私有 seam。

⇒ 这块 **本来就该在 pi-core**（editor 呈现层）。statusline 作为
「替换 editor 的后装者」去组合它，是合理依赖；把它 vendor 进 statusline
才是所有权倒置。

### 2.8 statusline 现状与仓库惯例

- import：
  - `src/index.ts:20` → `applyAutocompleteAbove`
  - `src/footer.ts:19` → `outputPaddingController`，仅 `:204` 调用
    `getOutputPad()` 后算 gutter / innerWidth。
- 仓库有 `docs/`（含 `docs/superpowers/{specs,plans}/`），**无 `work/`**。
  本文按惯例落在 `docs/`。
- 测试：`node --experimental-strip-types --test tests/*.test.ts`
  （`package.json`），无 vitest。

---

## 3. 推荐方案 + 被否方案

### 3.1 唯一主推：**B（精确化版）**

> **outputPad：statusline 自足**（本地纯函数，每次 `footer.render()` 读文件）；
> **`applyAutocompleteAbove`：保留为唯一、有意的 pi-core import。**

也就是：**去掉 `outputPaddingController` 依赖，不去掉全部 pi-core 依赖。**

理由：

1. **归属正确。** outputPad 是 host settings 事实，statusline 自读
   `settings.json` 与 host 同源、同 merge 规则、同 trust 门闩；
   不再借道「碰巧也读了这份文件」的 TUI 扩展。
2. **实现极薄。** 约 30–40 行纯函数 + 单测；无 watcher、无单例、无
   跨 jiti Symbol、无 `session_start` 启停。
3. **时序更优。** 消除 §2.6 的 500ms watch 竞态；`/settings` 改 pad 后
   下一帧 footer 即对齐。
4. **兼容 0.85.1 与 origin/main。** 只依赖公开导出
   `getAgentDir` / `CONFIG_DIR_NAME` 与 `ctx.cwd` / `ctx.isProjectTrusted()`，
   以及 `node:fs`；不碰任何私有 seam。
5. **autocomplete 保持单点。** pi-core 已是该子系统的 owner，且有
   `pi-api-compat` 测试护栏；statusline 复制五份文件只会制造双份私有
   API 漂移。一个显式、有注释的 sibling import，比「为了零 import 而
   vendor 半个 TUI 补丁层」干净得多。
6. **与 pi-core 剩余契约清晰。** 文档化为：
   「statusline → pi-core：仅 `applyAutocompleteAbove`」；
   pi-core 的 `standalone.ts` 消费者表也可去掉 outputPadding 一行。

### 3.2 被否方案

| 方案 | 内容 | 否决理由 |
| --- | --- | --- |
| **A 完全自足** | 自读 outputPad **且** vendor autocomplete-above 全家桶 | 要复制 5 个文件、钉住 `autocompleteList` 等私有字段，并与 pi-core 双份维护；`pi-api-compat` 护栏失效一半。收益（少 1 个 import）远低于成本。 |
| **C 抽独立小包** | 把 `OutputPaddingController` 抽成 `pi-output-pad` 之类微包 | 仍是 sibling/第三方依赖，只是换了路径；且 statusline 根本不需要 watcher+track 那套，抽包等于固化过重抽象。若未来 *多个* 扩展都要 live pad + invalidate，再抽不迟。 |
| **Message renderer 探针** | 注册 renderer 只为偷 `options.outputPad` | footer 不是 message；customType 不出现则永不触发（§2.4）。 |
| **依赖扩展加载顺序** | 让 statusline 先 `setEditorComponent`，由 pi-core 后 wrap，从而不 import autocomplete | 加载顺序由 settings/extensions 列表决定，脆弱且无测试保障；pi-core 注释明确要求后装者自己调（§2.7）。 |
| **照抄 pi-core watcher** | statusline 内嵌 500ms `watchFile` | footer 每帧 render，读文件即可；watcher 引入延迟、泄漏与启停复杂度，还保留竞态。 |
| **等 host API 再动手** | 向 pi 提案 `ctx.getOutputPad()` / settings 事件 | 正确的长期方向，但不阻塞本次；可并行提 issue（§5）。 |

---

## 4. 实施计划

### 4.1 新增：本地 outputPad 读取器

**新文件** `src/output-pad.ts`（纯函数，无副作用）：

```ts
// 伪代码 — 实施时按此形状写，不要抄 pi-core 的 Controller
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type OutputPad = 0 | 1;

function readPadKey(path: string): unknown {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw === "object" && raw !== null && Object.hasOwn(raw, "outputPad")) {
      return (raw as { outputPad: unknown }).outputPad;
    }
  } catch {
    // 与 host / pi-core 一致：缺失或非法 JSON = 空 scope
  }
  return undefined;
}

/** 与 SettingsManager.getOutputPad 同语义：仅字面量 0 为 0，默认 1。 */
export function readOutputPad(cwd: string, projectTrusted: boolean): OutputPad {
  let value = readPadKey(join(getAgentDir(), "settings.json"));
  if (projectTrusted) {
    const project = readPadKey(join(cwd, CONFIG_DIR_NAME, "settings.json"));
    if (project !== undefined) value = project; // project 覆盖 global
  }
  return value === 0 ? 0 : 1;
}
```

要点：

- 路径与 merge/trust 规则对齐 §2.5，**不要**做 deepMerge（顶层标量够用）。
- 不缓存、不 watch。调用方决定调用频率。
- 不 import pi-core。

### 4.2 改：`src/footer.ts`

- 删除 `import { outputPaddingController } from "../../pi-core/standalone.ts"`。
- `render()` 内：

```ts
const pad = readOutputPad(ctx.cwd, ctx.isProjectTrusted());
```

- 文件头注释改为说明「gutter 跟踪 settings.outputPad；host 未向
  extension 暴露该值，故自读 settings.json」。
- 其余 gutter / `innerWidth` 逻辑（`:204-231`）不动。

### 4.3 保留：`src/index.ts` 的 `applyAutocompleteAbove`

- 保留 import 与 `:91` 调用。
- 把顶部注释从「standalone 是无副作用面」收窄为：
  「仅组合 pi-core 的 autocomplete-above；editor 私有字段补丁归属 pi-core。」

### 4.4 测试

新增 `tests/output-pad.test.ts`（沿用现有 `node --test` 风格）：

| 用例 | 期望 |
| --- | --- |
| 无任何 settings 文件 | `1` |
| 仅 global `outputPad: 0` | `0` |
| global `0` + trusted project `1` | `1`（project 覆盖） |
| global `1` + untrusted project `0` | `1`（忽略 project） |
| project 文件损坏 / 非 JSON | 退回 global |
| global 缺键、project 有 `0` 且 trusted | `0` |
| `outputPad: "0"`（字符串）或 `2` | `1`（仅字面量 `0` 为 0） |

现有 footer/format 测试不受影响；若 footer 测试有注入点，把
`readOutputPad` 做成可注入 provider（可选，非必须）。

### 4.5 文档与门禁

1. 更新 `statusline/README.md`「实现方式」：删除 pi-core outputPadding
   描述，写明自读 settings；依赖表只留 `applyAutocompleteAbove`。
2. 更新 `pi-core/AGENTS.md` 与 `standalone.ts` 头注释的消费者表：
   `outputPaddingController` 一行标为「statusline 已迁出；仅 pi-permissions
   / tool-renderer 内部使用」（若 standalone 无其他消费者，可评估是否
   仍需 export——**本次不动 pi-core 代码**，只改文档注释可选）。
3. 门禁：
   - `cd statusline && npm test`
   - `cd pi-core && npm run check && npm run test`（确认无回归；本次应零 diff）
   - 手工 TUI：`/settings` 切换 outputPad 0↔1，确认 footer 与 chat 同帧对齐；
     `/reload` 后仍对齐；untrusted 项目下手改 project `settings.json` 不生效。

### 4.6 步骤顺序

1. 落 `src/output-pad.ts` + 单测（红→绿）。
2. 改 `footer.ts` 接线，删 pi-core import。
3. 改 README / 注释。
4. 跑 §4.5 门禁 + 手工 TUI 验收。
5. （可选，并行）向 pi 上游提 issue：希望 `ExtensionContext` 或
   `setFooter` 的 `footerData` 暴露 `getOutputPad()`，或增加
   `settings_changed` 事件——落地后 statusline 可再删本地读文件。

---

## 5. 风险与不做

### 风险

| 风险 | 评估 | 缓解 |
| --- | --- | --- |
| 手改 `settings.json` 但不 `/reload`：footer 已跟新文件，chat 仍是内存旧值 | 与 pi-core watcher **同构**的固有错位；host 本身也不热加载 | 接受；文档注明「与 host 一致，以 `/reload` / `/settings` 为准」。read-on-render 并不比 watcher 更差，且消除了 `/settings` 路径的 500ms 窗口。 |
| 每帧 `readFileSync` + `JSON.parse` | settings.json 通常 < 4KB；footer 每帧一次，可忽略 | 若未来 profile 成热点，再加 mtime 缓存（仍不要 watcher）。 |
| `getAgentDir()` 依赖 `PI_CODING_AGENT_DIR` | 与 host / pi-core 相同解析（`config.ts:528-534`） | 无需处理。 |
| trust 中途变化 | `ctx.isProjectTrusted()` 是 live（§2.1） | 每次 render 调用即可。 |
| 仍保留一个 pi-core import | 有意为之（§3.1） | 在 README/注释写明边界；pi-core `standalone.ts` 继续是唯一 widening 点。 |
| 0.85.1 vs origin/main 漂移 | 本次触及的 API（`getAgentDir`、`CONFIG_DIR_NAME`、`ctx.cwd`、`isProjectTrusted`、`setFooter`）两侧一致 | 升级 pi 后跑一遍手工 TUI 验收。 |

### 明确不做

- 不改 `pi-core` 运行时代码（含 `output-padding.ts` / `standalone.ts` 导出）。
- 不 vendor `applyAutocompleteAbove` 及其依赖树。
- 不引入 settings watcher / 全局单例 / `Symbol.for`。
- 不把 footer 改造成 message renderer，也不注册探针 renderer。
- 不在本次向上游提 PR（issue 可选并行）。
- 不处理 `pi-permissions` 对 pi-core 的依赖（本案范围外）。

---

## 6. 一句话结论

**Pi 管 `outputPad` 却不暴露给 extension；内置 footer 甚至不用它。**
statusline 的对齐目标应通过「同源自读 settings.json（trust 门闩 +
project 覆盖）」在每次 `footer.render()` 时满足，从而删除对
`outputPaddingController` 的 sibling 依赖；而 `applyAutocompleteAbove`
是 editor 私有补丁子系统，所有权在 pi-core，**保留为唯一 import**
是边界最干净、维护成本最低的路径（方案 B）。
