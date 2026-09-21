# Native Proxy + Lease Spawn Gate（SRT 0.0.77 去 patch）

## Scope

- Date: 2026-09-19
- Standing Codex pin: `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
- Upstream SRT: `anthropics/sandbox-runtime` / npm `@anthropic-ai/sandbox-runtime`
- Target pin: **0.0.77**（pristine，**无** `network.mode` / `getNetworkModeCapabilities`）
- Pi host pin: `@earendil-works/pi-coding-agent@0.85.1`（本扩展 pin SRT；host 不 pin 同包）
- Question: 减 patch、开箱优先时，升级 + 网络审批落点的最优雅调整
- This note records design + implementation intent. Acceptance is separate
  (`preflight:sibling` + `check` + `lint` + `test`); dirty sibling ⇒ provisional.
- What this note does **not** claim: live OS whole-open on pristine SRT;
  that Guardian is a network firewall; that foreign tools are sandboxed.

## Product decisions

1. Upgrade `@anthropic-ai/sandbox-runtime` **0.0.74 → 0.0.77**（exact pin）。
2. **删除** pnpm `patchedDependencies` 与 `patches/anthropic-ai__sandbox-runtime@0.0.74.patch`
   及 `patches/srt-network-mode/**`（产品验收面）。
3. 主方案：**Native Proxy + Lease Spawn Gate**
   - SRT 职责：原生 **FS** + domain allow/deny + **parentProxy / ask callback** 缝。
   - pi-permissions：静态 HARD → Engine lease/`requestCovered` →（residual）Guardian
     → owned bash spawn gate → SRT 执行。
   - **Uncovered network → fail-closed `permission-required`**；**不**再
     `runReview(source:"inline")` 当网络放行。
   - **Guardian 不当网络防火墙**。
4. **KEEP connect-guard + NetworkBoundary**：建立在 **原生 parentProxy + 空
   allowedDomains + ticket** 上；职责 = DNS 冻结 + one-shot ticket，**不是** OS mode。
5. `sandbox.network.access` / `macosTls:"system"` 的 **OS mode 投影退役**；
   `network_access` 保留为 **Engine lease** 语义。
6. Host-first B / foreign A / yolo / owned residual fail-closed **不变**。
7. `carderne/pi-sandbox` 是另一 Pi 扩展（人审 + fork 包），**不是**本方案对象。

## First principles

```text
SRT 0.0.77 pristine              pi-permissions
───────────────────              ──────────────────────────
OS FS policy                     静态 HARD / rules deny
domain allow/deny (native)       Engine 账本 lease / requestCovered
parentProxy + ask 缝（原生）      residual Guardian（动作审，非防火墙）
violation 诊断（非授权证据）      spawn gate：无 covered lease 不放行
                                 connect-guard tickets + NetworkBoundary
```

**`network_access:true` = lease + proxy-mediated egress**，  
**≠** Codex Enabled 的 OS direct whole-open。

## Implementation map

| Area | Change |
| --- | --- |
| `package.json` / lock | SRT **0.0.77**；无 patch_hash |
| `pnpm-workspace.yaml` | 删除 `patchedDependencies` |
| `patches/**` | 删除 network-mode patch 与 harness |
| `src/sandbox/srt-enforcer.ts` | 删除 `getNetworkModeCapabilities` / `executionNetworkMode` / wrap `network.mode`；保留 empty allowlist + parentProxy + askNetwork + ticket |
| `src/guardian-worker.mjs` | 删除 capabilities/mode；原生零网 allowlist |
| `src/approve-for-me-engine.ts` | uncovered network → **仅** `permission-required`（无 inline LLM） |
| `src/sandbox-policy.ts` | `projectExecutionNetwork` = 账本投影；非 OS mode |
| tests | patch 正向合同 → **负向** pristine 合同；inline 网络审用例退役 |
| AGENTS / host-api-boundaries | 0.0.77 pristine + lease spawn gate 叙述 |

## Supersession

- **部分 supersede** `2026-09-12-network-access-whole-open.md`：`network_access`
  名与 lease 语义保留；「OS whole-open / connect-guard 对齐 Codex Enabled-direct」
  在 **pristine SRT** 上不成立。
- **部分 supersede** `2026-09-19-p0-skip-llm-first-principles.md` 中
  「inline network uncovered → Guardian」作为网络放行通道：改为
  **lease 覆盖才放行，否则 fail-closed**。owned residual 框架仍有效。
- `2026-09-19-owned-tools-only-chain-cut.md`：三通道与 connect-guard KEEP
  **保持**；connect-guard 定位改为 **原生 parentProxy 上的 ticket/DNS 缝**。

## Follow-up (same day): enableWeakerNetworkIsolation

Product A (post-B): when connect-guard **parentProxy** is live
(`parentProxyUrl` after `start()`), initialize and wrap pass the **native**
SRT field `enableWeakerNetworkIsolation: true` (not `network.mode`).
Rationale: Go TLS (`gh`) requires trustd inside seatbelt; otherwise
`x509 OSStatus` / `security`/`sysctl` denials. Clash TUN is a parallel
routing/DNS layer, not the primary TLS failure cause.

**Security honesty (do not misread):**

- This is a **product default downgrade** from SRT native `false`; trustd
  **helper-mediated egress** is accepted (Anthropic SRT security warning).
- **`gh` working under Clash TUN ≠ isolation equivalence or “safer OS network.”**
- Unstarted guards inject nothing; Guardian worker never gets this field.
- Authorization remains **lease + ticket + empty allowlist + fail-closed**;
  weaker isolation does not grant arbitrary sockets.
- Decision B (no mode patch) unchanged. Long-term contract: **AGENTS.md +
  upstream SRT README**; this note is design history only.

## Product honesty（必须写进边界文档）

1. `network_access:true` 不是 OS 整网直连；是 **Engine lease + parentProxy/ticket**。
2. SRT **无** `network.mode`；direct/restricted/proxy OS 强制主张无效。
3. 无 covered lease 的网络尝试 **fail-closed**；Guardian 不做连接防火墙。
4. connect-guard 删除后不会 magically 获得 OS mode，只会失去票证与重绑定防护。

## What we deliberately did not cut

Owned4 全链、host-first B、foreign A、yolo、residual fail-closed、
connect-guard、NetworkBoundary、deniedDomains veto、delegation network pin、
SRT poison/coordinator、`requestCovered` 账本。
