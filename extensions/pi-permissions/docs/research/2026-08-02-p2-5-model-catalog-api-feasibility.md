# P2-5 model catalog API 与 Codex review-model 元数据可行性研究

日期：2026-08-02

## 结论摘要

P2-5 可行，但当前 Pi API 还不能做“第一方、类型安全、完整”的 Codex
review-model parity。Codex 的两个输入来自不同层：

1. `auto_review_model_override` 是 `/models` 返回的单个 model metadata；
2. provider preferred review model 是 provider runtime 的策略方法。

当前已安装的 `@earendil-works/pi-ai@0.82.1` / `@earendil-works/pi-coding-agent@0.82.1`
分别缺少这两个公开契约。Pi 的 `ModelRegistry` 能查 model 和 provider，但
`Model` 没有 review override 字段，`Provider` 没有 preferred-review 方法。

因此现在不应该把未知字段硬塞进 `Model` 类型、修改 `node_modules`，或把一个
extension 私有映射称作 Pi catalog parity。推荐先定义一个兼容边界：保留当前
已配置 reviewer 的优先级；在 reviewer 未配置或不可用时，读取未来 Pi catalog
提供的可选 metadata；metadata 不存在或不可用时继续回退 active model。要做到
Codex 的第一方 parity，最终仍需要 pi-ai/pi-coding-agent 上游 API 与 catalog
数据链路一起扩展。

## 已核对的 Pi API

本地依赖版本：

```text
@earendil-works/pi-ai       0.82.1
@earendil-works/pi-coding-agent 0.82.1
```

### ModelRegistry 能力

`ModelRegistry` 对 extension 暴露了 `find(provider, modelId)`、
`getAll()`、`getAvailable()`、`getApiKeyAndHeaders(model)`，也暴露了
`getProvider(provider)`。但是声明中没有 model metadata accessor 或
preferred-review accessor：

