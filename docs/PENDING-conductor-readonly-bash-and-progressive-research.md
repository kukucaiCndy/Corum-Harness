# 待办登记册：指挥模式系列（2026-09-20 起 · 2026-09-22 精简）

> **本文件是「指挥模式相关待办」的单一事实源。** 开工前先读它、收工前更新它。
>
> **为什么存在**：2026-09-20 用户指出「我在上一轮的报告中看到你**已经忘了**要优化指挥者的
> 系统提示词了」。核实属实——我在对话里评估了指挥者提示词并给出三条结论，但**只说了没落盘**，
> 上下文压缩后彻底丢失。本文件就是为了不再发生这种事：**凡是我在对话里说过「要做/该修」的事，
> 必须落到这里**。
>
> **2026-09-22 大清账**：已完成条目（A/B/C/D1/D2/E′/F/H/I）已全部移除——留痕在
> `docs/HANDOFF-2026-09-20-conductor-permission-and-refactor.md`、
> `docs/PLAN-2026-09-21-agent-service-architecture.md` 与 git 历史。本册只留未闭合项。

---

## 📋 任务总表（开工前先看这张表）

| # | 任务 | 状态 | 依赖 / 卡点 |
|---|---|---|---|
| **D3** | 指挥者挂 34 个 MCP 工具（61%，含 29 个 CDP） | ✅ 已拍板：**指挥者可操作 MCP**（2026-09-22）→ **无需改动，条目关闭** | — |
| **E** | AGENTS.md 瘦身（62% 是历史叙事，非指导） | 🔴 未动；定调「保持注入、只治内容」 | 挂钩点已迁移：项目记忆已砍（经验归 Agent），**改随「项目文档治理场」一起讨论**（2026-09-22 用户确认） |
| **G** | `.master-key` 解不开（启动必须注入 `CORUM_CREDENTIALS_MASTER_KEY`） | ✅ **已评估并修复**（2026-09-26，`2d6cc60`） | **原判断「ad-hoc 签名与 Keychain 不匹配」不成立** —— 真因是 **safeStorage 按应用名选 Keychain 条目**（dev=`Electron` / 打包=`corum-desktop`），两个条目 ⇒ 同一 home 的 `.master-key` 谁建的、另一方解不开。**这是真实的发布阻断**（安装包起不了 agent），非环境噪音。修法 = `app.setName('corum-desktop')` 统一身份 + 迁移既有密钥。实测两边均 `host ready`、凭据 2/2 可解。见 §G |
| **J+K** | 「永久设置新模型 → 点应用」卡死 + 重跑后台化 | ✅ **卡死已修**（`f2edf3e`，实机验穿）；K（重跑后台化）**未做、也不再需要** | 真因 = 面板缺 React `key`（非原判断的「等重跑」），见 §J |
| **L** | 渐进式调研（B）**实测未生效**：主 Agent 仍自己调研后派活 | 🔴 待取证 → **待测试**（2026-09-22 用户拍板） | 需按「本可在哪一步停手」逐段比对，不能只看工具序列；**素材已备**：会话 `corum-task-ef3f751e` turn 1（先并行派 2 个 research 再动手＝正例）与 turn 4（连读 7 步 spec 才写 brief＝反例），见 §L |
| **M** | 只读门禁**误报**：`echo '…->…'` 里的 `->` 被当成重定向 ⇒ 纯只读命令被拒 | ✅ 已修（2026-09-26；随隔离场一并下沉到 `corum-orchestration/confinement.ts`） | 会话 `corum-task-ef3f751e` turn 4 step 5 实测白烧一次往返；修法 = 先 `stripQuoted` 剥引号字面量再判重定向 |
| **N** | 隔离第 2 层（fs 写沙箱）被 `danger-full-access` **整档旁路** | ✅ **已修并实机验穿**（2026-09-26，用户拍板 1+2） | 台账 `bug.sandbox.isolation-layer2-bypassed-by-danger-full-access` + `decision.sandbox.isolation-tier-orthogonal-axis`；见 §N |
| **O** | 预设 Agent 引用的模型**已被用户删除**时仍被当有效模型用 | ✅ **已修并实机验穿**（2026-09-26，用户拍板口径 3） | 用户定调：「预设的 Agent 应该同步回落到全局设置」+「运行过程中发生的非用户删除因素，是两个不同的概念」。台账 `bug.agent.preset-model-deleted-still-used-as-effective` + `decision.agent.preset-model-fallback-to-global-default`；见 §O |
| **P** | 主 Agent 在**前台一次性子 Agent 结束后仍尝试 `send_message`**（被 `NOT_RESUMABLE` 拒） | ✅ **已修并实机验穿**（2026-09-26） | 用户指出的遗留项。根因：continuable 实例的提示词**无条件**承诺「send_message 可唤醒空闲子 Agent」，而 `run_in_background:false` 走 one-shot `start()`（官方契约：不驻留）⇒ 天生不可续。台账 `bug.subagent.foreground-one-shot-promised-continuable`；见 §P |
| **Q** | 子 Agent 撞沙箱墙后**无法申请提权**（用户 9-14 需求，通路完全不存在） | ✅ **已修并实机验穿（含三档 UI 与「点总是允许后免问」）** | 台账 `decision.sandbox.child-escalation-three-tiers` + `evidence.ui.escalation-three-tier-device-acceptance-passed`；见 §Q |
| **R** | 子 Agent 的提问**无法送达用户** ⇒ 子 Agent 永久等待 ⇒ **整个任务卡死**，用户被迫手动终止（用户 2026-10-01 指出：「子 Agent 提问 主 Agent 无响应 这也是一个问题 要记录一下后面解决」） | 🔴 **未修，待解决** | 因果方向：**卡死在前、手动终止在后**（我首次记录写反了，已按用户口径更正）。提问**确实写进了子会话事件流**，只是无人呈上 ⇒ 呈现缺失。危害 = **卡死而非报错**（无超时、无失败、无结果）。根因与候选修法见 §R｜台账 `bug.subagent.question-lost-on-parent-abort`。**⚠️ 2026-10 治理：本条与 issue #75（`PENDING-foreground-subagent-pseudo-foreground.md`，含 HANDOFF-2026-10-18）是同一问题的两处登记——#75 登记册为现行事实源，§R 留存作问题背景。** |
| **S** | 不同形状的磁贴卡片**内部布局应各自不同**，以便更好展示内容 | ✅ **已完成并实机验穿**（2026-10-02）| 交付：共享包新增 `MosaicTileBody`（一份结构、四档布局，按外层 `data-tile-size` 由 CSS 切换）；三页共 8 处贴内结构全部改用它，各页已无重复副本。实测四种形状各自生效：`big` 纵向（图标居左上）+ 描述 3 行、`wide` **图文并排**（`flex-direction:row`）+ 描述 2 行、`tall` 纵向 + 作者沉底 + 描述 3 行、`small` 仅图标+名称。见 §S |
| **D3b** | conductor 人格「Every write is refused」是**假承诺**：bash 门禁 `detectBashWrite` 是启发式，漏判 `pnpm run build`/`make`/自定义脚本 | 🔴 **P0 · 用户 2026-11-13 裁决继续挂起** | 修法二选一：① 措辞降级为「已知写形态会被拒绝」/ ② 文件系统层不可覆盖只读边界。源：`corum-agent/src/conductor.ts:102`、`permission-policy.ts:185`、`corum-orchestration/src/confinement.ts:395`。见 §D3b |
| **T** | 内置调研 Agent `subagent_research` 在场保证——缺席 **fail-loud 报错而非兜底** | ✅ **已修**（2026-11-16） | 根因 ≠ §L：§L 是「工具在但行为不合规」，§T 是「工具不在」。修法 = ConductorRuntime 在场断言 + 机制段 fail-loud + 泄漏行门控 + 测试。见 §T |
| **U** | 子 Agent 委派/集成者间歇性失败：`localhost/glm-5.2` 报 `does not support reasoning effort high` | 🟡 **机制层真因已修**（2026-11-20）；网关层间歇性仍待查 | 机制层真因 = 锁定路由未配 effort 时凭空补 `'high'`（`corum-tool-subagent/src/index.ts` corumLockedOptions），网关档位表波动时即被拒。已改为省略 effort（适配器默认档）+ 回归网 `model-effort-no-fabrication.spec.ts` + :9333 实机验证。网关为何间歇性拒 high 仍待查（不再影响未配 effort 的委派）。见 §U |

---

## §R：子 Agent 的提问无法送达用户 ⇒ **任务卡死**（2026-10-01 记录，未修）

**用户原话（澄清后的准确口径）**：

> 「我澄清一下，终止是我手动的，因为子 Agent 准备的问题调用了提问工具，但是主 Agent 无响应，
> 也未传递给我裁决，导致子 Agent 一直等待，相当于任务卡死了，所以我才停止了。」

