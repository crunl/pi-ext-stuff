# Pi-Suite: 复合扩展套件架构设想与第一性原则推演

> 本文档记录了针对 `pi-ext-stuff` 项目中 `pi-core`、`pi-safety`、`statusline` 三大扩展架构演进的系统性调研、第一性原则思辨与最终套件化方案。
>
> 对照源码依据：Pi 官方仓库（`https://github.com/earendil-works/pi` @ commit `f9bcd35` / 0.86.0+），重点参照 `packages/coding-agent/src/core/extensions/`（`runner.ts`, `loader.ts`, `types.ts`）、`packages/coding-agent/src/core/packages/pi-manifest.ts`、`packages/coding-agent/src/modes/interactive/interactive-mode.ts` 以及 `packages/tui/`。

---

## 一、 背景与历史矛盾剖析

在项目历史演进中，三个扩展形成了如下现状与隐痛：
1. **`pi-core`**：提供 Codex 风格的内置工具渲染（`bash` / `write` / `edit` / `read` / `grep` 等）、Diff 预览框、自动补全置顶浮层（`autocomplete-above`）、纯净代码块等 TUI 增强。
2. **`pi-safety`**：接管敏感工具（`bash` / `write` / `edit`）执行权限判定、沙箱执行与 Auto-Review。但在放行或拦截时，为了保持全局视觉一致，它需要 Codex 渲染器，因而通过相对路径 `../../pi-core/standalone.ts` 强行静态依赖了 `pi-core`。
3. **`statusline`**：原本旨在提供终端底部的状态栏（Powerline 风格的目录、分支、模型、Context 使用率等）。但由于它为了给输入框加上圆角边框、安全模式徽章和 Token 统计，曾整车替换了 `CustomEditor`，覆盖了 `pi-core` 的补全置顶补丁，导致其不得不也依赖 `pi-core` 补调一次 `applyAutocompleteAbove`。

### 核心痛点与思辨焦点
- **痛点 A（微扩展孤岛悖论）**：如果坚持将三者作为完全独立的 npm/Git 扩展分发，`pi-safety` 作为一个底层安全基座，一旦离开 `pi-core` 就会因找不到模块而直接崩溃，违背了安全工程的 Fail-safe 原则；而如果为了独立性强行去写动态探测、全局 Symbol 注册表、自渲染 Fallback，又会凭空产生大量脆弱的运行时防御性胶水代码。
- **痛点 B（组件职责越界）**：输入框本是一个纯文本交互控件，却被强行塞入了会话全局安全状态（`Auto` 徽章）和会话累计 Token 统计，导致输入框修饰逻辑演变成了“第二状态行”。

---

## 二、 Pi 官方扩展系统的工程学事实

通过对 Pi 官方源码的深入排查，我们发现了打破僵局的关键机制事实：

### 1. 官方原生支持“复合扩展包（Suite Package）”
在 `packages/coding-agent/src/core/packages/pi-manifest.ts` 与 `packages.md` 中：
Pi 的 `package.json` 清单里的 `pi.extensions` 字段不仅支持单一入口，**原生支持显式声明多个子扩展入口**：
```json
{
  "name": "@my-org/pi-suite",
  "pi": {
    "extensions": [
      "./src/presentation/index.ts",
      "./src/safety/index.ts",
      "./src/statusline/index.ts"
    ]
  }
}
```
当安装该 Package 时，Pi 的加载器会并发或按序加载清单中的每一个子扩展，每一个子扩展独立接收自己的 `ExtensionAPI` 工厂调用。

### 2. 官方原生支持客户端细粒度投影（Resource Narrowing）
在 `packages/coding-agent/src/core/packages/discovery.ts` 中：
用户在 `settings.json` 中可以原生对一个物理 Package 内部的资源进行增减过滤：
```json
{
  "source": "npm:@my-org/pi-suite",
  "extensions": ["+src/safety/index.ts", "-src/statusline/index.ts"]
}
```
**关键工程推论**：在 Pi 官方的设计哲学中，“物理上作为一个单一包分发”与“逻辑上细粒度按需启用”完全不存在矛盾，底层早已提供了原生投影机制。

### 3. TUI 槽位的单所有者原则（Single Ownership）与封闭契约
在 `interactive-mode.ts:2772-2849` 中：
- `setFooter` / `setHeader` / `setEditorComponent` 在宿主内部均为**单槽位替换模型**，而非洋葱管道模型。
- 官方对 `EditorComponent` 设想为结构受保护的输入组件（通过 Duck-Typing 检测 `actionHandlers`、`onEscape`、`onCtrlD` 等 app 级按键分发）。官方官方示例鼓励通过 `setFooter` 展示状态，通过 `setWidget` 展示附属诊断，**从未鼓励过多个外部扩展对 Editor 进行层层嵌套的外框包装（Monkey-patching）**。

---

## 三、 第一性原则推演：四种形态的裁决

