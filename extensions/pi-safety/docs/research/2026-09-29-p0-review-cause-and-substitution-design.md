# P0 第一性设计：review-cause 分类学 与 substitution 的「只证危险」递归

Date: 2026-09-29
Standing upstream pin: `openai/codex` @ `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
Day-of snapshot for `fx` citations: `vercel-labs/fx` @ `759001b3`
Design only — 本 note 不改 `src/**`、不跑验收。来源：两个只读研究子代理的
file:line 盘点 + 实测（临时脚本已删），加上 `2026-09-29-static-review-rate-ordinary-work.md`。

## 0. 两条改动共享的第一性公理（全部来自仓内既有教义，非新造）

1. **skip 是挣来的**（09-19 P0 原则 2；`residual.ts:66` "never a skip credential"；
   engine 测试 :1230 钉「标签不影响授权」）→ cause 与 recursion 的产物都**只能是观测或
   更严的判决**，永远不能成为放行凭证。
2. **命名机制不命名结果**。`risk_not_low` 改名事故（09-25 vocabulary note :131-138 +
   `tests/permissions-residual.test.ts:40-46`）证明：编码了 disposition 的 tag 会在下次
   改名时说谎。cause 词汇因此只命名「哪个证明失败了」。
3. **descent 只证危险，不证安全**。codex pin 原文（09-24 note :11 已引）：literal 解析
   "suitable for identifying dangerous literal commands, **but must not be used to prove
   that a command is safe**"。仓内同构物：09-25「unreadable means review」、2^N 文法算术
   教训。→ substitution 的递归**只能把 NeedsApproval 升成 Forbidden**，不能反向。
4. **规则钉机制不钉拼写**（09-25）。inert/active 是机制，`$(` 拼写不是。
5. **单一事实源**。仓史反复消灭重复谓词（ed60592 四合一、e7dc3ee 删死分支）→ cause 在
   **折叠点**记录，递归复用 `scanShellSyntax` 的状态机，不开第二词法器。

## 1. P0-1：review-cause = 折叠点记录 + residual 共标（不换桶、不加管道）

### 1.1 现状事实（研究 A，全部 file:line 已核）

- 原因丢失点：`risk.ts:253` `return decomposable ? "Skip" : "NeedsApproval"` 一个三元；
  `decomposable` 在 `shell-segment.ts:806-818` 把 ≥9 个独立成因折成一个布尔；
  `shellStateCrossesSegments` 把 cd 迁移与 setter 折进同一个 `some()`。
- 唯一活到 residual 层的成因布尔是 `writeOutsideRoots`（`risk-policy.ts:447→:508`）
  ——本设计是它的推广。
- `action_review` 的语义其实是**审查类型**（`reportedRisk!=="Skip" && 无 write roots &&
  无 escalation`，:509-510），与 capability 相对；它不是原因。类型轴保留。
- residual 全链路已有：`residualsForPrompt` → `RiskDecision.residuals` → AdmissionPlan →
  Engine `normalizeResidualSignals` 闭集校验（:811，未知值 `policy-denied`）→ metrics
  `residual_signals` **原样透传**（`metrics.ts:200-202`，schema 1 additive 先例 :86 测试名
  "keeps additive ... schema-compatible"）。**没有任何治理代码读具体值**（逐值 grep；
  唯一值级读取是 `pi-safety.ts:171` 的去重）。
- 先例 `unprovenGitReason`（`git-network.ts:408-419`）内部有 `{kind,reason}` 结构，
  往下只传自由文本 → 教训：**成因要有 code，文本只给人看**。
- 三个孤儿值（`rule_deny`/`capability_uncovered`/`inline_network_uncovered`）无生产者，
  **禁止挪用**（inline network 已退役为 permission-required block）。

### 1.2 方案

**cause 在折叠点产生，经 residual 闭集共标走已有管道，metrics 零改动。**

1. `CommandSegment` 新增可选字段 `unprovenCause?: "lex_incomplete" | "wrapper_unreduced"
   | "nested_git_program" | "command_word_unproven" | "program_reinterpreted"
   | "substitution_unproven" | "heredoc_unproven"`：`parseCommandSegment` 的 :806-818
   短路链本来就是逐条求值的——把第一个失败条款记下来即可，折叠点自己记录自己折了什么。
   不允许在别处事后重推导（会与 decomposable 漂移）。
2. `classifyRisk` 保持公开签名，新增 `classifyRiskWithCause` 返回
   `{ disposition, cause: ReviewCause | undefined }`。tier 决策点命名各 cause：
   - tier 2 → `process_control`（kill 系）/ `env_context_unproven`
     （`executableContextUntrusted`，GIT_*/EDITOR 类）；
   - tier 3 gate 的四个合取子式失败者各自命名：`substitution_unproven`、
     `state_crosses_segments`（export/目录迁移/未折叠 cd）、`remote_effect_unclassified`
     （裸 npm/pnpm/yarn/bun）；段级失败取该段的 `unprovenCause`。
   - Skip 的 cause 恒 `undefined`（allow 不带 residual 的现有不变量
     `tests/risk-policy.test.ts:2459/:2466` 不动）。
