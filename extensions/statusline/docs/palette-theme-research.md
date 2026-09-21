# Statusline 左链 palette 与 effort=off 调研

日期：2026-09-15  
范围：`extensions/statusline`（不实现，只给结论）

---

## 1. 第一性原则

1. **Powerline 左链在 latte / frappe 都要可扫读**  
   段体文字靠 `contrastTextFor`（YIQ≥128 黑字）已经能读；真正会糊的是 **半圆 cap**（U+E0B6/U+E0B4 以段色为 **fg** 画在终端默认底上）。浅底上亮黄/亮蓝 cap 几乎消失，胶囊轮廓没了，扫读变差。
2. **effort=off 不应占位**  
   “默认关”不是状态，不该占一格、也不该用绿色暗示“有值”。

---

## 2. 代码事实

### 2.1 effort=off：**已经隐藏**

| 位置 | 行为 |
|---|---|
| `src/index.ts:42-53` | `modelInfo()`：`effort: model.reasoning && level !== "off" ? level : undefined`。`thinkingLevel` 缺省时 `level ?? "off"`，同样 → `undefined` |
| `src/footer.ts:97-103` | 仅 `if (model.effort)` 才 push 段；`undefined` 时不占位 |
| `src/status-mode.ts:53-55` | `formatModelStatus` 同样 `if (info.effort)` |
| `src/model-editor.ts:52` | `SHOW_MODEL_ON_BORDER = false`，下栏纯横线，不画 model/effort |

**结论：用户看到的“off 仍挤绿色段”在当前 working tree 不成立。**  
残余风险：

- `EFFORT.off = "#08B865"`（`palette.ts:26`）仍在，是死映射；`effortColor("off")` 仍返回绿色。只要有人直接把 `"off"` 传进 `effortColor` 就会画绿段。正确入口是 `modelInfo` 已过滤。
- `modelInfo` 内联在 `index.ts`，**没有单测钉住** `level==="off"` / `!reasoning` → `effort: undefined`。已有测试只覆盖下游 `formatModelStatus` 省略段（`tests/status-mode.test.ts:35-39`），覆盖不到上游过滤。

### 2.2 Pi Theme 暴露了什么

上游 `packages/coding-agent/src/modes/interactive/theme/theme.ts`（origin/main checkout）：

| 能力 | 有无 | 位置 |
|---|---|---|
| `Theme.name` | 有（`readonly name?: string`） | `:283`，由 `themeJson.name` 注入 `:550` |
| `getFgAnsi` / `getBgAnsi` | 有 | `:355` / `:361` |
| `ThemeBg` token | `selectedBg, searchMatchBg, userMessageBg, customMessageBg, toolPendingBg, toolSuccessBg, toolErrorBg` | `:92-99`。**没有 default/baseBg** |
| 实例上 `isLight` | **无** | — |
| 模块级 `isLightTheme(name)` | 有，但只认 `name === "light"` | `:988-991`。对 `catppuccin-latte` 恒 false，**不可用** |

双主题解析（`theme-controller.ts` + `parseAutoThemeSetting` `:580-608`）：

- settings `"theme": "catppuccin-latte/catppuccin-frappe"` → light/dark 对。
- 终端 light → 加载 `catppuccin-latte`；dark → `catppuccin-frappe`。
- 切换后 live `Theme.name` 变为 `"catppuccin-latte"` 或 `"catppuccin-frappe"`，footer 每帧 `onTheme` 会拿到新对象（`footer.ts:57-75` 已每 render 重读）。

**可行的 light 探测（不靠 name）**：读 `theme.getBgAnsi("userMessageBg")`，`parseTruecolor` 后算 YIQ。

| theme | userMessageBg | 近似 hex | YIQ luma |
|---|---|---|---|
| latte | mantle | `#e6e9ef` | ~232（浅） |
| frappe | mantle | `#292c3c` | ~42（深） |

阈值取 128 即可，两端余量都很大。

### 2.3 starship 色天生成 dark-only

`palette.ts` 固定色来自 starship 左链，高饱和、偏亮，为深底设计：

`#FD4755` `#FE9738` `#FFC344` `#08B865` `#01C0FA` `#AF66DA` `#3DD6F5` `#FF79C6` `#FF92D0`

在 frappe（`#303446`）上 cap 对比很好；在 latte（`#eff1f5`）上亮黄/亮蓝 cap 对比崩掉（见下表）。

### 2.4 README 与实现不一致

`README.md:46` 仍写段色为 theme token（`mdLink` / `thinkingOff`…）。实现已改为 starship truecolor。文档需跟上。

---

## 3. 对比度估算

WCAG 相对亮度对比：`(L1+0.05)/(L2+0.05)`。  
**Cap** = 段色作 fg、终端底作 bg。**Body 文字** = `contrastTextFor` 黑/白 on 段色 bg。

背景：latte base `#eff1f5`（L≈0.88）、frappe base `#303446`（L≈0.035）。

### 3.1 当前 starship 色

| 段 | hex | contrastText | cap vs latte | cap vs frappe | body 文字 on 段色 |
|---|---|---|---|---|---|
| model | `#FD4755` | white（YIQ~127，贴阈值） | ~2.6 | ~3.6 | white ~3.4 / black ~6.2（选白略亏） |
| folder | `#FE9738` | black | ~2.0 | ~6.5 | black 优秀 |
| git | `#FFC344` | black | **~1.4** | ~8 | black 优秀 |
| session | `#AF66DA` | black | ~2.7 | ~3.2 | black 良 |
| effort low | `#06969A` | white | ~2.8 | ~3.5 | white 良 |
| effort med | `#01C0FA` | black | **~1.8** | ~5.5 | black 优秀 |
| effort high | `#3DD6F5` | black | **~1.5** | ~7 | black 优秀 |
| effort xhigh | `#FF79C6` | black | ~2.0 | ~5 | black 良 |
| effort max | `#FF92D0` | black | **~1.6** | ~6 | black 优秀 |