| 架构形态 | 概念内聚性 | 运行时复杂度 | 跨扩展契约成本 | 最终裁决 |
| :--- | :--- | :--- | :--- | :--- |
| **形态 1：三元孤岛分立**（`statusline` + `pi-editor` + `pi-core`） | 表面高，本质分裂（状态外显分散在两个包） | **高**（需装 3 个包，承担隐式单槽位争抢与加载顺序风险） | 需新增总线/全局符号传递统计与模式 | **否决**。“概念最纯，工程最脆”。为表面正交引入过多胶水代码。 |
| **形态 2：大泥球式合并**（全部塞进单个无边界包） | 差（职责混乱） | 低（单入口） | 无 | **否决**。破坏单一职责，安全逻辑与 UI 呈现耦合，代码迅速腐化。 |
| **形态 3：状态驱动就地装饰**（`statusline` 原地装饰 Editor） | 中（状态统一定义） | 低（单包内聚） | 零新增（闭包内直接解决） | **过渡可用**。在过渡期解决掉跨包静态 import，保持视觉现状。 |
| **形态 4：联合套件（Federated Suite）**（单包多 Entry + 共享纯函数层） | **最高**（分层与边界清晰） | **最低**（一次安装，强类型直连） | **零胶水**（同一个包内强类型 import，无脆弱动态探测） | **终极最优解**。顺应官方 Suite 规范，用户体验与工程严谨度的双重巅峰。 |

---

## 四、 终极方案：Federated Suite（Pi-Suite 联合套件）

### 1. 目录结构设计

将分散的扩展归拢为一个统一规范的联合套件（命名可为 `pi-suite` 或重塑后的 `pi-core`）：

```text
extensions/pi-suite/ (或 monorepo 根)
├── package.json
│     {
│       "name": "@earendil-ext/pi-suite",
│       "pi": {
│         "extensions": [
│           "./src/presentation/index.ts",
│           "./src/safety/index.ts",
│           "./src/statusline/index.ts"
│         ]
│       }
│     }
├── src/
│   ├── shared/                      <-- 内部共享层（纯函数/强类型，零运行时副作用）
│   │   ├── tool-rendering/          <-- Codex 风格纯渲染工厂与 Diff 框算法
│   │   ├── palette/                 <-- Catppuccin 双主题调色板与 ANSI 工具
│   │   └── usage/                   <-- 会话 Token 与 Context 用量公共计算逻辑
│   │
│   ├── presentation/                <-- 子扩展 1：交互美化与浮层核心
│   │   ├── index.ts                 <-- export default function registerPresentation(pi)
│   │   ├── autocomplete-above.ts    <-- 补全列表置顶浮层
│   │   ├── markdown-frame.ts        <-- 纯净代码块
│   │   └── builtin-tools.ts         <-- 内置工具（read/grep/find/ls）渲染美化
│   │
│   ├── safety/                      <-- 子扩展 2：权限防火墙与沙箱
│   │   ├── index.ts                 <-- export default function registerSafety(pi)
│   │   ├── sandbox/                 <-- 规则引擎与沙箱执行
│   │   ├── auto-review/             <-- LLM 裁判与模式判定
│   │   └── tools/                   <-- 接管 bash/write/edit（直接从 shared 引入渲染）
│   │
│   └── statusline/                  <-- 子扩展 3：纯粹的状态外显行
│       ├── index.ts                 <-- export default function registerStatusline(pi)
│       └── footer/                  <-- 纯 setFooter 实现（包含 Powerline、Context meter）
```

### 2. 核心设计准则

1. **共享纯函数下沉至 `src/shared/`**：
   - 工具渲染函数（`createCodexToolRendering`、`createEditDiffBox`）是纯计算和字符串排版逻辑，天然属于“共享基础设施”，直接放入 `src/shared/tool-rendering`。
   - `safety` 注册工具时，直接强类型导入 `import { createCodexToolRendering } from "../shared/tool-rendering"`。
   - **彻底告别** `../../pi-core` 偷渡式引用，也**不需要**写基于 `Symbol.for` 的动态探测机制。编译期类型安全，零运行时开销。

2. **输入框回归正交纯粹（Orthogonal Editor）**：
   - `statusline` 不再包装或触碰 `setEditorComponent`，彻底纯化为仅调用 `ctx.ui.setFooter` 的状态行。
   - 权限模式胶囊（`[Auto]` / `[YOLO]`）作为终端安全第一指示符，直接渲染在 **Footer Powerline 的最左侧第一段**。
   - 输入框恢复为原生轻量单行，由 `presentation` 子扩展透明提供补全列表置顶浮层，消灭一切关于输入框外框圆角、边框宽度、内边距对齐的脆弱几何计算。

3. **事件总线保持解耦（Decoupled Event Bus）**：
   - `safety` 通过 `pi.events.emit("pi-safety:mode", ...)` 广播安全状态。
   - `statusline` 监听此事件并更新 Footer 左侧的胶囊展示。
   - 即使未来用户通过 Pi 的资源投影排除了 `statusline`，`safety` 仍能无损工作；排除了 `safety`，`statusline` 也只是不显示该胶囊，实现天然平滑降级。

---

## 五、 实施路线图（Milestones）

- [x] **Phase 1（现状止血与轻量解耦）**：
  - 重构 `statusline`，使用 `applyBoxChrome` 就地包装替代整车类替换。
  - 彻底斩断 `statusline` 对 `pi-core` 的代码依赖，通过单测门禁防反弹。
- [ ] **Phase 2（输入框与状态行归位）**：
  - 将 `Auto`/`YOLO` 模式胶囊下沉至 `statusline` 的 Footer 最左侧。
  - 从 `statusline` 移除全部 Editor 外框包装逻辑，使 `statusline` 成为纯粹的 `setFooter` 扩展。
- [ ] **Phase 3（Federated Suite 统一归拢）**：
  - 将 Codex 工具渲染、Diff 框和调色板下沉至 `shared/`。
  - 统一 `package.json` 的 `pi.extensions` 清单配置，支持一键安装整个套件。
  - 验证基于 Pi 官方资源投影（`settings.json`）的单子扩展增删体验。
