# 扩展结构标准

> 本仓库代码结构的**验收标尺**。任何重构完成后必须满足本文判据。
>
> 标尺来源：pi 官方文档 + pi 自带 8 个扩展示例的实证（2026-10-21 研究）。
> 术语来自 codebase-design：`module` / `interface` / `implementation` / `seam` / `depth` / `adapter`。

---

## 0. 术语（本仓库统一用这些词，不替换成 component/service/API/boundary）

| 词 | 含义 |
|---|---|
| **module** | 任何有 interface 和 implementation 的东西。刻意不分规模：一个函数、一个类、一个包、一片跨层切片 |
| **interface** | 调用者正确使用该 module 必须知道的**一切**：类型签名、不变量、顺序约束、错误模式、所需配置、性能特征 |
| **implementation** | module 内部的代码体。与 **adapter** 区分：adapter 讲的是"填哪个槽"（角色），implementation 讲的是"里面是什么" |
| **seam** | 可以在不编辑该处的情况下改变行为的地方（Michael Feathers）；module 的 interface 所在的**位置**。接缝放哪是独立的设计决策 |
| **depth** | interface 上的杠杆。调用者每学一份 interface 能撬动多少行为。**深** = 小 interface 背后大量行为；**浅** = interface 和 implementation 一样复杂 |
| **leverage** | 深给调用者的回报：一份实现回本 N 个调用点、M 个测试 |
| **locality** | 深给维护者的回报：变更、缺陷、知识、验证集中在一处 |

**禁止用词**：boundary（与 DDD 限界上下文冲突）、component、service。

---

## 1. pi 官方规定了什么

只有 2 条结构规则：

1. 小扩展用单文件，多文件实现放目录（入口必须 `index.ts` / `index.js`）。
   —— `docs/extensions.md:46`
2. 不在工厂函数里起进程/socket/监听器/定时器；长资源从 `session_start` 或需要它的命令/工具里起，从幂等的 `session_shutdown` 释放。
   —— `docs/extensions.md:52-55`

### 官方**没**规定（10 条，需本仓库自行约定）

目录内部子结构、架构范式、`package.json` 扩展元数据 schema、扩展间类型/服务共享、持久化格式与迁移、单测与 Mock 规范、日志体系、错误码体系、私有配置文件命名、版本兼容声明。

> 这意味着：**本仓库的结构约定只能靠实证惯例 + 第一性原则自建**，不能声称"照 pi 的规范"。

---

## 2. pi 自己怎么做（8 样本实证）

样本：`sandbox/`、`subagent/`、`plan-mode/`、`doom-overlay/`、`permission-gate.ts`、`confirm-destructive.ts`、`protected-paths.ts`、`dynamic-tools.ts`。

### 判据表

| 维度 | 实证惯例 | 判据 |
|---|---|---|
| **拆分阈值** | 单文件 **~300-400 行**就拆 | `plan-mode/index.ts` 394 行已拆出 `utils.ts`；`subagent/index.ts` 1036 行没拆，62% 代码在 ≥3 层缩进，是全样本最差反例 |
| **拆分信号** | 单个 **>150 行的对象字面量** | 字面量内部无法用 import 隔离（subagent 的 565 行 render 卡死在这里） |
| **拆分方向** | 按**运行时关注点**横切，不按事件/功能竖切 | `doom-overlay/` 是模板：引擎 IO / 渲染 / 纯表 / 文件网络 IO，5 文件全 ≤173 行 |
| **状态分层** | 默认闭包 → 必须跨调用才模块级 `let`（写注释说明存活理由）→ 跨会话才 `pi.appendEntry` | 8 样本仅 1 例用模块级 `let`，且注明原因 |
| **硬编码双标准** | **策略常量集中、渲染常量就地** | 判据：**改这个数字是否改变行为契约**。白名单集中（`sandbox/index.ts:55`）；截断宽度就地（`subagent/index.ts:85`） |
| **默认抽出物** | 只抽**无副作用的纯策略/解析**，理由写进文件头 | `plan-mode/utils.ts:1-4`：`Extracted for testability`。策略只有 1-3 条正则时不抽（`permission-gate.ts` 34 行完整不拆） |

### 样本里**没有**的东西

独立 `constants.ts`/`config.ts` 模块、外部状态库、barrel re-export、测试文件、统一日志抽象、循环依赖、裸字符串 switch 分派（`doom-keys.ts:13-34` 是集中映射表）。

---

## 3. 第一性原则