**⚠️ 因果方向（勿记反）**：不是「中止 ⇒ 提问丢失」，而是
**提问无处呈送 ⇒ 子 Agent 永久等待 ⇒ 整个任务卡死 ⇒ 用户被迫手动终止**。
中止是**用户对卡死的处置**，不是提问消失的原因。我首次记录时把这条因果写反了，此处以用户口径为准。

### 实测事故

2026-10-01 我在一次 `orchestrate` 委派里给子 Agent 写了**自相矛盾的 brief**（声称共享包
「已 build 通过、直接用」，还写了「早期实现曾在这里丢数据」暗示已修，而**缺陷实际一直存在**）。
子 Agent 按 persona 的「brief 与代码矛盾 ⇒ 停下如实报告」停下，并调用 `ask_user_question`
就「范围冲突」求裁决。**该提问没有出现在任何地方**：没进主会话界面（用户看不到）、
也没作为返回值回到主 Agent（我无从转达）⇒ **子 Agent 就停在那一步一直等**，
整个委派既不完成也不失败。用户观察到的现象就是「主 Agent 无响应」，
最终只能**手动终止**这一轮来解卡。

**事后唯一的取证路径**：从子会话日志捞回原文
（`<CORUM_HOME>/sessions/<project>/<sessionId>/session.v3.jsonl.zstd`，
`zstd -dc` 解开后按 `ask_user_question` 搜索）。这说明提问**确实被写进了子会话事件流**，
只是没有人把它呈上来 —— 是**呈现缺失**，不是记录丢失。

### 危害等级：这是**卡死**，不是「少一个提示」

卡死比报错更糟：报错会结束轮次、把控制权还给父 Agent；而**永久等待没有超时**
（本场实测：直到用户手动终止为止，一直挂着）。父 Agent 轮次被占用、用户界面无任何信号、
既无失败也无结果。任何子 Agent 走到「需要用户决策」这一步都会命中同一死角。

### 根因（已查实，分三层）

1. **工具面：子 Agent 拿得到这个工具。** `ask_user_question` 由
   `corum-ui-questions`（`packages/plugins/session/`）挂在 **tools registry 的 global 层**
   —— 源码注释明说「Mounting `ask_user_question` in the tools registry's global layer
   expands every agent's tool list regardless of its preset」。故**任何**子 Agent 都能调。

2. **却没有「子 → 父」的呈交通路。** 官方 `userQuestions` 通路的载体是**提问的那个 Agent**
   （子会话），而提问卡按**会话分片**渲染 ⇒ 子会话的提问不会出现在主会话界面上。子 Agent
   的 persona（`child-roles.ts`）也**完全没提** `ask_user_question`：它只被要求
   「**Report back** immediately / say so in your report」——即**设计意图是让子 Agent 把
   问题写进报告交回父 Agent**，而不是直接向用户提问。

3. **于是永久等待，把父轮次也拖住。** 提问是一个**阻塞式工具调用**：子 Agent 调了它就在
   那一步等用户答复。而答复永远不会来（用户看不到、父 Agent 也不知道要转达）⇒
   **子 Agent 挂住、父轮次跟着挂住、任务既不完成也不失败**。上述设计里「问题走报告交回父 Agent」
   是**返回值**通路，可提问工具并没有走那条路 —— 它直接向用户要答复，而这条路的
   呈送环节缺失。**这才是卡死的机制**（与父轮次是否被中止无关；中止是用户对卡死的处置）。

### 已有先例（修法可循）

同一仓库**已经**为「子 Agent 需要用户决策」建过一条**「以父 Agent 为载体重发」**的通路：
`corum-subagent/src/escalation-answerer.ts`（§Q 的产物）。它的注释把这段机理写得很清楚：

> 官方 `ApprovalService.decide()` 用 `scopeTarget(req.agent, req.agent)` 派发，即
> **载体 = 提问的 Agent（这里是子 Agent）**；`corum-api-remotes` 的转发器按
> `carrierKeyOf(this)` 取载体并转发到 renderer，而审批面板又是**按会话分片**的……

故提权请求是「**以父 Agent 为 scope 载体**再发一次官方审批」，才能出现在主会话的卡上。
另有 `corum-tool-subagent/src/model-ask.ts` 走**自建 waterfall**（`corum/model-ask/request`）
而**刻意不复用** `userQuestions`，理由是两者的**生命周期、取消语义、文案归属都不同**。

### 待拍板的候选修法（三条，未选）

| 方案 | 做法 | 代价 |
|---|---|---|
| **R1 收敛工具面** | 从子 Agent 的工具面**摘掉** `ask_user_question`（靠 `toolFilter` 的 deny 并集），让它只能按 persona 原意「写进报告」。 | 改 persona 契约；子 Agent 遇到真歧义时只能等父 Agent 转述（多一跳），但**通路确定**。 |
| **R2 转发提问** | 仿 `escalation-answerer`：子 Agent 的提问**以父 Agent 为载体重发**，出现在主会话卡上。 | 需处理「父轮次已中止 / 父不在了」的归属与超时；工作量最大。 |
| **R3 至少不丢** | 中止时**把子 Agent 未应答的提问随中止结果回传**给父 Agent（哪怕只作为文本），由父决定要不要再问用户。 | 最小改动、止血；不解决「子 Agent 直接提问时不呈现」的根问题。 |

**记录纪律**：本条目存在的原因是用户指出「主 Agent 无响应」这件事**本身**就是缺陷，
而不是「这次运气不好」——**任何**子 Agent 的提问在父轮次中止/父 Agent 崩溃/会话被切走时
都会走到同一个死角。修之前，**别再把「子 Agent 会自己问用户」当作可靠通路来用**。

---

## §O：预设模型被删除 ⇒ 回落全局默认（2026-09-26）

**用户报障**：手动删掉 `kimi-k3-1` 后，`conductor-lead` 预设仍引用它 ⇒ 每个新指挥会话第一句
`UNKNOWN_MODEL` 硬失败（实测 `corum-task-b36de140`，整轮什么都没干成）。用户定调原话：

> 「预设的 Agent 应该同步回落到全局设置。而不是继续用一个不存在的模型。」
> 「我 9 月 18 日的功能主要是在**运行过程中发生的非用户删除因素**，是两个不同的概念。」

**根因**：主 Agent 模型可用性**从未被校验**——`profile.model` 在 5 处原样消费
（创建任务 / 复用 blank 泳道 / 换绑 preset / 冷恢复 / 项目泳道+dev agent），唯一暴露它的是请求层
（`llm-pi-ai` 的 `UNKNOWN_MODEL`）= 「跑一次才发现」。

**概念分界**（用户划定；已入台账 lesson `lesson.model.config-absence-is-not-runtime-failure`）：

| | 何时可知 | 处置 |
|---|---|---|
| 配置引用的模型已不存在（用户删除/改名） | **事前**，确定性 | **回落全局默认 + 显式告知** |
| 运行期调用失败（限流/超时/额度） | 只能跑了才知道 | **问用户**（2026-09-18 拍板，语义不变） |

**修法**：新增 `model-availability.ts` 的 `resolveUsableModel`（查 `llm.resolveModelInfo`，**纯配置读取、无网络**）；
可用则原样透传（绝不因「更保险」改用户选择），不可用则回落 `agentDefaultModel` 并在会话内显式告知。
告知走 `agent.inject`（**不开 turn**）——因 `findBlankTaskLane` 判 blank 的判据是「无 `turn/start`」，
用 `followup` 会复活「空会话堆积」缺陷。子 Agent 保持问询语义，只**补**了锁定路由的委派前预检
（前台原本只在非锁定分支预检、后台完全不预检 ⇒ 配错的模型会白跑一轮再问）。

**实机验证（:9333，复刻用户现场）**：预设 `kimi-k3-1`（已删）、全局默认 `kimi-k3` ⇒
① 发第一句**正常回复「收到」、零 error**（修前必 `UNKNOWN_MODEL`）；② 实际路由 = `localhost/kimi-k3`、
effort `max`；③ 日志含 `corum-model-fallback` 告知；④ 实测后预设**未被改动**（机制不擅改用户配置）。

---

## §D3：指挥者 MCP 工具面 —— ✅ 已拍板关闭（2026-09-22）

**原问题**：指挥者被裁掉 bash，却挂 29 个 Chrome DevTools MCP + 5 个 pencil MCP
（56 个工具中 34 个 MCP，61%），与「指挥者不该亲手操作」的定调看似不一致。

**用户拍板（2026-09-22）**：**指挥者可操作 MCP**——保留现状，不摘。条目关闭。

---

## §D3b：conductor 人格「Every write is refused」假承诺 —— 🔴 P0，用户裁决继续挂起（2026-11-13）

**问题**：conductor 人格声明「Every write is refused」，但 bash 门禁 `detectBashWrite` 是**启发式**——能拦住直接写形态（`>` / `tee` / `sed -i` 等），却漏判间接写形态（`pnpm run build` / `make` / 自定义脚本内部执行写操作）。故「Every write is refused」是假承诺：存在被拒绝以外的写路径。