3. `residual.ts` 扩 10 值（上述机制名，snake_case，随现有风格），`causeToResidual` 为
   **穷尽 switch**——新增 classifyRisk 出口漏发 cause 时编译期/表驱动不变量测试即红。
   `action_review` 继续打（类型轴），cause 紧随其后追加，**push 顺序固定**并被测试钉住
   （`permissions-residual.test.ts:72` 本就顺序敏感；`fingerprintValue` 对数组不排序，
   approval-cache 键含顺序，`policy-primitives.ts:158-159`）。
4. 未知/未映射 cause 一律落 `other_explicit_review`（观测 miss 方向无害，禁止造第二桶）。
5. **Guardian packet 输入面不动**：`staticReason` 保持 `${risk} operation`。cause 是
   「我们的过程标签」不是「动作自身的风险证据」，喂给 risk-judge 会反向 nude 判决
   （研究 A 风险 5.3.3）。这条克制写进 residual.ts 头注释。

### 1.3 明确不做

- 不开平行 `reviewReasonCode` 字段：七层透传（研究 A §5.3.1）+ 只有 residual 通道有
  Engine 闭集校验；平行词表必然漂移（`review_source` vs `residualSignalsForReviewSource`
  已是双词表错配先例，:75-78 注释自证）。
- 不 bump metrics schema（additive array-member 先例；本 note 即时间序列断点的日期标记，
  正是 09-25 事故中被批评缺失的那块记录）。
- 不替换 `action_review`（拆桶=静默改名是 09-25 的批评对象；共标保旧查询存活）。

### 1.4 必改测试（研究 A 清单）

`permissions-residual.test.ts:16`（全枚举）、`:72`（顺序 toEqual）；
`approve-for-me-engine.test.ts:1127`（stamps toEqual）；
`pi-approve-for-me-adapters.test.ts:141/:166/:184/:512`；metrics golden 行加性兼容。
新增：cause 穷尽性表测试（每个 classifyRisk 出口一个输入→cause 断言，10 桶各≥1）；
「双 cause 同动作」顺序确定性测试。

## 2. P0-2：substitution——先修正前提，再只证危险

### 2.1 研究 B 的实测对 09-24 G2 的修正（重要，先于设计）

G2 的成文表述（"`isDangerousSegment` 只见 echo"）**在撕碎形态下不成立**：
`echo $(rm -rf /)` 与 `bash -lc 'echo $(rm -rf /)'` 实测**已经 Forbidden**——
`splitShellSegments` 在裸 `(`/`)` 上切分，内层文本恰好成为独立 segment 被危险层看见。
真正的洞是**引号内形态**（实测 NeedsApproval，rm 永不成段）：

```
echo "$(rm -rf /)"            ← 双引号
echo `rm -rf /`               ← 反引号
bash -c 'echo "$(rm -rf /)"'  ← shell body 内再套引号
```

