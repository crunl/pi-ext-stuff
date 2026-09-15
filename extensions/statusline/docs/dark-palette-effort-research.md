# Dark（Catppuccin Frappé）左链 palette 配色研究

日期：2026-09-15  
范围：**只处理 dark**。light（Latte）后续再做。  
依据：官方 `catppuccin/palette` v1.8.0 frappe accents + 本地 `@inobit/pi-themes/.../catppuccin-frappe.json`。  
距离：OKLab 欧氏距离 ×100（下表记 OKΔE）。经验阈值：**≥12 可作 powerline 相邻；8–12 可接受；&lt;8 不可作相邻**。相邻 effort 档之间允许 ≥6（有文字标签兜底）。

---

## 1. 第一性原则

左链扫读（从左到右）：

```
effort 开：  [model] [effort] [folder] [git]
effort 关：  [model]         [folder] [git]
```

1. **fixed 互不接近**（尤其 effort 关时 model|folder 必须一眼分开）。
2. **每个 effort 色**与 **model、folder** 都同时相邻 → 必须对两者都保持距离。
3. effort 六档语义：冷静 → 兴奋（色相冷→暖，彩度低→高）。
4. 相邻 effort 档（换档时前后对比）可略近，但不可糊成同色。
5. **只用官方 accent hex**。非官方色无法与主题对齐，也难以维护。

---

## 2. 官方 Frappé accents（已核实）

| 名 | hex | OKLCH L | C | H° |
|---|---|---|---|---|
| rosewater | `#f2d5cf` | 0.90 | 0.03 | 32 |
| flamingo | `#eebebe` | 0.84 | 0.06 | 18 |
| pink | `#f4b8e4` | 0.85 | 0.09 | 336 |
| mauve | `#ca9ee6` | 0.76 | 0.11 | 312 |
| red | `#e78284` | 0.72 | 0.12 | 19 |
| maroon | `#ea999c` | 0.76 | 0.10 | 17 |
| peach | `#ef9f76` | 0.77 | 0.11 | 48 |
| yellow | `#e5c890` | 0.84 | 0.08 | 84 |
| green | `#a6d189` | 0.81 | 0.11 | 96 |
| teal | `#81c8be` | 0.78 | 0.07 | 185 |
| sky | `#99d1db` | 0.83 | 0.06 | 210 |
| sapphire | `#85c1dc` | 0.78 | 0.07 | 228 |
| blue | `#8caaee` | 0.74 | 0.10 | 266 |
| lavender | `#babbf1` | 0.81 | 0.08 | 284 |

**结构事实**：冷色（teal/sky/sapphire/blue/lavender）挤成一簇，暖色（red/maroon/flamingo/rosewater/peach）挤成一簇。  
fixed 必须从一簇各取锚点，effort 再用「簇外 + 簇边缘」；否则相邻必撞。

---

## 3. 当前实现问题表

当前 fixed（正确）：`red #e78284` / `sky #99d1db` / `yellow #e5c890`  
fixed 互距：red–sky **21.2**、red–yellow **17.1**、sky–yellow **13.3** → **effort=off 三段合格，不必动**。

当前 effort 与 fixed 的 OKΔE（`xhigh` 按官方 flamingo `#eebebe` 计；代码里 `#f2cdcd` 见下）：

| effort | hex | vs model(red) | vs folder(sky) | 相邻档 | 判定 |
|---|---|---|---|---|---|
| minimal | green `#a6d189` | 21.7 | **11.0** | →teal 8.9 | 可留 |
| low | teal `#81c8be` | 20.7 | **5.3** | →blue 12.5 | **否：撞 folder sky** |
| medium | blue `#8caaee` | 19.3 | 12.1 | →lavender 7.9 | 可留 |
| high | lavender `#babbf1` | 17.8 | **8.4** | →flamingo 16.9 | **偏险：贴 sky** |
| xhigh | `#f2cdcd`（非官方） | — | — | — | **必须改** |
| xhigh | flamingo `#eebebe` | 14.5 | 11.4 | →pink 6.1 | 官方 hex 可用 |
| max | pink `#f4b8e4` | 15.8 | 13.5 | — | 可留 |

额外事实：

- 代码 `xhigh: "#f2cdcd"` **不是** Catppuccin 任一 accent（官方 flamingo=`#eebebe`，rosewater=`#f2d5cf`）。
- 官方 flamingo vs red = **14.5** → 用户担心的「flamingo 撞 model 红」在 **官方 hex 下不成立**；真正撞的是 teal↔sky。
- peach/maroon vs red 仅 **8.1 / 5.4** → 暖色末端若用 peach/maroon 会复现「model-红撞邻段」老问题。

---

## 4. 推荐 dark palette（唯一方案）

**fixed 三段保持不动**（已是稳定锚点，且互距合格）。  
**只重排 effort**：丢掉 teal（贴 sky）、降级 lavender（贴 sky）、修正 xhigh hex，补入 mauve / rosewater。