**用户裁决（2026-11-13）**：本轮范围 = host-identity P1 + N5，**D3 继续挂起**。

**修法二选一**（未拍板）：

| 方案 | 做法 | 代价 |
|---|---|---|
| ① 措辞降级 | 承诺从「Every write is refused」改为「已知写形态会被拒绝」，如实反映启发式边界 | 最小改动；不解决漏判本身 |
| ② 文件系统层只读边界 | 不依赖 bash 命令解析，在 fs 层钉不可覆盖的只读边界（worktree 之外不可写） | 工作量大；与隔离第 2 层（§N）同源 |

**源锚点**：`corum-agent/src/conductor.ts:102`（人格声明）、`permission-policy.ts:185`（detectBashWrite 启发式）、`corum-orchestration/src/confinement.ts:395`（confine guard）。

台账：`d3.conductor-false-promise.bash-write-detection-heuristic`。

---

## §E：AGENTS.md 瘦身

**现状**：62% 是历史叙事（各场交接摘要），非操作指导。用户定调（2026-09-20）：
**保持注入**、只治内容。

**挂钩点迁移（2026-09-22）**：原定「与项目记忆功能一起讨论」；而项目记忆已砍
（用户定调：经验归 Agent 记忆，项目中只有规范/进度/bug，属文档治理范畴）。
⇒ **改随「项目文档治理场」一起讨论**——AGENTS.md 的历史叙事段正是「项目过程
记录」的候选载体之一，届时一并设计其归处。

---

## §G：`.master-key` 解不开 —— ✅ 已评估并修复（2026-09-26，`2d6cc60`）

**现象**：启动必须注入 `CORUM_CREDENTIALS_MASTER_KEY` 环境变量，否则 `.master-key`
解不开。原判断：疑似 ad-hoc 签名与 Keychain 条目对不上（开发态/打包态签名身份不一致）。

### 评估结论：**原判断不成立**，且这是**真实的发布阻断**（非环境噪音）

按用户 2026-09-22 拍板做评估，用**对照实验**（非推理）取到真因：

**真因 = `safeStorage` 按「应用名」选 Keychain 条目**（`<app.getName()> Safe Storage`）。
dev 态直接跑 Electron 二进制时身份是 `Electron`，打包态是 `corum-desktop`
（= package.json 的 `name`）⇒ **两个不同条目** ⇒ 同一份 home 里的 `.master-key`
**谁建的、另一方就解不开**。

| 密钥由谁建 | 以 `Electron` 身份读 | 以 `corum-desktop` 身份读 |
|---|---|---|
| dev（Electron 条目）      | ✓ | ✗ |
| 打包（corum-desktop 条目）| ✗ | ✓ |

**为什么是「发布阻断」而不是噪音**：装完包首次启动即**整棵插件树加载失败**
（`credentials-local(encrypted): a stored credential is encrypted but the master key
is unavailable`）⇒ agent 起不来 ⇒ 应用等于不可用。**实测复现**：打包 app + 一份
由 dev 身份建的 home → 必失败；同一 app + 全新空 home → 正常（它自己建密钥）。

**与签名的关系**：**无关**。本机 ad-hoc 签名下，两个身份各自都能正常读写自己的
条目；故障只取决于密钥文件由哪个身份创建。

### 修法（已实测）

1. `main()` 开头 `app.setName('corum-desktop')` ⇒ dev / 打包态 / 各调试端口实例
   **共用同一 Keychain 条目**，从根上不再有「谁建的」问题。
   ⚠️ 该字面量必须与 package.json 的 `name` 一致（它决定条目名）；`productName`
   （`Corum`）只影响 Dock/菜单显示，不参与取名。
2. 已存在的 `.master-key` 需**重新封装**到统一下的身份（同一把明文密钥，只换封装），
   否则旧文件仍解不开。旧文件留档 `~/.corum/.master-key.pre-identity-unify-*`。

**实测验证**：dev 实例 `host ready` 0 错误；打包实例（同 home 同密钥）`host ready`
0 错误；凭据可解密性 **2/2 条全部解出**。

**纪律（可复用）**：凡「用系统钥匙串/DPAPI 封装密钥再落盘」的设计，**封装身份是
数据可解密性的一部分** —— 换应用名、换签名身份、换运行形态（dev↔打包）都可能让
既有密文变砖。要么固定身份（本修法），要么在身份变化时做**重新封装迁移**。

---

## §J+K：点「应用」卡在「应用中」永不恢复 + 重跑后台化（**✅ 已修复 `f2edf3e`**）

> **结论（2026-09-22）**：卡死**已修复并实机验穿**。真因**不是**原先判断的「等重跑导致
> 等待链过长」，而是**面板缺 React `key` ⇒ 组件实例被复用**（下「真因」节）。
> **K（重跑后台化）因此不再需要**——重跑并未造成卡死，等待链本身正常。

> **2026-09-22 复现结论**：用户「测试没有这个问题了」的判断**不成立**——按原报障路径
> （前台委派 + 慢重跑）**完整复现**，见下「§J 复现记录」。缺陷仍在。

### 现象
用户在「子 Agent 模型不可用」面板选「永久设置新的模型」→ 点「应用并继续」→ 按钮变
「应用中…」并 **disabled，永不恢复**，用户只能中止 turn。

**实机确认**（主实例 DOM）：`{"occurrences":["应用中…"],"hasApplying":true}` ——
而该会话的 `turn/end` 早已是 `reason:{kind:'user'}`（用户中止），**面板仍在 applying**。

### §J 复现记录（2026-09-22，:9333 验证实例 9333 自建会话）

**构造**：给 `task` 预设配一个**不存在的子 Agent 模型**（`saveProfile` 写
`subagentModel: {provider:'localhost', model:'nonexistent-model-probe'}`）⇒ 委派必失败
⇒ 拉起决定面板。**必须新建会话**（旧会话的 preset 已在保存前组装，吃不到探针）。
提示词要求子 Agent 跑 `sleep 240`（构造慢重跑窗口）。

**判定链（每条都是实测，非推理）**：

| 时刻 | 事实 | 证据 |
|---|---|---|
| T0 | 子 Agent 以探针模型启动、立即失败 | 子会话 `turn 1, step 1` 报 `pi-ai provider "localhost" has no configured model "nonexistent-model-probe"` (UNKNOWN_MODEL) |
| T0 | 决定面板**被拉起**（折叠态 bar「子 Agent 模型不可用 · 任务已暂停」） | DOM `role=status` 命中 |
| T1 | 展开面板 → 5 个档位齐（临时用主模型/永久跟随主 Agent/永久改指定模型/不重试本次委派/应用并继续） | DOM 枚举 |
| **T2** | 选「临时用主模型」→ 点「应用并继续」→ 按钮变 `应用中…` 且 **disabled** | DOM `{applying:true, applyDisabled:true}` |
| T2 | 点击**确实送达 host**（机制回注了决定通知） | 父会话 seq 67 `agent/inbox/spliced`：「You chose to switch this session's child-Agent…」 |
| T3 | 重跑**真的开始**（子 Agent 跑 `sleep 240`，路由已是主模型 `deepseek-official/deepseek-v4-flash`） | 新子会话 `request/header` 路由 + `tool/call bash sleep 240` |
| T4 | 重跑**正常结束**（子会话 `turn/end completed`，耗时 240s；父会话随后也 `turn/end`） | 两份会话日志 |
| **T5** | **重跑已结束，面板仍卡在「应用中…」**（`turn/end` 之后） | DOM `{applying:true, panel:true, applyDisabled:true}` + 截图 |

**截图（最终裁判）**：`/tmp/corum-cdp/shots/jk-repro-applying-stuck.png` ——
顶栏显示该会话「已完成 1 · 重试委派 sleep 240」、对话区已出终报，而底部 dock 面板
仍停「应用中…」（disabled）。

**排除的两个假设**：
1. ~~「测试没有此问题」= 缺陷已消失~~ ⇒ 实测完整复现，缺陷健在（用户测试可能走了
   后台委派路径或重跑够快的场景，未触及等待链）。
2. ~~面板没被拉起~~ ⇒ 拉起正常（bar + 5 档位都在）；**卡的是点击之后**。

**判据修正（重要）**：面板卡死**与「重跑跑多久」无关**——重跑**已经结束**面板仍不恢复。

### 真因（2026-09-22 定位，**取代**原先的等待链归因）

**面板缺 React `key` ⇒ 组件实例被复用。**

`ModelAskDock` 原为 `return <ModelAskPanel pending={pending} />`。同一会话出现**第二次**
询问时，React 按「同类型同位置」**复用上一个实例的组件 state**：上一轮点击留下的
`applying=true`（以及 `kind` / `picked`）被带进新面板 ⇒ 新面板一出生就只能渲染
`disabled` 的「应用中…」，用户永远点不动。**这与重跑长度无关，故 K（后台化）不需要做。**

