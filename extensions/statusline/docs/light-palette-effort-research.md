# Light（Catppuccin Latte）左链 palette 配色研究

日期：2026-09-15  
范围：**只处理 light**。dark（Frappé）已定稿，不动。  
方法：与 `dark-palette-effort-research.md` 相同的 OKLab 欧氏距离 ×100（OKΔE）。  
阈值：fixed 互距 ≥12；effort vs 相邻 fixed ≥12（可接受 ≥10）；相邻 effort 档 ≥6（有文字标签兜底）。

---

## 1. 第一性原则

左链顺序：

```
[model] [effort] [folder] [git]
```

1. **effort 只与 model、folder 相邻**，不必与 git 比距离（git 在 folder 右侧）。
2. **model 不用 error 红**（用户已抱怨 dark 的 red；对齐 dark 用 mauve）。
3. **fixed 互距**在 effort=off 时的 `model|folder|git` 上必须可分。
4. **effort 六档**冷→暖递进，且与 model、folder 都 ≥12。
5. **只用官方 Latte accent hex**。
6. **cap 对比**：浅底上 powerline cap 以段色为 fg；body 靠 `contrastTextFor` 黑字才是扫读主路径。cap <2.5 可接受（yellow/pink/rosewater 本就弱）。

---

## 2. 当前 light 实现问题

| 问题 | 证据 |
|---|---|
| model=red `#d20f39` 像 error | 与 dark 已改 mauve 不一致 |
| folder=sky `#04a5e5` 与 effort high 重复 | 撞色 |
| effort 色带未按「只邻 model/folder」设计 | rosewater/peach vs yellow 的距离是假阳性 |

---

## 3. 官方 Latte accents 与 cap 对比

cap vs Latte base `#eff1f5`：

| 色 | hex | cap |
|---|---|---|
| red | `#d20f39` | 4.80 |
| **mauve** | `#8839ef` | **4.79** |
| blue | `#1e66f5` | 4.34 |
| maroon | `#e64553` | 3.48 |
| **teal** | `#179299` | **3.31** |
| green | `#40a02b` | 2.96 |
| lavender | `#7287fd` | 2.81 |
| flamingo | `#dd7878` | 2.64 |
| peach | `#fe640b` | 2.64 |
| pink | `#ea76cb` | 2.34 |
| **yellow** | `#df8e1d` | **2.31** |

fixed 选 mauve/teal/yellow：cap 分别为 4.79 / 3.31 / 2.31。yellow cap 偏弱，但 body 黑字对比优秀，可接受。

---

## 4. 推荐 light palette（唯一方案）

### fixed（effort=off 邻接）

| 槽位 | 色名 | hex | 互距 |
|---|---|---|---|
| model | **mauve** | `#8839ef` | vs folder **28.2** |
| folder | **teal** | `#179299` | vs git **25.4** |
| git | **yellow** | `#df8e1d` | vs model **39.9** |

### effort 色带

| level | 色名 | hex | vs model | vs folder | min | 相邻档 adj |
|---|---|---|---|---|---|---|
| minimal | green | `#40a02b` | 42.5 | 15.7 | 15.7 | — |
| low | blue | `#1e66f5` | 14.5 | 20.2 | 14.5 | 35.9 |
| medium | **lavender** | `#7287fd` | 15.8 | 18.3 | 15.8 | 12.3 |
| high | flamingo | `#dd7878` | 29.8 | 23.9 | 23.9 | 24.6 |
| xhigh | peach | `#fe640b` | 38.8 | 31.1 | 31.1 | 9.9 |
| max | pink | `#ea76cb` | 23.8 | 28.3 | 23.8 | 20.5 |

语义：`green(冷) → blue(更冷) → lavender(紫·过渡) → flamingo(暖粉) → peach(暖橙) → pink(热粉·峰)`

与 dark 的差异：medium 用 **lavender** 替代 rosewater。  
原因：Latte 上 rosewater→flamingo 相邻 OKΔE 仅 **4.3**，换档会糊成同色；lavender→flamingo 为 **24.6**。

### 为何不用 sapphire 作 medium

sapphire vs folder teal 仅 **5.1**，effort 贴 folder 时会撞。

---

## 5. 被否方案

| 方案 | 为何否 |
|---|---|
| model 用 red | 像 error；与 dark mauve 不一致 |
| folder 用 sky | 与旧 effort high 重复；且 sky cap 2.47 偏弱 |
| effort medium 用 rosewater | rosewater→flamingo adj **4.3**，相邻档糊 |
| effort medium 用 sapphire | sapphire vs teal **5.1**，撞 folder |
| effort 用 peach 作 xhigh 但 high 仍 flamingo | flamingo→peach adj **4.3**，糊 |
| 与 dark 完全同色名带 | Latte 上 rosewater/flamingo 太近；必须换 medium |

---

## 6. 实施步骤

1. `src/palette.ts` → `PALETTE_LIGHT`：
   - fixed: model `#8839ef`，folder `#179299`，git `#df8e1d`
   - effort: `#40a02b` `#1e66f5` `#7287fd` `#dd7878` `#fe640b` `#ea76cb`
2. 不要动 `PALETTE_DARK`。
3. `tests/palette.test.ts` 钉住 light hex。
4. `npm test` 全绿。
5. 终端切 latte，肉眼确认 model 非红、folder 青、effort 各档可分。

---

## 7. 不做

- 不改 dark / Frappé。
- 不改 `contrastTextFor` / cap 绘制 / powerline 字形。
- 不引入非官方混色。
- 不处理 session 段（已删除）。