即现行危险覆盖是**词法器撕碎事故的巧合产物**，不是设计。诚实性缺口同批实测：
撕碎产生的假段 `exe="$"` 的 `executableTrusted` 是 **true**（`isTrustedExecutableToken`
的 `token===executable` 臂，`shell-segment.ts:522-526`）；`$(echo ")"")` 等内层括号
产生假可执行 `exe=")"`；heredoc 定界符引号不参与状态机（`<<'EOF'` 体内 `$` 被当活的，
`cat <<'EOF'\n$(rm -rf /)\nEOF` 因撕碎反而误 Forbidden——真实 shell 里该体是纯数据）；
`bash -c` 递归与括号深度**均无界**（实测 22 层 bash -c / 3000 层括号跑通）。
G2 应改写为：「引号内 substitution 无危险扫描 + provenance 丢失；撕碎覆盖是巧合不是机制」。

### 2.2 为什么「内层全安全→外层可分解」必须拒绝（对原候选规则的否决）

候选「内层 segments 全 Skip-tier 且外层 executable 不在值敏感集 → 外层 decomposable」
被实测否决。值流饿死是真实且致命的：

- `rm $(echo src)` 的 `deletionTargets` 实测为 `["$"]`，`isPathAllowed("$")` 返回
  `{allowed:true}`（解析成 cwd 内字面文件 `$`）；`rm "$(echo ../../etc/x)"` 同样过——
  **路径检查对 substitution 段今天形同虚设**，若再给它 Skip 出口就是 fail-open。
- host 提取饿死：`curl https://$(echo evil).example.com` hosts `[]`。
- git operand 错绑：撕碎形态把 `git push $(echo …)` 判成 implicit remote，去读**请求
  cwd 仓库**的 origin 注入 networkTargets（`risk-policy.ts:328-339`）。
- 「哪些检查饿死」在本路径外还有开放面（`chmod $(…)`、`tar -f $(…)`……）；豁免集=
  对本层检查闭集的枚举，本质是「descent 证安全」，同时违反公理 3 和公理 4。
  `decomposable` 的契约是 **argv 恒等**，不是「后果被兜住」，不能偷换。

结论：active substitution 的 `decomposable=false` 是正确且永久语义。误报的正解不是
把它证安全，而是 (a) inert 形态本就该走既有 inert 出口（公理 4），(b) 真正的长期杠杆
是 09-29 note 已记的「sandbox-contained-unproven」第三处置（codex 式 fail-to-sandbox），
那是产品决定，不是 P0。

### 2.3 方案：两个 sound 机制

**M1 危险补全（关真 G2 + provenance + 撕碎巧合改为机制覆盖）**

1. 词法单一事实源：扩展 `scanShellSyntax`（它已有 quote/escape 状态机，`shell-lexer.ts`
   :200-220），在扫到**活的** `$(`/反引号时（单引号区、`\$` 除外）以括号深度 + 内层
   引号态配对截取，返回新增字段 `liveSubstitutions: string[]`（体文本）。配对失败/
   不闭合 → 只置现有布尔、不出体（fail-closed 到现状，绝不喂垃圾）。
   深度与条数复用既有 8 的先例（`isDangerousWords`/trap）。
   **必须在 `segment.source` 上扫**——实测 `echo '$(pwd)'`、`"$(pwd)"`、`$(pwd)` 三种
   拼写的 `shellWords` 输出逐字节相同，引号态只在 source 里。
2. 消费端零新判决：`parseCommandSegments` 的 nested 展开（:820-858）增加第二个体来源
   ——shell `-c` 体（现状）+ `liveSubstitutions` 的体。内层走**同一条** `inherit`
   信任继承（研究 B 已核实三臂语义被两个测试钉死）。于是内层 `rm -rf` 自动成为普通
   segment，被现有 tier-1 `isDangerousSegment` 判 Forbidden——**不新增任何判决逻辑**，
   引号内与撕碎两个孪生形态从「一个漏、一个靠巧合」收敛为同一机制。
3. provenance：`CommandSegment` 加 `nestedFrom?: "shell_body" | "substitution"`；
   risk-policy 的 prompt reason 在 `Forbidden && 有 nestedFrom==="substitution" 的危险段`
   时输出 `Dangerous command inside shell substitution: <内层 argv>`（进 staticReason →
   Guardian packet）。这次**允许**改 packet：它是动作自身的危险证据，与 P0-1 的过程标签
   性质不同（区分要写进注释）。无此例外时 reason 保持 `${risk} operation`
   （`tests/risk-policy.test.ts:2104` 不红）。

