# pi-ext-stuff

> 中文说明（看图版） · English: [`README.md`](README.md)

四个 pi coding agent 扩展，住在一个仓库里，但能各自独立加载。
全是 `.ts` 源码 —— pi 直接读，**不用构建**。

---

## 四个扩展，一眼看懂

- 🎨 **pi-core** —— 给工具输出化妆：好看、省字、带实时 token 速率
- 🛡️ **pi-safety** —— 看门人：危险命令先过沙箱 + AI 裁判
- 📊 **statusline** —— 底部状态条：模型 / 用量 / 分支
- ✂️ **tool-result-budget** —— 给每轮工具输出限重，超了就存文件

| 扩展 | 一句话 | 目录 |
|---|---|---|
| **pi-core** | Codex 风格工具呈现、实时 token 速率、edit-diff 预览、TUI 打磨 | [`extensions/pi-core`](extensions/pi-core) |
| **pi-safety** | 权限模式（`auto` / `yolo`）+ 沙箱执行 + guardian 裁判 | [`extensions/pi-safety`](extensions/pi-safety) |
| **statusline** | 方框编辑器框，带 token / 模型 / effort 信息 | [`extensions/statusline`](extensions/statusline) |
| **tool-result-budget** | 每轮工具输出限重，超出部分落到 spill 文件 | [`extensions/tool-result-budget`](extensions/tool-result-budget) |

每个扩展的 README 讲安装、配置、用法 —— 从那里开始。

---

## 它们怎么连

```
        pi-core          ← 地基，只出不进（没人 import 它）
           │
           │  standalone.ts
           │
     ┌─────┴─────┐
     ▼           ▼
 pi-safety    statusline
     │           ▲
     └───────────┘
      mode / review（事件总线）

 tool-result-budget      自成一岛，不 import 任何包
```

一句话：**pi-core 是地基**，pi-safety 和 statusline 站在它上面；
pi-safety 把权限模式通过事件总线告诉 statusline。
tool-result-budget 谁都不依赖。

---

## 安装

```bash
pi install ~/path/to/pi-ext-stuff/extensions/pi-core
pi install ~/path/to/pi-ext-stuff/extensions/pi-safety
pi install ~/path/to/pi-ext-stuff/extensions/statusline
pi install ~/path/to/pi-ext-stuff/extensions/tool-result-budget
```

四个坑，先知道：

- ✗ 不能当 git 包装 —— 不支持子目录，只能用本地路径
- ✗ 还没发 npm —— 全是 `private`
- ✗ 别装两遍 —— symlink + settings 条目 = 加载两次
- ✓ 从 `pi-permissions` 升级？看 [`pi-safety` 迁移说明](extensions/pi-safety/README.zh-CN.md#从-pi-permissions-迁移2026-年-9-月更名)

---

## 附带的 append-prompt

[`APPEND_SYSTEM.md`](APPEND_SYSTEM.md) 是这台机器的全局 pi append-prompt，
在这里做版本管理（home 目录那份是指向本文件的 symlink）。

`main` 分支就是这个 monorepo。
tag `pre-monorepo-pi-core` 保存了 pi-core 合并成 monorepo 之前的单包历史。