**定位证据（对照实验，都在 :9333 实机取得）**：
1. 卡死那一刻读面板绑定实例的 `answer()` —— 探针返回 `RESOLVED`，即**该实例从未被
   `answer()` 过**；而 host 侧明确收到了决定（父会话 `agent/inbox/spliced` 记录了
   「You chose to switch this session's child-Agent model…」）。
   ⇒ **界面显示的 pending 与用户点击结算的不是同一个**。
2. 对该实例手动调一次 `answer()` ⇒ 面板**立刻消失**，`snapshot` 被清空
   ⇒ **摘除管线完全正常**，问题不在结算链、不在 `remove()`。
3. 修复后同一会话第二次询问拿到 `model-ask:3`（**新 key**），面板 `enabled:true`
   可正常交互 ⇒ 实例不再复用。

**既有正确对照**：`corum-ui-approval` 用的是 `<ApprovalFlow key={approval.key} …>`；
官方 `ui-user-questions` 的 `QuestionComposer.tsx` 对 `PlanReviewPanel` 也是
`key={question.key}`。**我们这两个插件漏了。**

### 修复（`f2edf3e`，已实机验穿）

- `corum-ui-model-ask`：`<ModelAskPanel key={pending.key} pending={pending} />`；
  并给 `apply()` 的 `answer()` 补 `.catch(() => setApplying(false))`——原 `void
  pending.answer(...)` 会吞掉 rejection（实例已结算时 `answer()` 会 reject），
  同样把 `applying` 永久停在 true，属**同一失效形态的第二条通路**。
- `corum-ui-questions`：`QuestionCard` / `PlanReviewCard` **同源缺陷**一并修
  （`index`/`drafts`/`busy`/`collapsed` 会被复用实例带过去）。
- 各加源码断言守卫（model-ask 5 条 / questions 3 条），**反向验证过**（去掉 key 即红）。

### 已废弃的原「修法 A」（保留作认知留痕，**不要再按它实施**）

原判断是「决定落地与重跑被串进同一个 promise ⇒ 解耦 + 重跑后台化」。该归因**不成立**：
重跑已结束面板仍卡，且 `answer()` 从未被调用——说明问题在渲染层身份错配，与 host 的
等待链无关。**故 J 不需要 K 配合，`subagent` 的返回语义也无需改动。**

**⚠️ 验证副作用（必须复位）**：`task` 预设里被写入探针模型
（`packages/desktop/.corum-verify-home/.agent-presets/task/agent.cordis.yml` 两处
`model: "nonexistent-model-probe"`）。**不改回的话该 home 所有新会话的委派会全数秒挂**。
本次已复位（`grep -c` = 0）。

---

## §L：渐进式调研实测未生效 —— 待测试

**用户观察（2026-09-21）**：任务 B（渐进式调研三阶段）虽已交付（`80871d2`），但实测
主 Agent 仍自己调研后派活，未按「入门自己看（有界）→ 深入一律派 research → 收尾点读
验收」的漏斗行为。

**取证方法**：挑一次真实指挥会话，按「本可在哪一步停手」逐段比对其 grep/read 序列——
不能只看工具调用次数，要看**每一次调研与最初问题的相关度**（参照此前抓到的 `#9-#18`
发散反例：下一个 grep 的问题与最初问题已不同 = 该派 research 的信号）。

**本场新增素材（2026-09-26，会话 `corum-task-ef3f751e`）**：
- **正例（turn 1）**：开局仅 1 次 orient bash（`git status` / `git log`），随即**单条消息并行派 2 个
  `subagent_research`**（读交接文档 + 读本登记册），再 `ask_user_question` 让用户选起点——正是
  漏斗期望的形态。
- **反例（turn 4）**：合并后 9 条测试红，主 Agent 用 **5 次 bash（`sed` 分段读 spec）+ 1 次 grep，
  连续 7 步自己诊断**才写出迁移 brief。**两说并存**：辩护方——「移植缺陷 vs 实现 bug」是核心判断，
  且每次都是点读（已知行号区间），符合「能写 brief 就停手」；按 L 项取证标准，这段**仍是**
  「主 Agent 自己调研后派活」的实例。**判据**：数它「本可在哪一步停手」——即哪一步之后它掌握的
  信息已足够写 brief。

---

## §N：隔离第 2 层被 `danger-full-access` 整档旁路 —— ✅ 已修并实机验穿（2026-09-26）

**用户核对本场指挥会话时提出**：「kimi 需要 work 合并分支，但是 work 是可以选择运行在主分支的？
我记得机制不允许 worktree 的 Agent 改写 main」。**核实结论：用户判断成立**（我第一版误判为
「设计如此」，被用户以设计文档原文纠正）。

**根因**：隔离是设计文档 `docs/plan/PLAN-subagent-isolation.md` §1.3 明写的「**四层硬隔离（全部
机制，无 prompt 纪律）**」，其第 2 层 = fs 写沙箱（以 `session.header.cwd` 为边界）。而沙箱档位
是**用户可覆盖的状态**，子会话此前**整体继承父档位** ⇒ 用户切「完全权限」后，官方 `fs-sandbox` /
`bash-sandbox` / `terminal-bash` 三处**直通不 confine**，第 2 层整档消失。

**实测坐实（同一 brief 结构，两档命运相反）**：

| worker | 派发时父档位 | 子会话 sandbox | 对主树写 |
|---|---|---|---|
| `bca632cd` | `workspace-write` | `workspace-write`（delegation） | ❌ EPERM（硬隔离生效） |
| `a207aaa5` / `9fb1db37` / `b72fec3e` | `danger-full-access` | `danger-full-access` | ✅ 删 19 个 worktree / `git -C <主树> merge` 成功 |

**修法（用户拍板 1+2）**：
1. **正交轴**：`confinedSandbox` / `confineToWorktree` 把隔离期子会话沙箱**钳到 `workspace-write`**
   （**只收窄不放宽**：取更窄者，父 `read-only` 时维持只读）。接线**三条缺一不可**：工具层隔离分支、
   `corum-isolated` provider、**continuable + 冷恢复**（`confined` 进 durable 描述符）。
2. **纵深防御**：`@corum/corum-orchestration/confinement.ts` 的 `confinementGuard`
   （agent-scoped、单调 deny）拦住对 worktree 之外的**写形态**调用。

**实机验证（:9333，全过）**：父 `danger-full-access` → 子沙箱 `workspace-write`（`source: delegation`）；
子 Agent `printf > <主树>/probe-isolation.txt` 被 guard **拒绝**；同一子会话界内 `write` 与
`git add/commit` 成功；文件最终只经机制**合法合并**（`9e43be1 Merge branch 'wt/wt-0fc972'`）进主树。
单测 1091 全绿（新增 12 条，含三档矩阵回归门禁）。台账见
`bug.sandbox.isolation-layer2-bypassed-by-danger-full-access`。

**顺带修掉的两个既有缺陷**：① 只读门禁把引号内 `->` 误判为重定向（条目 M）；② `git -C <dir> <sub>`
从未被识别为写形态（`subcommandOf` 取「第二个词」取到 `-C`）——**实测会话里 worker 正是用这条
命令把分支并进主树的**。

---

## §P：前台一次性子 Agent 是终态 —— 提示词不得承诺「可续接」（2026-09-26）

**用户指出的遗留项**：「之前遗留的主 Agent 在前台一次性子 Agent 结束后仍然尝试发送新的消息」。

### 现场（会话 `corum-task-ef3f751e`，逐行）

| 行 | 事件 |
|---|---|
| 66 | `subagent { run_in_background: false, description: "抢救孤儿改动并清理工作树" }` |
| 69 | 子 Agent 汇报「两个硬阻断…未执行任何破坏性操作」 |
| 68 | 机制注入**结算通知**：`Subagent bca632cd-… finished … — final report:` |
| 81 | 主 Agent 调 `send_message`，目标正是 `bca632cd-…`（想「授权执行步骤 1」） |
| 82 | **被拒**：`… has no supported continuation state and cannot be resumed` |

⇒ 白烧一次往返，且「授权它继续」的意图**根本没送达**（子 Agent 已终结）。

### 根因

`subagent` 实例的 `backgroundMode` 是 `continuable`，于是工具描述与机制段**无条件**写着
「`send_message` … starts a turn while it is idle」——**没有限定这只对后台子 Agent 成立**。
而 `run_in_background: false` 走 `ctx.subagents.start()`（官方 one-shot 契约：不驻留、
不落可续描述符）⇒ **天生不可续接**（拒绝点 `corum-subagent/continuation.ts`，`NOT_RESUMABLE`）。

**关键取证（决定了修法落点）**：前台结果的 `render` **不含子会话 id**，所以模型是从
**结算通知**里拿到 `bca632cd-…` 再调 `send_message` 的 ⇒ 修复必须落在结算通知这个面上，
只改工具描述不够。

### 修法

新增单一事实源 `corumOneShotTerminalLine(toolName)`，落到**四个模型可见面**：
① 工具描述（`corumSchedulingDescription`）；② 机制段（`corumSchedulingSectionText`）；
③ `run_in_background` 参数描述（`corumRunInBackgroundDescription`）；
④ **结算通知**（`corumForegroundSettlementText`）。