**M2 inert 补全（诚实化，不新增信任）**

4. `scanShellSyntax` 识别 heredoc：引号定界符（`<<'EOF'`/`<<"EOF"`/`<<\EOF`）的体内
   对 substitution/redirect/control **不置位**（`hasHereDocument` 保持 true——它是
   机制标记不是风险标记）。效果：`cat <<'EOF'\n$(date)\nEOF` 从「误 active」变为正确的
   inert+heredoc（当前因撕碎还误判 Forbidden，M2 后为 NeedsApproval——桶修正，不是放松，
   真实 shell 里该体永不被执行）。与单引号 `'$(...)'` 既有 inert 出口同构，零新信任。

**范围边界（测试钉为契约，不得顺手扩）**

- `$VAR`/`${VAR}`/`$1` 参数展开**保持 review**：`tests/risk-policy.test.ts:457-458`
  与 :480-492 显式钉着（值同样未知且可供给 flag；M1 的体提取只认 `$(`/反引号两种
  可执行拼写——注意这违反字面上的公理 4「机制优先」，但参数展开的机制与命令替换在
  「供给不可知值」上是同一个，而该值域上 review 就是产品契约。契约优先，注释说明）。
- 非沙箱路径零改动（`sandboxedBashNetwork` 语义不变）；git/gh/npm 各 operand 扫描、
  cd-normalize、deletion 路径检查全部不碰——M1 之后它们只会比以前**多看**到危险，
  不会少看到别的。
- 撕碎产生的假段 `exe="$"`/`exe=")"` 的 `executableTrusted=true` 是现存诚实性缺口，
  现被 decomposable=false 兜住；单行修（结构性 token 视同 nameless）记 P2 hygiene，
  不与本 slice 混做。

### 2.4 测试翻转面（全部是「变严或修正」，无放松）

| 测试 | 现状 | M1 后 | 性质 |
| --- | --- | --- | --- |
| `permissions.test.ts:637-644` `echo "$(rm -rf build)"`/反引号 | NeedsApproval | **Forbidden** | 关 G2，改断言即文档 |
| `permissions.test.ts:580-581` `` echo "it's" `rm -rf /` `` | NeedsApproval | **Forbidden** | 与其未引号孪生 :585-586 对齐 |
| `risk-policy.test.ts:417` | NeedsApproval | Forbidden（仍 prompt） | 同上 |
| `permissions.test.ts:241` `cat $(pwd)`、`risk-policy.test.ts:416/:434`、全部变量展开钉、inert 钉 :660-666/:500-533 | — | **不变** | 回归面为零即设计自检 |

新增：配对提取器表驱动（嵌套 `$($())`、内层引号、反引号不可嵌套的失败闭合、深度界、
`$(echo ")")` 垃圾不入库）；「引号/未引号孪生同判」property 测试；M2 heredoc 表；
provenance reason 文本测试；「cause 标签不改变授权」再钉一条（复用 engine :1230 模式）。

## 3. 切片与顺序

1. **Slice A（P0-1）**：段级 `unprovenCause` + `classifyRiskWithCause` + `causeToResidual`
   共标 + 测试更新。一个 commit，metrics 零改动，先合入开始攒分桶数据。
2. **Slice B（P0-2 M1）**：scanner 提取器 + nested 展开接体 + 孪生测试 + provenance。
3. **Slice C（P0-2 M2）**：heredoc inert 区。B、C 各自独立可验收。
4. 09-24 note 的 G2 行按 §2.1 修正（研究笔记是 dated note 惯例内的活文档，改动以本
   note 为据）。
5. 验收按 AGENTS.md：`preflight:sibling` → `check` → `lint` → `test`；本设计不触发
   host-turn-boundary。

## 4. 切片实录（实施日 2026-09-29）

三个切片全部落地。验收按 AGENTS.md（`preflight:sibling` → `check` → `lint` → `test`）：