1. **接缝放在做决策的地方，不是代码恰好在的地方。**
2. **状态归属决定文件边界。** 谁拥有可变状态，谁就是一个 module；把共享 `let` 匀给多个闭包 = 制造浅 module。
3. **一个事实只声明一次。** 同值异名（同一个 `50` 两个常量名）是一个事实声明了两遍，是接口缺陷不是风格问题。
4. **撒谎的名字比没有名字更糟。** 名实不符（体内没有 host-first 逻辑却叫 `evaluateHostFirstRulesOnly`）必须改名，且改名归类为**接口修正**而非"清理"。
5. **类型图必须是 DAG。** 出现环就是抽象错了（哪怕只是 `import type` 环）。
6. **删先于搬。** 无消费方的符号直接删，不做兼容垫片。
7. **一个 adapter 是假接缝，两个才是真接缝。** 不为"将来可能"引入 port/抽象层；只有真的有两种以上变体时才切缝。

---

## 4. 验收判据（重构完成后逐条可检查）

| # | 判据 | 阈值 |
|---|---|---|
| S1 | 单文件行数 | 主源文件 **≤400 行**；出现单个 **>150 行的对象字面量**即不合格 |
| S2 | 模块级可变状态 | 一个 module 内跨闭包共享的 `let` **≤2 个**，且每个写注释说明存活理由 |
| S3 | 入口函数体 | `export default` / `registerExtension` 之类入口只做**组装与接线**，体长 **≤120 行** |
| S4 | 类型图 | 零循环依赖（含 `import type` 环） |
| S5 | 一事实一声明 | 同值常量全局唯一；行为契约类数字（超时、上限、白名单、平台路径）**全部集中在常量区** |
| S6 | 协议字符串 | 被 `switch`/`===` 分派的字面量 union **只声明一次**，分派处用查表或类型穷举，不得用裸 `case "..."` 复刻 |
| S7 | 名实一致 | 导出符号名与体内行为一致；发现名实不符立即改名（接口修正） |
| S8 | 深度 | 每个新 module 通过**删除测试**：删掉它，复杂度是消失（= 透传，不该存在）还是散到 N 个调用者（= 值得留） |
| S9 | 接缝真实性 | 不引入只有一个 adapter 的接缝 |
| S10 | 测试面 | 测试从 interface 穿过，不测 implementation 内部；重构后必须改动的测试 = 当初测过界了，顺手删掉 |

---

## 5. 本仓库现状差距

**初测 2026-10-21；复测同日，Step 1-4 落地后。**

- `pi-core`（20 文件 1840 行，最大 377）、`statusline`（11 文件 1159 行，最大 307）**已符合**本标准。
- 问题集中在 `extensions/pi-safety/src/`：

| 判据 | 初测 | 复测 |
| --- | --- | --- |
| S1 局部性 | `registerExtension` 单函数体 2450 行、65 闭包 | **未变**（2426 行，大类切块在方案外） |
| S1 局部性 | `createEngine` 闭包 1670 行、169 个 `const`/`let` | **未变** |
| S2 收拢 | `register.ts` 15 个 `let` 被相隔上千行的闭包共同读写 | **12 个**（GuardianEvidence 4 个收进 `createGuardianEvidence()`；ActivationCache 4 个未动，见方案 §3.3） |
| S4 无环 | 2 条类型环（`engine.ts` ↔ `engine-clone.ts`/`engine-fingerprint.ts`） | **0 条**（`engine-types.ts` 承接；madge 证实） |
| S5 一事实一声明 | `15_000` / `50` / `16_000` / `/bin/bash` / PATH 各两份 | **`15_000` 已合并**、**`50` 已绑定**（执行值与展示值同源）；`16_000`/`10`/`3` 判为不同事实；`/bin/bash` 与 PATH 判为**不值得合并**——`guardian-worker.mjs` 的两处被结构测试禁止 import `.ts`（物理不可达），TS 侧两处技术上可收进 `guardian-worker-limits.mjs`，但那是协议上限模块而非可执行路径，且合完仍要新拉一条模块边，4 降 3 不抵代价 |
| S6 协议词汇集中 | 评审来源 4 值散落、`"unknown"` 两处声明 | **`ReviewSource` 具名**，`REVIEW_SOURCE_UNCLASSIFIED` 单点声明 |
| S7 名实一致 | `evaluateHostFirstRulesOnly` 体内零 host-first 逻辑 | **已改名** `evaluateDenyRulesOnly`（10 处 / 3 文件） |

**仍未达标（已记账，不在方案内）**：S1/S2/S3 的大类切块；S6 的 `PermissionErrorCode` 14 值（核验后确认 switch case 臂本就受类型检查，地毯式替换是负优化）；S5 的 `/bin/bash` 与 PATH。