措辞纪律：**不只否定**——同时给出替代路径（「重新委派并交接上下文，或下次改用后台」）；
**不误伤后台**（`send_message` 对 continuable 仍有效）；research 实例描述不动。

### 验证

- 单测 `one-shot-terminal.spec.ts` **13 条**；`corum-tool-subagent` **338** 全绿（+13）；
  四包合计 **1122** 全绿；typecheck 0 错；两个守卫脚本通过。
- **实机 :9333**（`corum-task-95bfd56b`）：派 `run_in_background: false` 子 Agent ⇒ 结算通知末尾
  出现 `NOTE: A FOREGROUND one-shot child (…) is TERMINAL once it settles…`；`request/header`
  里工具描述与机制段**都**带该说明；**主 Agent 未再调用 `send_message`**。

---

## §Q：子 Agent 沙箱提权通路（2026-09-26）

**用户 2026-09-14 需求**：「子 Agent 需要请求全新[提权]，子 Agent 需要通知主 Agent 向用户请求权限。」
该通路此前**完全不存在**：子会话 `approvalPolicy` 钉 `never`，官方语义是「在到达任何应答者**之前**
就确定性 rejected」⇒ 子 Agent 撞墙时既拿不到权限、也无人知晓。
实测基线（会话 `bca632cd-…`）：4 次沙箱拒绝 / **0 次提权尝试** / **0 条审批事件**。

### 判定规则（用户 9-14 三情形收敛成一条）

设 `X`=请求档位、`P`=主 Agent 当前生效档位（`read-only < workspace-write < danger-full-access`），
官方强制提权必须**严格更宽**：

> **`X ≤ P` ⇒ 机制自动批准（不打扰用户）；`X > P` ⇒ 上呈用户。**

逐条对上 9-14 原话：① `P==C` ⇒ `X>C=P` ⇒ 上呈 ✅「不得自行批准」；② `P>C` ⇒ 够则同意/不足转交 ✅ 原文；
③ `P<C` ⇒ `X>C>P` ⇒ 上呈 ✅「必须上呈」。**关键性质：上限恒为 `P`**。
这个比较由**机制**执行 —— **不给 LLM 任何批准工具**（同 9-18「不给 LLM 开坏口子」）。

### ✅ 你 2026-09-26 的裁定：两个轴要分开（我此前混淆了）

原话：「我理解，**隔离只是工作区隔离**。即当前代码的工作区隔离，但是若子 Agent 需要访问或者
执行一些指令，**需要权限还是合理的**。」

| 轴 | 机制 | 提权能动它吗 |
|---|---|---|
| **工作区写边界**（改动只能落在自己的 worktree） | `confinementGuard`（**按路径**判定，不读档位） | **不能** |
| **沙箱档位**（进程能访问/执行什么） | `sandbox/mode` + 本次已批准的显式档位 | **能** —— 这正是「申请权限」的本意 |

⇒ 实现已改：`hardCeilingFor` **只对只读研究设界**（`read-only`），隔离不再封档位。
只读研究保留天花板的理由与隔离不同：它**本来就不隔离**、cwd 就是父工作区，放开写＝直接写主树。

### 交付（`@corum/corum-subagent`）

| 件 | 作用 |
|---|---|
| `escalation-policy.ts` | 判定纯函数 + 三档词汇 + 解析（未知一律朝关闭倒）。**22 条单测**（含「上限恒为 P」穷举、只读天花板、fail-closed） |
| `escalation-answerer.ts` | 从子会话 `tool/call` 按 `callId` **结构化**读 `sandbox_permissions`（不解析 prose；事件存在≠提权；解析失败朝关闭倒）；`prepend` 抢在转发器前认领；`X > P` 时**以父 Agent 为载体**重发。**17 条单测** |
| `child-agent.ts` | 子会话策略 `never → ask`（与应答器**成对不变式**）+ 装应答器 |
| 提示词 2 处 | `corumSandboxEscalationLines()` 子会话分岔条 + `SUBAGENT_DELEGATION_CONTEXT`——两处曾写「子会话提权必被拒」，已改真；锚点单测**改aim 而非放宽** |

### 实机验穿（`:9333`，三个场景）

1. **提权确实被发起**：隔离写子（`corum-task-3ca0d966` → 子 `3c169c8f`）`tool/call` 带
   `sandbox_permissions=danger-full-access`（基线 0 次）⇒ 被 guard 前置拒，父树未动。
2. **ask-user 分支**：父 `read-only` + 隔离子请求 `workspace-write`（`corum-task-184044c5` → 子 `a255dc88`）
   ⇒ 子会话 `approval/asked` → **父会话出现** `approval/asked: "subagent requests sandbox escalation
   to workspace-write: …"`（即「子 Agent 请求 → 主 Agent 转交用户」）。
3. **★ 载荷关键（裁定后复验）**：父 `danger-full-access` + 隔离写子（`corum-task-075e3db4` → 子 `wt-8f3923`）：
   ① 子在工作树内带 `sandbox_permissions=danger-full-access` 写 ⇒ **机制自动批准、无用户弹窗**、写入成功；
   ② 紧接着写工作树之外 ⇒ 仍被 `confinementGuard` 拒。⇒「**档位放开 ≠ 写边界放开**」实机成立。

验证：四包 **1164** 测试全绿 / `pnpm -r typecheck` 0 错 / `verify-fork-drift.sh` 与
`verify-refactor-guard.sh` 通过（RPC 面未动）。

### ✅ 路线已勘定（2026-09-26，第 3 轮）：必须走 corum 自有 waterfall

我原先设想的「复用官方审批卡 + 一条旁路事件记授权」**不可行**，判据两条：

1. 官方 outcome 在 **`approval.request()` 内部**就被归一化 —— `dsh/packages/interaction/user-approval/src/index.ts:288` 把非词汇表返回值一律变成 `unavailable`（`OUTCOMES` 只有 4 个，L55）⇒ 客户端回第 5 个词到不了应答器；
2. 本应用**没有** client → host 旁路：全仓 client 插件无 `$emit`，`remote-events.ts` 的白名单是 **host → client** 转发，而 client → host 只有被 `verify-refactor-guard.sh` **冻结的 28 个 `@Remote`**（不得新增）。

⇒ 出路是 **corum 自有 waterfall**（只有官方 approval 的返回值会被归一化，corum waterfall 不会）。既有先例 `corum/model-ask`：`corum-tool-subagent/src/index.ts:968-977` `runtimeCtx.waterfall(scopeTarget(request.agent, request.agent), 'corum/model-ask/request', request, next)`。

**最终形状**：① 声明 `corum/escalation/ask`（waterfall）+ 白名单；② 宿主把「以父 Agent 重发官方请求」换成这条 waterfall，答案词汇自定 `allowed-once | always-allow | rejected`，`always-allow` ⇒ 先记会话授权（本轮已就位的 `EscalationGrants`）再回官方 `allowed-once`；③ ★ **无回归窗口**：该 waterfall 的 `next`（无人应答）**就用现在的官方重发** ⇒ 老渲染自动退回官方卡，第 1 档照旧可用；④ 客户端加监听 + 第三个按钮（第 3 档禁用占位）。

台账：`finding.ui.escalation-tier2-needs-corum-waterfall-because-no-client-to-host-channel`。

### ✅ 已交付并实机验穿（2026-09-26）

三档 UI 与「点『总是允许』⇒ 该会话后续同类提权免问」已端到端验穿，见台账 `evidence.ui.escalation-three-tier-device-acceptance-passed`。关键判据：第二次提权 **UI 无卡**、子会话 `approval/decided=allowed-once`（无用户交互）、命令真的执行成功且 `q.txt` 真的落盘。

**教训（我踩的坑）**：前几轮看不到三档卡，根因是**渲染进程在跑旧的客户端 bundle**；我第 10 轮曾据此误判「客户端处理器从未被调用」——因为我只核对了埋点在**构建产物**里、没核对它在**已加载**的 bundle 里。客户端行为类问题必须**先证明新产物真被加载**再采信读数。

### ⏭ 遗留（不影响本项验收）


机制侧已就绪（三档词汇、判定、会话内授权语义均有单测），缺的是把**审批卡**接上三档。两个已知约束：

1. **官方结果词汇表是封闭的**（`allowed-once | rejected | cancelled | unavailable`；未知值被归一为
   `unavailable` ⇒ fail-closed）。⇒「总是允许」**不能**作为新 outcome 回传，必须是「机制侧记一条
   会话内授权 + 本次仍回 `allowed-once`」，否则会静默变成拒绝。
2. 「自动」档（记录用户允许情况 + 后台 AI 生成批准策略 + 落盘跨会话）按你裁定**预留**。