- **Slice A = `048c9c9`**（P0-1 cause 共标）：设计原样。验收时 sibling 干净
  （preflight OK，pi-core 随仓 @ `803c040`）；check/lint 绿，1732 测试通过（+12）。
- **Slice B = `57cf334`**（M1 替换体展开）：判决翻转与设计表一致（引号孪生、
  反引号孪生 NeedsApproval→Forbidden；inert/参数展开/撕碎面零改动）。提交时
  sibling 被无关的注释级 pi-core 编辑弄脏 → 当场记为 provisional；随后在干净
  worktree 对上重跑（本仓与 sibling 同 @ `57cf334`）：preflight OK、check/lint
  绿、1740 通过。**实施真相两条**（设计未预言、不改判决）：
  1. 未引号形态的提取器**从不触发**——撕碎已把 `(`/`)` 从 segment source 剥掉，
     引号态只在完整 source 上存在。即未引号孪生的危险覆盖**仍是撕碎**，M1 把
     「引号内 + 反引号」两个形态变成机制；孪生同判由 property 测试钉住。
  2. 双重引号嵌套（`echo "$(echo "$(rm -rf /)")"`）撕碎后配对错位 → 配对失败
     不出体（fail-closed），覆盖留在撕碎，verdict 同 Forbidden；provenance 注释
     只标提取器真正找到的体，诚实标注机制归属。
- **Slice C = `56f92ea`**（M2 heredoc inert 区）：判决不变（heredoc 本就压不住
  fold），`cat <<'EOF'\n$(date)\nEOF` 的 cause 从 substitution_unproven 改为诚实的
  heredoc_unproven。`cat < <(cmd)` 防误判靠「`<<` 与定界符间不容空白」的拒绝式
  解析；here-string 不建区。干净 worktree 对验收（同 @ `56f92ea`）：preflight
  OK、check/lint 绿、1747 通过。
- **设计表两处实测修正**：① `cat <<'EOF'\n$(date)\nEOF` 在 M1 时代就已是
  NeedsApproval（表中「当前误判 Forbidden」对该形态不成立；误 Forbidden 的是
  体内含**裸危险命令行**的形态）。② `echo $(pkill x)` 已实测并钉测试：内层
  pkill 成为普通段被 tier-2 拦（cause `process_control`），下文 claim 行同步收口。
- **遗留（不在本设计范围，指认归属）**：撕碎产生的**假段 trusted**（`exe="$"`）
  与**引号定界 heredoc 体内的裸危险行**（`cat <<'EOF'\nrm -rf /\nEOF` 仍误
  Forbidden——真实 shell 该体是纯数据）都在**分词器**，scanner 修复不触及；归
  P1「heredoc 消费方区分 / 撕碎卫生」。`# $(…)` 注释上下文全仓无处理，基线即
  Forbidden（撕碎巧合），同属分词器面。

## This note does not claim

- 不声称 cause 词汇完备：新机制出现时落 `other_explicit_review` 是设计内 miss 方向；
  完备性由穷尽 switch 对**代码站点**成立，不对**世界**成立。
- 不声称 M1 关掉了所有 substitution fail-open：descent 仍不证安全（公理 3）。
  内层副作用（`echo $(pkill x)`）已实测钉测试：内层段成为普通段被 tier-2 拦。
  未引号形态的危险覆盖仍依赖撕碎（§4 Slice B 之 1），机制化仅限引号内与反引号。
- 不处理 P1/P2 项（cd-fold、heredoc 消费方区分、假段 trusted、`cargo owner list`、
  BASH_ENV 类）；`echo "$(date)"` 的 Skip 化明确留给产品决定（09-29 note §判断）。
- 三个研究子代理之二提供本文事实，第三个（参照分类学）未返回；fx `ApprovalReason`
  「原因=元数据不=判决」与 codex descent 教义的引用沿用本会话早前已实测记录与仓内
  09-24 note，未二次复核。
- 未跑验收命令、未改产品代码是本文**初写日**的状态；实施与验收见 §4。
  「最优雅」是本日期的工程判断，不是证明。