- [model-registry.d.ts](../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts#L19-L41)
- 当前 Guardian 只把 `find`、`getApiKeyAndHeaders` 注入
  [auto-reviewer.ts](../../src/auto-reviewer.ts#L30-L38)
- 当前选择逻辑在 [guardian-model.ts](../../src/guardian-model.ts#L48-L63)：
  configured reviewer 可用时使用它，否则回退 active model。

不建议绕过 `ModelRegistry` 直接依赖内部 `ModelRuntime`：前者的
`getApiKeyAndHeaders()` 返回带 `ok` 的 `ResolvedRequestAuth`，后者的
`getAuth()` 返回 `AuthResult | undefined`；这两个 API 需要显式 adapter，不能
直接替换。

### Pi Model / Provider 类型

Pi `Model` 只有执行相关字段：`id`、`name`、`api`、`provider`、URL、reasoning、
输入、计费、context window、tokens、headers 和 compat；没有
`autoReviewModelOverride`（或 snake_case 对应字段）：

- [pi-ai types.d.ts](../../node_modules/@earendil-works/pi-ai/dist/types.d.ts#L637-L656)

Pi `Provider` 只有 id/name/base/auth、model listing、refresh/filter 和 stream
行为；没有 Codex 的 `approval_review_preferred_model()` 等价物：

- [pi-ai models.d.ts](../../node_modules/@earendil-works/pi-ai/dist/models.d.ts#L42-L76)
- `Models` 只提供 `getProvider()`、`getModel()`、catalog refresh 和 auth：
  [pi-ai models.d.ts](../../node_modules/@earendil-works/pi-ai/dist/models.d.ts#L82-L114)

### Pi catalog 的几个实际边界

1. 内置 `openai-codex` catalog 目前只有运行所需字段，没有
   `auto_review_model_override`。
2. `ModelsStoreEntry` 只把 `models: readonly Model<Api>[]` 与
   `lastModified/checkedAt/etag` 作为公开持久化契约：
   [models-store.d.ts](../../node_modules/@earendil-works/pi-ai/dist/models-store.d.ts#L2-L24)
3. 动态远端 catalog 的 JS parser 会用 `{ ...model, provider }` 透传未知 JSON
   字段，因此运行时的动态 model 对象可能偶然带有未来字段：
   [remote-catalog-provider.js](../../node_modules/@earendil-works/pi-coding-agent/dist/core/remote-catalog-provider.js#L16-L29)
   但这不构成 TypeScript API 契约，也没有 provider-level preferred model。
4. `models.json` 自定义 model 虽然 schema validator 对额外 JSON key 不会立即
   拒绝，但 composer 的 `modelFromJson()` 会按已知字段重建对象，未知的
   `auto_review_model_override` 会被丢弃：
   [model-config.js](../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js#L131-L177)
   与 [provider-composer.js](../../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js#L45-L73)。
5. extension provider 的内部 `applyExtension()` 使用 spread，技术上可以让
   未声明字段在运行时存活，但 `ProviderConfigInput.models` 的公开类型没有该
   字段；这属于未承诺的 duck typing，不适合作为通用 catalog 方案。

## Codex 当前契约与选择行为

通过 `gh api repos/openai/codex/commits/main` 核对，当前 main 为
`1e85ca099e4265bf89f4016772d299816e231bb3`（2026-08-01）。本地
`/private/tmp/codex-current` 为 `ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff`；
`gh api repos/openai/codex/compare/<local>...<main>` 显示两者之间的提交没有
修改下面列出的 model/provider/guardian 文件，因此本地源码行号对应当前 main。

### 单个 model 的 override

Codex `ModelInfo` 是 backend `/models` 的 metadata，字段
`auto_review_model_override: Option<String>` 位于该结构中：

- [protocol/src/openai_models.rs](https://github.com/openai/codex/blob/1e85ca099e4265bf89f4016772d299816e231bb3/codex-rs/protocol/src/openai_models.rs#L368-L452)

Guardian 选择时先取 provider default，再取 active model 的 override；override
优先于 provider default：

- [core/src/guardian/review.rs](https://github.com/openai/codex/blob/1e85ca099e4265bf89f4016772d299816e231bb3/codex-rs/core/src/guardian/review.rs#L728-L783)

如果选中的 review model 在当前 catalog 中，Codex 优先使用该 model 支持的
`low` reasoning；如果 catalog 找不到选中 model，则按 Codex 当前分支使用
parent model 的 reasoning，并把 override（若存在）或 parent slug 作为最终
guardian model id。这个 fallback 细节需要在实现时单独写回归测试。

这也暴露出当前 Pi 的另一个 parity 差异：Pi 在未显式配置
`reviewer.reasoningEffort` 时固定使用 `medium`，见
[auto-reviewer.ts](../../src/auto-reviewer.ts#L320-L333)；Codex 则先检查所选
review catalog model 是否支持 `low`，支持时使用 `low`，否则使用该 model 的
默认 reasoning。

### provider preferred review model

Codex 的 provider trait 定义了默认的
`DEFAULT_APPROVAL_REVIEW_PREFERRED_MODEL = "codex-auto-review"` 和
`approval_review_preferred_model()`；需要 backend-specific id 的 provider 可以
override。当前 Amazon Bedrock provider 就 override 为 Bedrock 的 `gpt-5.4`：

- [model-provider/src/provider.rs](https://github.com/openai/codex/blob/1e85ca099e4265bf89f4016772d299816e231bb3/codex-rs/model-provider/src/provider.rs#L65-L115)
- [model-provider/src/amazon_bedrock/mod.rs](https://github.com/openai/codex/blob/1e85ca099e4265bf89f4016772d299816e231bb3/codex-rs/model-provider/src/amazon_bedrock/mod.rs#L123-L137)

Guardian 从 provider runtime 读取这个 default，再和 available catalog 比较：

- [core/src/guardian/review.rs](https://github.com/openai/codex/blob/1e85ca099e4265bf89f4016772d299816e231bb3/codex-rs/core/src/guardian/review.rs#L732-L757)

所以它不是“从 model JSON 推导 provider 默认值”，而是 provider 自己拥有的
行为策略。

## 可行性矩阵

| 目标 | 当前 Pi 直接支持 | 只改 pi-permissions | 完整 parity 所需 |
| --- | --- | --- | --- |
| 读取 model override | 无类型字段；动态 catalog 可能偶然透传 | 可对 `getAll()` 结果做 feature detection，但不是稳定契约 | pi-ai `Model`、builtin/remote catalog、models-store 和 composer 都保留可选字段 |
| provider preferred review model | `getProvider()` 可查 provider，但 `Provider` 无该策略 | 只能 sidecar mapping 或 duck typing | pi-ai `Provider` 增加可选 metadata/method，builtin/provider factory 提供值 |
| Codex fallback/low reasoning | 现有 reviewer→active fallback 可用，但默认 reasoning 是 `medium` | 可以新增一层 metadata resolver，但需明确 configured reviewer 优先级和 reasoning 选择 | catalog 元数据与 model capability 都需进入同一 resolver |
| 用户自定义 models.json | extra key 会在 composer 重建时丢失 | 不能可靠作为 metadata 注入点 | 扩展 models.json schema、类型和 composer whitelist |

## 实施选项

### 选项 A：上游 API first（推荐）

在 pi-ai/pi-coding-agent 增加向后兼容的可选字段/方法，例如：

- `Model.autoReviewModelOverride?: string`；
- `Provider.approvalReviewPreferredModel?: string`（或等价的
  `getApprovalReviewPreferredModel()`）；
- 让 builtin catalog、remote catalog、`ModelsStore` 和 `models.json` custom
  model pipeline 统一保留这些字段；
- `ModelRegistry` 增加一个面向 Guardian 的 metadata accessor，避免 extension
  依赖内部 `ModelRuntime`。

优点是契约清晰、可测试、动态和静态 catalog 行为一致，能真正对齐 Codex。代价
是需要 pi-ai 与 pi-coding-agent 的上游变更和版本门槛；在新版本发布前，
pi-permissions 只能保留兼容 fallback。

### 选项 B：extension duck typing + sidecar mapping

让 pi-permissions 对 model/provider 做运行时可选字段探测；同时用 extension
自己的配置保存 provider preferred model mapping。

优点是无需等待 Pi 发布，可以立即覆盖特定环境。代价是 sidecar 会和 Pi/Codex
catalog 漂移，用户无法把它当作 Pi 默认 catalog；还会引入 provider/model id
复制和配置迁移问题，不建议作为“对齐完成”的实现。

### 选项 C：只做前向兼容 adapter

现在只增加一个内部 resolver 边界：若未来 `Model` 对象存在可验证的
`autoReviewModelOverride`，且 `ModelRegistry.getProvider()` 返回明确的
preferred-review metadata，就消费它；当前字段不存在时完全保持现有
configured reviewer→active fallback 行为。

这可以先把 P2-5 的选择顺序、auth 检查和测试边界固定下来，风险最小，但在当前
Pi 版本上不会产生新的默认 model 行为，不能单独宣称完成 Codex parity。

## 推荐结论与下一步

推荐采用 A + C：

1. pi-permissions 下一步先实现一个小的 metadata adapter/selection boundary，
   保持现有 configured reviewer 优先；reviewer 缺失或不可用时才尝试 Codex
   metadata；metadata 缺失、model 不存在或 auth 不可用时继续 active fallback。
2. 同时把所需的两个可选字段作为 pi-ai/pi-coding-agent 上游 API 需求记录，
   不通过 `node_modules` 或未声明的 JSON extra key 伪造完成度。
3. 上游 API 发布后，再启用静态/远端 catalog 的真实字段，并补齐 override、
   provider preferred、catalog 缺失、auth 缺失及 low-reasoning fallback 测试。

这一路线不会把 Guardian 变得比 Codex 更严格，也不会改变当前用户显式 reviewer
的优先级。它把 P2-5 的真实 blocker 定位为 Pi host/model-registry contract，
而不是 pi-permissions 内部 Guardian 逻辑本身。

## 验证记录

```text
node -e '读取 @earendil-works/pi-ai/package.json 与 @earendil-works/pi-coding-agent/package.json'
gh api repos/openai/codex/commits/main --jq '.sha + "\t" + .commit.committer.date'
gh api repos/openai/codex/compare/ee0247f...1e85ca0 --jq '.files[].filename'
rg -n --glob '!target/**' --glob '!*.lock' --glob '!*.map' \
  'auto_review_model_override|approval_review_preferred_model' /private/tmp/codex-current/codex-rs
npm run check
npm test -- tests/register.test.ts
```

本次研究未修改实现代码，也未提交 commit。工作区中已有的其它文档改动保持不动。