安全网已在位：上呈带**有界等待**（5 分钟，与 `CORUM_ASK_TIMEOUT_MS` 同口径），
没有可应答 UI 时**不会永久挂住父轮**（超时按拒绝收口）。**已查清（见台账 `finding.ui.escalation-ask-card-renders-in-parent-composer`）**：那条 ask **确实**到了现有卡链路——客户端 `answerApproval` 用 `ctx.sessions.scopeOf(owner)` 取会话，而监听器用 `function`（`this`=载体），我把载体换成**父 Agent** ⇒ 卡片归属**父会话**；面板又是 `conversation.composer` 的全局注入 ⇒ **父会话对话视图在屏时卡就会出现**。我当时只切到侧栏列表、没打开对话视图，所以 DOM 里没查到按钮（**视图假象，非机制缺陷**）。

⇒ 于是三档 UI **不必**新建整套询问通路：①②**已由现有卡完成**，只需**加第三个按钮**「总是允许」= 旁路事件（corum 自有 emit，按 `sessionId` 记会话内授权）+ 本次仍回 `allowed-once`（官方封闭词汇表不被破坏）；③ 禁用占位。下一轮须显式打开父会话再断言「卡可点」。

---

## §S：不同形状的磁贴卡片用不同内部布局（2026-10-02 已完成）

**用户原话（2026-10-01 收工前）**：「不同的矩形卡片 布局可以不同，以便更好的展示内容。」

### 现状

四种形状（`big` 264×264 / `wide` 264×128 / `tall` 128×264 / `small` 128×128）目前
**共用同一套贴内结构**：`图标行 → 名称+版本徽章 → 描述 → 作者小字`，只按档调字号与图标尺寸
（`mosaic.module.css` 的 `.tile[data-tile-size='big'] .tileName` 之类）。形状差异只体现在
**占位大小**上，没有体现在**信息组织**上 —— 面积更大的形状并没有因此展示更多或更合适的内容。

### 目标

让每种形状有各自更贴合的布局，把该形状的面积优势用在该展示的内容上：

| 形状 | 面积特征 | 布局取向（待用户确认） |
|---|---|---|
| `big` 264×264 | 最大、正方形 | 封面式：大图标主视觉 + 名称 + 描述 3 行 + 作者 |
| `wide` 264×128 | 宽扁 | 图文并排（左文右图或左图右文）+ 描述 2~3 行 |
| `tall` 128×264 | 窄高 | 图标居上 + 名称 2~3 行 + 多行小字描述 + 作者沉底 |
| `small` 128×128 | 最小 | 只留图标 + 名称（不塞描述） |

### 动手前先读

- 排布算法与形状计划：`corum-ui-base/src/client/mosaic.ts`
  （`BlockShapePlan` / `planBlockShape` / `buildColSkeleton` / `buildMosaic`）。
- 形状样式与容器查询：`corum-ui-base/src/client/mosaic.module.css`
  （`.tile[data-tile-size=...]` 与 `@container (max-height: ...)` 那几段窄窗让位规则）。
- 三个消费页各写了一遍贴内结构（只共用 `mosaicStyles` 的类名）：
  `PluginsPage.tsx`、`McpPage.tsx`、`SkillsPage.tsx`。
  **最省事的落点**：共享包出一个「按 `data-tile-size` 分档的贴内骨架」组件，
  否则要在三页里各写四套。

### 约束（不要回退已验成果）

- 窄窗容器查询那套让位规则（名称收单行 / 隐版本徽章 / 描述收行 / 图标缩到 16px）需与新布局共存；
- 块宽恒等式与 **808** 基准、3 列模式的 4 列骨架 `[128,128,264,264]`、形状计划配额都不要改；
- 既有验收改完要重跑：**数据守恒 804 组穷举**、**入口贴钉左上角 398/398**、
  形状四种都出现、1280 与 1600 两档无裁切（`scrollHeight <= clientHeight`）、控制台 error 0、
  `./scripts/verify-fork-drift.sh`。

### 交付记录（2026-10-02 已完成）

**用户当天追加的口径**：「同方案一，但 big 图标仍居左上」+「big 描述 3 行（维持现状）」。

**实现**：共享包 `corum-ui-base/src/client/MosaicWall.tsx` 新增 `MosaicTileBody`
（props：`icon / name / version? / desc? / sub? / corner?`）——**一份结构、四档布局**，
形状由外层贴的 `data-tile-size` 经 CSS 切换（`mosaic.module.css` 的「按形状分档的贴内布局」段）：

| 形状 | 布局 | 实测 |
|---|---|---|
| `big` 264×264 | 图标居左上 → 名称 2 行 → 描述 3 行 → 作者 | `dir=column`、desc=显示 |
| `wide` 264×128 | **图文并排**（图标左、文字右），描述 2 行 | `dir=row`、desc=显示 |
| `tall` 128×264 | 纵向 → 描述 3 行 → 作者沉底 | `dir=column`、desc=显示 |
| `small` 128×128 | 仅图标 + 名称（不传 desc） | `dir=column`、desc=无 |

`desc` 口径由旧的「只有 big/wide 才渲染」改为「**除 small 外都传**」（`tall` 也因此有描述）。

**三页去重**：8 处贴内结构（插件 4 / MCP 2 / 技能 2）全部改用 `MosaicTileBody`，
三页 `mosaicStyles.tileTop` 引用归零（各页不再自写贴内结构）。

**验收（全部实测）**：三页骨架覆盖 8/8、18/18、1/1；四种形状布局方向各自正确；
1280（3 列）与 1600（6 列）**裁切 0、右侧空白 0**、详情保底 320；
热排仍 196×120×4；浅色主题下 `wide` 仍 `row` 且无裁切；
**数据守恒 804 组穷举 0 失败**、**入口贴钉左上角 398/398**；
`./scripts/verify-fork-drift.sh` 通过；三包 build + typecheck 全绿；控制台 error 0。
证据：`docs/verify/integrations-1to1-round9/`。

**遗留（子 Agent 如实报告、我确认属实）**：热排贴的名称行预留高度比改前高约 2px ——
旧写法 `hotName` 与 `tileName` 同一个 span（`min-height` 生效），新骨架把 `tileName` 放外层、
`hotName` 在内层 inline span（`min-height` 不生效）。仅影响热排那一行的预留高度，字号与两行钳制不受影响。
若要逐像素归位，需让骨架支持 name 透传 className。

---

## §T：内置调研 Agent 在场保证——缺席 fail-loud 报错而非兜底（2026-11-16 已修）

### 根因（≠ §L）

**§L 的根因**是「工具在、行为不合规」（主 Agent 不按三阶段渐进式调研、自己读完才派活）。
**§T 的根因**是「工具不在」——内置 `subagent_research` 实例**完全缺席**于可见工具面。

具体触发：Conductor Mode 的系统提示词**无条件**指示主 Agent 委派只读调研给 `subagent_research`，
但在一次实机会话中，该工具**不在**主 Agent 的可调用面上（`hasResearch = false`），
而 `subagent` / `orchestrate` 在场。于是提示词指向一个不存在的工具。

根因链：运行实例是 **Nov 14 旧打包产物**，仍带 `modelSelectionSettings` 门控（issue #165），
其 settings-scoped per-agent 注册路径（`installScoped`，按 agent/created + tools/change 键触发）
**静默失败**，未为本会话注册 research 实例。该门控路径在 HEAD 已被 #165 退役（`ca49fbd3`）——
`install()` 现在无条件注册——**故触发器已消失**，但**机制层面没有保证 + 没有报错**。

### 用户决策（2026-11-16，原文意图）

> 「机制必须保证 hasResearch，如果没有应该是报错提醒，而不是兜底。
> researchAgent 作为内置 Agent 必须起效。」

即：缺席 = **机制故障**，必须**响亮报错**（通知用户 + ERROR 提示词段 + host 日志），
**不是**降级模式——**不**加兜底路由指引（如「用 orchestrate research:true 代替」）。

### 修复（2026-11-16）

三处改动，均在 corum-agent + corum-tool-subagent 两个包内：

1. **ConductorRuntime 在场断言**（`conductor-runtime.ts`）：
   - `apply()` 在算完 visible names 后检查 `subagent_research` 是否在集合里。
   - 缺席时：host ERROR 日志（含 sessionId + 可见工具名）+ 用户可见通知（`agent.inject`，与模型回落同通道）
     + 注册 ERROR 系统提示词段（`CONDUCTOR_RESEARCH_MISSING_SECTION`，文本是 ERROR 陈述非兜底路由）。
   - 非中断：会话仍正常启动，告警是增强不是前置条件。

2. **机制段 fail-loud + 泄漏行门控**（`corum-tool-subagent/src/index.ts` ~4082-4154）：
   - `hasResearch=false` 时在机制段**置顶 ERROR 行**（MECHANISM FAULT，不是兜底路由指引）。
   - **三条泄漏行门控**（hasResearch=true 时原文逐字不变，hasResearch=false 时不路由到缺席工具）：
     - `~4120` EXECUTABLE verification：去掉 "NOT `subagent_research`" 从句。
     - `~4128` ONE piece of work：去掉 "(or `subagent_research` when read-only)" 从句。
     - `~4142` route it to：改 "route it to `subagent_research`" → "route it to a read-only delegation"。
   - host ERROR 日志**每 scope 一次**（闭包 scoped `researchMissingNotified` 标记，非 module-level——红线 1 合规）。

