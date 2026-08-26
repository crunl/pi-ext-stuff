# Guardian policy 再对齐记录（039eb58a）

## 背景

2026-07-30 对齐调研 pin 在 `789c72d`。2026-08-26 克隆 openai/codex main（`039eb58a0ba6647fb8f29fdd35341f3f1b153728`）对比后发现上游显著漂移，于同日完成再对齐。

## 本次采纳的上游增强（安全语义）

1. **可信内容模型**（模板 Evidence Handling）：只有 user/developer 消息、`AGENTS.md`、permission-request 工具响应可建立 `user_authorization`；其余一律不可信证据，且"用户明确要求遵循某文件内容"才可将授权延伸至该内容。
2. **Post-denial 越权修复**：拒绝后再批准只能覆盖默认高风险阈值产生的 deny，**不能覆盖 critical 判定或策略显式 deny 规则**——旧本地模板允许覆盖一切 allow/deny 规则，是真实的安全回归。
3. **Exfiltration payload 回溯**："payload 必须追溯到原始数据"、"授权 egress 必须指明 payload+目的地"、"未知敏感性按 high 处理直至证明安全"。
4. **"Prior Guardian decisions are context, not precedent"**：防决策锚定。
5. **HOME 遮蔽变量 deny 规则**（破坏性命令）。
6. **Credential probing 证据阈值细化**、verified-repo 信任模型、恶意注入豁免定义。

## 本地运行时适配（刻意偏离上游的两处）

| 段落 | 上游 | 我们的版本 |
| --- | --- | --- |
| 可信内容来源之一 | `request_user_input` 工具响应 | permission-request 工具响应 |
| Execution Environment | codex 沙箱 + `sandbox_permissions=require_escalated` 升级模型 | pi+nono：OS 级沙箱（全局读/白名单写）、guardian 仅 bounded read-only tools（read/grep/find/ls），无 shell、无网络、无升级旗标 |

## 防再漂移机制

`tests/guardian-policy.test.ts` 的 drift-guard 测试钉住关键锚点：可信内容模型措辞、critical 不可覆盖条款、malicious prompt injection、bounded read-only tools、无 sandbox_permissions、无未渲染占位符、"context, not precedent"、payload 回溯、HOME 规则。未来对齐若丢失任一语义，测试会失败而非静默弱化。

## 同日裁决：filtering-proxy 保留

非遗留残留：宿主经 `HTTPS_PROXY`/`ALL_PROXY` 上游代理出网时，nono supervised proxy 无法直连网络，本地过滤代理需前置同一域名白名单链接上游。裁决理由已注释在 register.ts 升级调用点。

## 未采纳的上游演进（记录理由）

- **CyberModel 熔断特例**（连续 1 次 deny 即中断）：仅在跑 cyber 特化模型时有意义。
- **GuardianV2 fast_approval_decision 扩展钩子**：平台化演进，无对应需求。
- **node_repl_policy.md**：我们没有 Node REPL 工具面。
- **plugin attribution / GuardianAssessment UI 事件流**：宿主平台设施，超出扩展层职责。

上游 clone 保留于 `/tmp/codex`（depth=1），供后续对齐 diff 使用；过期后重新 clone 即可。