| 槽位 | 色名 | hex | 说明 |
|---|---|---|---|
| fixed.model | red | `#e78284` | 不变 |
| fixed.folder | sky | `#99d1db` | 不变（相对 red 已足够远） |
| fixed.git | yellow | `#e5c890` | 不变 |
| effort.minimal | green | `#a6d189` | 冷静/绿灯 |
| effort.low | blue | `#8caaee` | 替换 teal；冷 |
| effort.medium | rosewater | `#f2d5cf` | 官方 hex；开始回暖、低彩度 |
| effort.high | flamingo | `#eebebe` | 官方 hex（替换错误 `#f2cdcd`） |
| effort.xhigh | mauve | `#ca9ee6` | 官方 thinkingHigh 同色；紫=高强度 |
| effort.max | pink | `#f4b8e4` | 峰值热粉；距 red 15.8，可作 max |

### 推荐色带距离

**每个 effort vs model(red) / folder(sky)**（必须都 ≥12）：

| effort | vs red | vs sky | min |
|---|---|---|---|
| green | 21.7 | 11.0 | 11.0 |
| blue | 19.3 | 12.1 | 12.1 |
| rosewater | 20.0 | 11.6 | 11.6 |
| flamingo | 14.5 | 11.4 | 11.4 |
| mauve | 14.0 | 14.9 | 14.0 |
| pink | 15.8 | 13.5 | 13.5 |

**effort 相邻档**：

| 相邻 | OKΔE | 判定 |
|---|---|---|
| green→blue | 20.6 | 优 |
| blue→rosewater | 19.9 | 优 |
| rosewater→flamingo | **5.6** | 弱（全方案唯一短板，靠标签+明度差） |
| flamingo→mauve | 12.9 | 优 |
| mauve→pink | 9.7 | 可 |

**最接近 fixed 的 effort 档**：`minimal green` vs `folder sky` = **11.0**。  
可接受：Frappé green 为黄绿（H=96°）对 sky 青（H=210°），终端里色相一眼可分；OKLCH 上 L/C 接近才把距离压到 11。

### 语义递进

```
green(冷) → blue(更冷) → rosewater(暖·淡) → flamingo(暖·粉) → mauve(紫·烈) → pink(热粉·峰)
```

冷→暖 + 彩度抬升；与 Catppuccin 官方 thinking 色（low=sky/blue，high=mauve，max=暖色）方向一致。

---

## 5. 被否方案

| 方案 | 为何否 |
|---|---|
| 保留 effort.low=teal | vs folder sky **5.3**，相邻 powerline 糊成一片 |
| 保留 effort.high=lavender | vs sky **8.4**，偏险 |
| xhigh 用 peach 或 maroon | vs model red 仅 **8.1 / 5.4**，复现「红撞邻段」 |
| xhigh 继续 `#f2cdcd` | 非官方 accent |
| folder 改 sapphire / blue | 与 teal/sky/blue 簇内互撞（sapphire–blue 7.5），effort 冷端更挤 |
| model 改 mauve、effort 末端用 red | 可行（red–mauve 14.0），但换掉已稳定的 model 身份，收益只是把 max 从 pink 换成 red；**不值** |
| model 改 maroon | vs red 家族更近，且不解决 effort 空间 |
| fixed 改成 mauve/teal/yellow 三色辐射 | 互距漂亮，但 effort 只剩暖色簇，六档连续距离普遍 &lt;6，递进更差 |
| 复用 official thinking 全套（含 peach、red 作 xhigh/max） | 与 model=red 相邻不可接受 |

---

## 6. 实施步骤（只改 dark）

1. **`src/palette.ts` → `PALETTE_DARK.effort`**  
   - `low`: `#81c8be` → `#8caaee`  
   - `medium`: `#8caaee` → `#f2d5cf`  
   - `high`: `#babbf1` → `#eebebe`  
   - `xhigh`: `#f2cdcd` → `#ca9ee6`  
   - `max` / `minimal` / fixed 不动  
   - 顺手改文件头注释：删掉「folder sky 在 high 复用」等过时描述，写明 dark effort 色带为 green→blue→rosewater→flamingo→mauve→pink。
2. **不要动 `PALETTE_LIGHT`**。
3. **`tests/palette.test.ts`** 钉住：
   - dark 六档 effort + 三 fixed 的 hex（按上表）。
   - 保留「effort hex 不与 fixed 重合」。
   - 可选加：任意 effort 对 model/folder 的 OKΔE ≥ 10（把 green–sky=11.0 写进基线）。
4. 全量跑该扩展现有 node test。
5. 终端肉眼：frappe 下切 effort=low（蓝贴 sky）、high（flamingo 贴红 model），确认扫读。

---

## 7. 不做

- 不改 light/Latte。
- 不改 fixed 三段 hex。
- 不改 `contrastTextFor` / cap 绘制 / powerline 字形。
- 不引入非官方混色。
- 不在本调研里改代码（本文档即交付）。