3. **测试**：
   - `conductor-research-presence.spec.ts`（新增，10 条）：research 缺席 ⇒ ERROR 段 + ERROR 日志 + 通知 + 非中断；
     research 在场 ⇒ 三者皆不发生；切出模式 ⇒ ERROR 段随撤销。
   - `prompt-discipline.spec.ts`（扩展，7 条新增）：hasResearch=false ⇒ ERROR 行 + 三条泄漏行不提 subagent_research；
     hasResearch=true ⇒ 三条泄漏行原样保留。
   - 既有正向断言（`conductor.spec.ts:161` persona 含 subagent_research；`prompt-discipline.spec.ts:269` discipline text）
     不变、通过——现在由在场保证**justify**。

### 注册路径核实（Task 3）

`install()` 在 HEAD 无条件注册（`installScoped` 门控已随 #165 退役）；
`install(ctx)` → `mount(subagentProvider)` → `runtimeCtx.tools.register(defineTool(...))`
路径上**无 silent try/catch**——注册失败会直接抛。未发现可隐藏注册失败的静默 catch。

### 与 §L 的区分（重要）

§L 的证据语料**应排除**「工具不在」的会话——那种会话不是「行为不合规」而是「机制故障」，
其工具序列里没有 `subagent_research` 调用是因为工具不存在，不是因为主 Agent 不遵守三阶段。
混淆两者会让 §L 的修法（提示词引导）被误认为能解决 §T 的问题（注册保证）。

### 文件变更

- `packages/plugins/agent/corum-agent/src/conductor.ts`：新增 `CONDUCTOR_RESEARCH_MISSING_SECTION` / `CONDUCTOR_RESEARCH_MISSING_TEXT`。
- `packages/plugins/agent/corum-agent/src/conductor-runtime.ts`：`apply()` 加在场断言 + `deliverResearchMissingNotice` + `ConductorFaultMessageSource`。
- `packages/plugins/agent/corum-agent/src/agent-service.ts`：5 处 `conductor.apply` 调用点传 agent 参数。
- `packages/plugins/agent/corum-agent/src/task-lane.ts`：`TaskLaneHost.applyConductor` 接口 + 2 处调用传 agent。
- `packages/plugins/agent/corum-tool-subagent/src/index.ts`：机制段 ERROR 行 + 泄漏行门控 + 闭包 scoped 去重。
- 测试：`conductor-research-presence.spec.ts`（新）、`conductor-write-guard.spec.ts`（mock 加 logger）、`conductor-official-create.spec.ts`（同前）、`prompt-discipline.spec.ts`（扩展）。

---

## 2026-11-16 新登记：编排嵌套失控 / 孙 Agent 路由漂移 / 编排无法停止（现场 :9222 复现）

三件一起登记：它们是**同一条链**上的三个断点（现场会话 `corum-task-9106a713`，
主会话 `agentPreset=standard`，4 任务并行编排，3 完成 1 运行中）。

### N1. 子 Agent 仍能派孙 Agent（违反「子 Agent 只执行不再派活」）

**事实**：设计意图写在 `docs/fork-delta.md`（路线 B 实现记录）+ `compile.ts:119-124`：
> orchestrator 收紧 worker `maxDepth: 1`（子 Agent 只执行不再派活，编排收归主 Agent）

**但收紧是条件式的**：`if (role === 'worker' && profile.executionTools === 'orchestrator')`。
现场主会话是 `standard` preset（非 orchestrator 角色）⇒ 该 if 不成立 ⇒ 不写 `maxDepth`
⇒ 落到 schema 默认值 `maxDepth: z...natural().default(3)`（`index.ts:235`）。

**实测证据**（会话头 `delegationDepth` 字段）：
| 会话 | depth | preset | 模型 | toolFilter.deny |
|---|---|---|---|---|
| `7e645c1d` | 1 | corum-dev | localhost/deepseek-v4.1-flash | `[mcp_index,mcp_load,write,edit]` |
| `b9bf8679` | 2 | corum-dev | **deepseek-official/deepseek-flash** | **`None`** |
| `0648e96c` | 2 | corum-dev | **deepseek-official/deepseek-flash** | **`None`** |

全库统计：`depth=1` 144 个、`depth=2` **4 个**（本次现场 2 个 + 2026-11-14 的 2 个 `standard` 族）。

**待决**：
- ① 「子 Agent 不得派孙 Agent」是**全局不变量**还是 orchestrator 专属？若全局 ⇒ 收敛到
  schema 默认值（`default(1)`）或 provider 侧硬闸，而不是靠 preset 逐处写 `maxDepth`。
- ② `maxDepth` 收紧为什么只写在 `compile.ts`（profile 驱动）而**没有任何 preset 写**——
  `shipped-presets/official/*/agent.cordis.yml` 的 corum 工具行全都**不写** maxDepth。
  升级基座时 `maxDepth: provider-managed` 只出现在**官方** tool-subagent 行（且 `disabled: true`），
  容易被误读成「官方行已表达，corum 行不必管」。

### N2. 孙 Agent 的模型路由与设置不一致（N1 的下游，但**危害独立**）

**事实**：同一个 `agentPreset=corum-dev`，depth 1 拿到 preset 锁的
`localhost/deepseek-v4.1-flash`，depth 2 却变成 `deepseek-official/deepseek-flash`（**另一家 provider**），
且 `toolFilter.deny` 从 4 项变成**完全没有**（researcher 的只读属性在孙层丢失）。

**含义**：depth 2 的 preset **config 根本没有被应用**（否则 model 键必然被锁住）。这与
「preset 名继承对了但 config 没生效」是同一种病：`child-agent.ts:161` 只把
`agentPreset` 名字写进 session meta，而 config 的组装发生在 `presets.mount()`（`:262`），
两处对 depth≥2 的路径未核。

**待决**：depth≥2 时 preset 是否真的 `mount()` 过？判据（下一步应当直接验）：
在孙会话里读它实际注册的工具清单，若含 `write`/`edit` ⇒ 证实 config 未应用（而非只是 deny 未组装）。

### N3. 编排运行中无法停止（**没有入口**，不是"点了没反应"）

**事实**：全页 278 个按钮中与停止相关的只有输入框的「停止生成」。它是
`apply.ts:815` → `scopedConversation(sessions, sessionId).cancel()` —— **只 cancel 当前会话自己的 turn**。
编排的 N 个子会话是**独立 Agent 实例**，不在该 turn 树上。

`OrchestrateCard.tsx` 的按钮清单（实测 DOM）：收起 / 展开任务详情 / 进入子会话 / 展开收尾报告
—— **没有任何停止或中断控件**。

**实测复现**：点「停止生成」后 6 秒，`7e645c1d` 分支仍「运行中」，编排卡计数不变（3/4），
子会话文件仍在写。

**待决**（属于交互设计决策，不自行拍板）：
- ① 编排卡该不该有「停止全部」？若要有，语义是「停掉未完成分支 + 让收尾节点以 aborted 汇总」还是
  「整批放弃」？
- ② 「停止生成」在主会话有在跑编排时，是否应当级联到子会话？（当前沉默地只停父 turn，
  用户看到的现象就是「点了没反应」——这是**最误导**的形态。）
- ③ 机制侧是否已有 cancel 所有子会话的能力？（`corum-tool-subagent-control` 提供了
  `tool-subagent-control` 服务——需核实它能不能列出并停掉一批 run；这决定是纯 UI 补入口
  还是要补机制面。）

### 复发路径（为什么这次会再犯）

第 2 条最贵的教训：**「禁掉 X」与「X 在别处被默认允许」两处分离时，前者失效无人发现**。
`maxDepth: 1` 住在 profile 驱动分支里、默认值住在 schema 里、preset 一条都没写——
三处各说各话，任一环节漏掉就静默放开递归。

---

## 2026-11-17 落实：N1/N2/N3 三项已修并实机验证（本轮收口）

用户 2026-11-17 决策四条（原话保留）：
1. 「全局不变量，不可设置。如果调用任务过重，需要主 Agent 进行拆分，而不是让子 Agent 再派孙 Agent」
2. 「询问用户，需要收尾后再停止还是直接终止；如果收尾过程中用户还要终止则正式终止」
3. 卡死任务「重启后我重新发起一次该分支任务」
4. N2「仍要修：作为纵深防御」

### N1 已修：三层 + 实机验证

机制侧改动（三处，缺一不可）：
- `corum-tool-subagent/src/index.ts`：schema `maxDepth` 默认值 **3 → 1**；
  另加**工具层硬闸**（`spawnOne` 入口，`delegationDepthOf(parent) >= 1` 直接 throw）——
  因为 schema 默认值绕得过（preset 显式写 2/3、`apply()` 直连、`provider-managed`）。