要点：

- **Body 在 latte 上仍可读**（黑字 on 亮段），`contrastTextFor` 够用。
- **Cap 在 latte 上大量 <3:1**（黄/蓝/青/粉尤甚），胶囊边界消失 → 扫读变差，观感“浮在浅底上”。
- frappe 上整条链无问题。
- `#FD4755` YIQ≈127 刚好落在 128 下，自动选白字，对比反而不如黑字——阈值边界个案。

### 3.2 Catppuccin latte 色（theme JSON `vars`）

`@inobit/pi-themes/themes/catppuccin-latte.json`：  
`red #d20f39` `peach #fe640b` `yellow #df8e1d` `green #40a02b` `blue #1e66f5` `sky #04a5e5` `mauve #8839ef` `pink #ea76cb` `teal #179299`

| latte 色 | cap vs `#eff1f5` | 相对 starship 同槽 |
|---|---|---|
| `#d20f39` | ~4.8 | 明显更好 |
| `#8839ef` | ~4.8 | 明显更好 |
| `#1e66f5` | ~4.3 | 远好于 `#01C0FA` |
| `#40a02b` | ~3.0 | 好于 `#08B865` |
| `#fe640b` | ~2.6 | 好于 `#FE9738` 但仍偏弱 |
| `#df8e1d` | ~2.3 | 好于 `#FFC344`（1.4）但仍偏弱 |

黄/桃色在浅底上天生难做 cap；latte 官方色已是“浅底可用”的最佳折中，仍达不到 4.5。可接受：cap 是装饰，**body 文字才是扫读主路径**，latte 色作 body bg + 黑字对比优秀。

---

## 4. 推荐方案

### 主推：**B —— 按 light/dark 切换两套映射**

| | dark（frappe） | light（latte） |
|---|---|---|
| 固定段 | 保持 starship（匹配 shell） | Catppuccin latte accents |
| effort ramp | 保持 starship 绿→青→蓝→粉 | latte `green/teal/blue/sky/pink`（避开 red/peach/yellow/mauve，不与固定段撞色） |

**light 探测**：不靠 `theme.name` 字符串，也不靠上游无用的 `isLightTheme()`。  
读 `theme.getBgAnsi("userMessageBg")` → `parseTruecolor` → YIQ ≥ 128 → light。  
拿不到 truecolor / 抛错 → 回退 dark（现状 starship），与 footer 现有 try/catch 一致。

**理由**

1. 真实问题在 latte cap 与观感，不在 body 文字；单套色无法同时服务两端。
2. 用户主题就是 latte/frappe 对，B 的收益是确定的，不是理论优化。
3. 探测用背景亮度，对任意自定义主题都成立，不绑死 catppuccin 名字。
4. dark 保留 starship = 继续对齐 shell，不破坏既有设计意图。

### 被否

| 方案 | 为何否 |
|---|---|
| **A 现状**（单套 + 仅 contrastTextFor） | body 够读，但 latte cap 大量 <3:1，轮廓糊；亮黄/亮蓝在浅 UI 上违和。A 是“能用”，不是“可扫读”。 |
| **C 固定降饱和中亮度** | 要同时打两端只能压到中间亮度，两端都变灰、丢掉 starship 身份；黄/蓝 hue 在中间亮度下仍难两头讨好。复杂度不低于 B，收益更低。 |

---

## 5. 实施计划（若做）

1. **`palette.ts`**：拆 `PL_DARK` / `PL_LIGHT`、`EFFORT_DARK` / `EFFORT_LIGHT`；`paletteFor(isLight)` 选择器。删或标注 `EFFORT.off` 为不可显示。
2. **light 探测**：小函数 `isLightThemeBg(theme)`，基于 `getBgAnsi("userMessageBg")` + 现有 `parseTruecolor`；放 `badge.ts` 或新 `theme-probe.ts`（保持可裸 node 测试）。
3. **`footer.ts`**：每 render（已有 `onTheme`）探测 isLight，传给 `truecolorFg(paletteFor(isLight).…)`。`FooterTheme` 类型补上 `getBgAnsi`。
4. **钉住 effort=off**：把 `modelInfo` 抽成纯函数（`resolveModelInfo(model, thinkingLevel)`），加测：
   - `level==="off"` → `effort: undefined`
   - `!model.reasoning` → `effort: undefined`
   - `reasoning && level==="high"` → `"high"`
5. **测试**：latte 套 cap 对 `#eff1f5` 对比 ≥ 某阈值（建议 2.0 硬底线 + 记录实际值）；两套固定段色内部不撞、effort 与固定段不撞（沿用 `palette.test.ts` 模式）。
6. **README**：段色说明改为“dark=starship / light=Catppuccin latte，按 userMessageBg 亮度切换”；注明 effort=off 不显示。
7. **editor 下栏**：`SHOW_MODEL_ON_BORDER=false` 无需改。若将来 flip 为 true，`formatModelStatus` 的 ansi 入参需走同一 palette 选择器。

---

## 6. 不做

- 不改 `contrastTextFor` 阈值（128 够用；`#FD4755` 边界个案不值得为它动全局）。
- 不引入对 `theme.name` 或 `isLightTheme()` 的依赖。
- 不把固定段改回 theme token（会失去 starship 对齐，且 token 集合不够 4 段专用 hue）。
- 不重做 powerline 字形或 cap 绘制方式（`status-mode.ts` 链逻辑保持）。
- 不在本调研里动代码。