- `corum-subagent/src/child-agent.ts`：`delegationsDenied` 由
  `conductorParent || kind === 'worker'` 改为**恒 `true`**（推翻 2026-09-20 的
  「researcher 保留 subagent_research」非对称设计）。
- `corum-subagent/src/child-roles.ts`：`RESEARCHER_ROLE` 删掉
  「You may delegate further research…（subagent_research）」那一句，
  改为「自己挖深 + 若确实过大就报告该由主 Agent 怎么拆」。**人格发散性不变**。

**实机验证**（9222 打包实例，子 Agent 自己的报告原文）：
> **我的函数清单里没有任何委派工具。** 本会话可用的工具只有 read/glob/grep/bash 等只读
> 调研工具，外加 `list_agents` / `send_message` / `interrupt_agent`

⇒ 工具面 deny 生效（不是靠模型自觉）。回归测试：`child-agent.spec.ts` 的
「子 Agent 不得派生孙 Agent（2026-11-17 全局不变量）」3 例。

### N2 已修：**首版修法把委派打坏了，第二版才对**

- ❌ 首版（错误）：往 `request.agentPreset` 塞父的 `composedPreset`。实机立刻炸
  `Error: subagent provider "corum-spawn" does not support independent agent preset
  selection` —— `SpawnInProcessProvider.capabilities.agentPreset = false`，
  `manager.assertCapabilities` 对非空 `request.agentPreset` 直接抛。
- ✅ 二版（正确）：改在 `applyChildComposition`（**子侧**、走 `composition` 通路，
  不经过 provider 能力协商）：父自己是子会话（`delegationDepth >= 1`）时按名
  `presets.mount()` 而不是 `composeFrom()` 复制父运行时组合。
  - 为什么判据是「父也是子会话」而不是「父有没有 preset 名」：后者会让两个既有契约
    变红 —— `omission shares the parent`（省略时必须复制父**当前组合**）与
    `retired preset generation`（父 preset 已注销，mount 会抛 not-found）。
    两者都是 depth 0 的主会话场景，语义必须保持。
  - 判据用 `parent.session.header.delegationDepth`（durable，resume 后仍正确）。

回归：`corum-subagent` 653 测试全绿（含上述两个契约用例）。

### N3 已修：RPC 面 + 编排卡入口 + 输入框询问

| 层 | 改动 |
|---|---|
| 宿主 RPC | 新增 `corumAgent/interruptChildSessions(parentSessionId, childSessionIds)` —— 走 `subagents.interrupt(id, { kind:'user', parentSessionId })`，这条通路此前**没有任何生产代码调用**。逐条容错，返回 `{interrupted, skipped, errors}` |
| 前端桥 | `chat-runtime.ts`：`interruptChildren()` + `runningChildIdsOf()`（同步、无 I/O）+ `interruptChildrenOf()` |
| 编排卡 | `OrchestrateCard.tsx`：头部停止按钮（`aria-label=停止编排`）→ 询问面板（收尾后停止 / 直接终止 / 取消）；已请求 graceful 后按钮变「立即正式终止」 |
| 输入框 | `InputBar.tsx`：主「停止生成」在 `subagentChildrenCount() > 0` 时**先询问**（不再静默只停父 turn）；`slots.ts` 的 `stop` 增加可选 `mode: 'hard' \| 'graceful'` |

**实机验证（三层，全部通过）**：
1. RPC 存在性：`interruptChildSessions({childSessionIds: []})` → `{ok:true, interrupted:[], skipped:[], errors:[]}`
2. 编排卡入口 + 询问面板：实测 DOM 出现 `aria-label="停止编排"` → 面板标题
   「要怎样停止这次编排？」+ 三按钮文字正确
3. **真实停止生效**：
   - 直接终止：3 个子会话 `turn/end = aborted(user)`，`sleep 120` 进程数归零
   - 收尾后停止：2 个子会话 `turn/end = aborted(user)`，卡片 `state=aborted`、
     `0/2 完成 · 2 已终止`、提示「已请求停止未完成分支，收尾节点将按已终止汇总」
   - 第二段语义：按钮变 `data-phase=graceful-requested` / `aria-label=立即正式终止`，再点即正式终止

### 顺带修掉的两个实机缺陷（本轮暴露）

1. **编排卡永久「并行执行中」**：`overall` 判据是 `data.errored && !data.settled`，
   而宿主重启后 `orchestrate` 的 tool/call 没有结果 ⇒ 恢复机制合成
   `TOOL_OUTCOME_UNKNOWN`（`isError=true`）⇒ `settled=true, errored=true` ⇒
   旧判据下 `failed=false`，三个分支又都不满足全体终态 ⇒ 落到 `running`。
   实测那张卡在界面上「并行执行中 · 3/4」挂了 17 小时。
   **修法**：`failed = failedCount > 0 || data.errored`（报错就是报错，与 settle 无关）；
   `failedCount === 0` 时文案改为「N/M 完成 · 编排中断」（不再渲染自相矛盾的「0 失败」）。
2. **停止按钮取不到刚 spawn 的子会话**：`subagentChildOf` 读模块级 Map，
   其变化不触发 React 重渲染 ⇒ 帧刚到这一刻 `runningChildIds` 仍是空数组 ⇒
   点停止报「没有正在运行的子会话可停止」，而实际三个都在跑。
   **修法**：订阅该 callId 的 spawn 帧 bump 一个 `spawnTick`（进 useMemo 依赖）；
   另加兜底——ids 空时回落到宿主的 `runningChildIdsOf(sessionId)`。

### 仍未做（明确记账）

- 「收尾对卡死分支超时按 aborted 汇总」的**超时窗口**：当前 graceful 是「请求停止未完成
  分支」，实测分支 8 秒内就 aborted 了，故超时窗口未触发过。真正的「卡死且不响应
  interrupt」形态（如模型卡在流式响应）尚无兜底计时器 —— 需要机制侧加超时，
  属独立一轮。
- workflow/ralph 引擎直接创建子 Agent 的旁路：不经过本工具层，故 N1 的硬闸管不到
  （已在代码注释与本节标注）。

---

## §U：子 Agent 委派/集成者间歇性失败 —— `localhost/glm-5.2` 报 `does not support reasoning effort high`（2026-11-20 记录，待查）

**现象**：子 Agent 委派与集成者路由**间歇性失败**。报错信息为 `does not support reasoning
effort high`，模型为 `localhost/glm-5.2`。重试**有时成功**——非确定性失败。

**用户裁定（2026-11-20）**：

> `glm-5.2` **应**支持 `high` reasoning effort，这不是配置问题。

即：模型能力本身无缺，问题在网关层或机制层——要么网关错误地拒绝了对 `glm-5.2`
的 `high` effort 请求，要么机制在派发时构造了不正确的请求参数。**不通过改配置绕过**，
待查根因。

**待查方向**：

1. **网关层**：`localhost` provider 对 `glm-5.2` 的 `reasoning_effort` 参数处理——
   是否在特定条件下（如并发请求 / 上下文长度 / 超时重试）错误返回 `not supported`。
2. **机制层**：子 Agent / 集成者构造请求时是否在间歇性场景下传了超出模型声明的
   effort 值，或 effort 字段在传递链路上被篡改。
3. **重试行为**：重试有时成功说明请求内容大概率正确，失败更可能来自网关侧的
   状态依赖（如限流返回了格式错误的拒绝）。

**机制层真因已坐实并修复（2026-11-20，corum-dev）**：

- **真因**：`corum-tool-subagent/src/index.ts` 的 `corumLockedOptions` 在预设锁面**未配
  `reasoningEffort` 时凭空补 `'high'`**。`glm-5.2` 的网关档位表是**状态依赖**的（有时含
  `high`、有时不含），于是这个被强加的 `high` 间歇性被 `resolveCallConfig` 拒绝 ⇒
  「健康模型被误判不可用」。这同时解释了「重试有时成功」：重试路由（`corumApplyRetryRoute`）
  **不带 effort**，故能过。广播帧 `corumSpawnModel` 也同源补 `high`（卡片显示假档位）。
- **修法**：锁面/广播帧都改为「effort 只在确有值时带上，缺省省略 = 适配器默认档」
  （官方语义 `Absence preserves the provider's own default`）。回归网
  `tests/model-effort-no-fabrication.spec.ts`（源码守卫 + 真链路）。
- **实机（:9333，隔离 home）**：未配 effort 的 `glm-5.2` 子会话请求头**不再有** `reasoningEffort`
  （修复前恒有 `high`）；委派成功、无面板。
- **网关层仍待查**：`glm-5.2` 为何间歇性拒 `high`（用户裁定它**应**支持）属网关侧状态依赖，
  与机制无关；修复后未配 effort 的委派不再受其影响。**显式**配了 `high` 的预设仍可能间歇性
  撞网关拒绝——那是网关问题，不在本修复范围。
