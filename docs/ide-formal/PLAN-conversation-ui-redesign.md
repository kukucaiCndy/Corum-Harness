# PLAN：会话区全面重设计（B 方案：官方数据流 + 自研渲染层）

> 状态：**已落地（2026-08-29）** · fork 三包 + 全局换肤 + 全部卡片 + Review/子Agent 卡端到端
> 前置：dsh 已升 0.1.2-alpha.1；泳道已在官方对象层；评估结论见本会话《官方会话 UI 样式定制能力评估》。
> 本文档是「遍历官方全部卡片 → 按 corum 设计语言全面重设计 → B 方案落地」的计划与事实源。

---

## 0. 目标与决策

**目标**：会话区（消息流 + 输入区 + 审批 + 统计 + 头部 + 弹层）采用 B 方案落地——
**复用官方数据流（session 事件 → ui-conversation 投影 → 槽渲染），渲染层全部换为 corum
设计语言的新设计**。

**关键决策（用户拍板）**：
1. 走 B 方案（官方数据流骨架 + 自研渲染层），不走 A（纯换肤）也不留 C（纯自研数据通路）。
2. **重新全面设计**：设计稿现有部分卡片实际使用效果差，**不作为本次的事实源**——
   全部卡片在 Pencil 设计稿里重新设计定稿，再实现。
3. 设计先行：先在 Pencil 里把每张卡设计到实机尺寸定稿，再改代码（沿用既定工作流）。

**为什么 B 而非继续自研数据通路**：官方数据流（订阅推送 + compaction + 虚拟滚动 +
turn 聚合）优于自研 200ms 轮询 + fold；composer 官方全套（@上下文 / 命令 / 附件 /
queue / stop / 模型 / 权限）远超自研 textarea；泳道已在官方对象层，零适配接入。

**现状问题清单（实机截图佐证，重设计要解决）**：
1. **每条消息都包成一张玻璃卡**（user/ai/tool 全是大卡片）——卡片套卡片，视觉重、
   碎，长对话满屏是框。
2. **tool 调用平铺成独立行**，每条也包卡，打断阅读流。
3. **ai 回复被包在一整张封闭卡里**——但 AI 回复是持续过程，不该是封闭对话框；
   现在「一回复一卡」，中间夹零散 tool 行和「耗时 Ns」尾注。
4. **「耗时/fork/复制」出现在每张 ai 卡尾部**——应在 Agent 完成总结后统一出，
   现在每条重复，冗余。
5. 整屏全是玻璃框，缺呼吸感与信息层级。
→ 新方向（用户定）：ai 过程瀑布流（avatar 开头，不包卡，各种卡片依次流出）+
统一收尾 actions（完成后才出 fork/点赞/复制/耗时）+ 工具聚合卡（可展开）。

---

## 1. 官方卡片全量清单（要重设计的对象）

### 1.1 消息节点 `conversation.chat.node`（keyed 槽，15 种）

| key | 含义 | corum 是否要重设计 | 优先级 |
|---|---|---|---|
| `user` | 用户消息气泡 | ✅ 品牌气泡 | P0 |
| `steering` | 用户中途插话/转向 | ✅ 同 user 家族 | P1 |
| `assistant-step` | AI 回复卡（text/reasoning/tool-call） | ✅ 玻璃 ai 卡 | P0 |
| `turn-process` | 工具调用过程（tool 行集合） | ✅ 工具行/工具卡 | P0 |
| `turn-tail` | 一轮收尾（actions：fork/复制/耗时） | ✅ ai-actions | P1 |
| `command` | / 命令卡 | ✅ 命令卡 | P2 |
| `context` | @ 上下文引用卡 | ✅ 引用卡 | P1 |
| `compaction` | 自动压缩边界卡 | ✅ 边界卡 | P2 |
| `manual-compaction` | 手动压缩卡 | ✅ 边界卡 | P2 |
| `model-retry` | 模型重试提示 | ✅ 提示卡 | P2 |
| `turn-error` | 错误卡 | ✅ 错误卡 | P1 |
| `turn-max-tokens` | 超长截断卡 | ✅ 提示卡 | P2 |
| `system-prompt` | system prompt 卡 | ⬜ 默认折叠，沿用官方 | P3 |
| `unknown` | 未识别兜底 | ⬜ 沿用官方 | P3 |
| `inbox`（在 inbox.ts） | 收件箱类 | ⬜ 沿用官方 | P3 |

### 1.2 审批 / 待办交互（chain 槽）
| 项 | 说明 | 重设计 |
|---|---|---|
| `conversation.composer` chain → 审批卡 | PendingApproval 接管卡 | ✅ warn 描边 + 拆分按钮 + 浮层 menu（沿用现有自研卡，重设计定稿） |
| `conversation.chat.turnTail` chain | 一轮尾部扩展位 | P2 |
| `conversation.chat.assistant-actions` list | ai 卡 actions 行 | P1 |

### 1.3 骨架 / 头部 / 输入区（子槽）
| 槽 | 说明 | 重设计 |
|---|---|---|
| `conversation.session.header` + `.lineage`/`.actions`/`.utilities` | Convo Header（标题/血统/操作/工具） | ✅ Convo Header（沿用设计稿布局，重设计定稿） |
| `conversation.composer.bar` + `input.left/right/plan/model/dock/overlay/attachments` | 输入区（文本框 + 工具条 + 模型座位 + 附件 + 上下文芯片） | ✅ Chat Input（重设计；模型座位复用 corum-ui-model-selection） |
| `conversation.composer.dock` → 统计 StatsLine | 会话统计（轮次/token/耗时） | ✅ 统计行/浮层 |
| `conversation.hero.brand.mark` / `hero.workspace` | 空态 hero 品牌/工作区 | ✅ 空态 |
| `conversation.input.plan` | plan 模式条 | P2 |

### 1.4 弹层（L4）
| 弹层 | 说明 |
|---|---|
| 会话统计 popup-status / 上下文用量 popup-context-usage / ＋上下文 popup-context / 🛡权限 popup-permission / @Agent popup-agent | 沿用 DESIGN §6.2，重设计定稿 |

---

## 2. corum 设计语言基准（重设计必须遵循）

源自 `doc/UXDesign/DESIGN.md`（唯一权威）。**全部用 token，禁写死 hex**：

- **风格**：液态玻璃 Liquid Glass——环境光斑（glow-*）+ 半透明模糊卡（glass-1/2/3 +
  backdrop-blur 20px saturate140%）+ 光边描边（glass-border）+ 霓虹品牌点缀。
- **方中带圆**：主卡 r18、抬升卡 r11-12、按钮 r13/9、状态点圆形。
- **色彩 token**：背景层 bg-base/deep + glow-1/2/3；玻璃层 glass-1/2/3 + glass-border(-active)；
  文字 label-primary/secondary/tertiary/dimmed/on-brand；品牌 brand-primary/accent/text；
  状态 state-error/success/warn/running/idle。
- **用户消息**：glass-1 r18 光边（注意：DESIGN §3.3 用户消息是玻璃卡，与旧设计稿品牌
  实底气泡不同——**本次重设计需用户拍板 user 卡形态**：玻璃卡 vs 品牌气泡）。
- **Agent 消息**：glass-1 r18 光边 + 头部（品牌 avatar + brand-text 名 + 耗时）。
- **工具调用条**：glass-2 r12 + 状态点 + Mono 路径 + 耗时。
- **动效**：消息进入 200ms translateY；流式打字机光标 530ms；工具行 pulse；审批卡
  300ms spring + warn pulse；详见 §7.3。

**设计决策（用户 2026-08-29 拍板）**：
1. **user 卡**：品牌实底气泡（brand-primary 实底 + on-brand 字 + 右下小角 + 靠右 align-end）。
2. **ai 卡（关键修正）**：AI 回复是**持续长期的过程**——avatar + 回复时间只作**开头**，
   **不包成一个对话框**；后续瀑布流依次出现各种卡片（工具卡/reasoning/text 段/子 Agent 卡
   等）；**等 Agent 完成做总结后，才统一出分叉/点赞/复制/耗时按钮**（与官方 turn 模型
   一致：assistant-step 过程卡片流 + turn-tail 统一 actions）。
3. **工具调用**：一轮工具聚合成**一张可展开卡**（默认收起摘要，点开看明细）。
4. reasoning 折叠、审批拆分按钮、输入区弹层：设计阶段定稿。

---

## 3. 实施架构（B 方案落地方式）

### 3.1 数据流接入
- 泳道（corum-task-*）已在官方对象层 → 启用官方 `ui-conversation` + `ui-chat`（当前在
  ide patch 禁用），让官方投影消费泳道事件流。
- corum 自研 conversation-ui（corum-ide-conversation-ui）**退役数据通路**（getTaskSessionEvents
  RPC + streamFollow 轮询 + buildCards fold），改为：官方数据流驱动 + corum 自研渲染层
  （槽替换）。自研 composer 退役，改用官方 composer。
- 发送：已是官方 session.prompt（不变）。

### 3.2 渲染层替换（槽遮蔽，官方包零改动）
官方组件全用默认 priority 0，corum 用 `priority: 1` 精确顶替（`ui-slots` priority 遮蔽，
低者渲染；同 key 同 priority 才报错）：
- `conversation.chat.node` key=user/steering/assistant-step/turn-process/turn-tail/context/
  command/compaction/manual-compaction/model-retry/turn-error/turn-max-tokens → corum 自研卡
  （新设计），官方数据（owner props/inject：turnData/forkAt/loadOlder/streaming/耗时）全保留。
- `conversation.composer` chain priority>1 select PendingApproval → corum 审批卡（ui-approval
  的 answerer 不动，pendingInteractions 数据通路不变）。
- `conversation.session.header` / `composer.bar` / `composer.dock` / hero 子槽 → corum 自研。

### 3.3 样式落地
- 新卡片组件全部用 corum glass token（已在 `corum-ide-ui/theme.css` + GLASS_TOKENS），
  注入对话区作用域 CSS（`[data-slot="..."]` 稳定锚点 + 组件自带 className）。
- 不动官方 token（避免污染全局），玻璃质感经组件自身 CSS 实现。

---

## 4. 执行阶段（用户定调：先 fork 全量跑通 → 同步设计 → 逐卡实现）

### 阶段 0：fork 官方会话 UI（corum-ui-conversation fork）
fork 官方 `ui-conversation` + `ui-chat`（含 ui-approval 的渲染部分）为 corum fork 包
（沿用 corum-ui-settings-models/model-selection 的 fork 惯例）。**目的**：让官方会话 UI
在 kkc IDE 壳里**先完整跑起来**（官方默认卡片渲染泳道），作为后续逐卡替换的基座。
- 启用官方 ui-conversation/ui-chat（撤销 ide patch 禁用；layout 已由 kkc 壳提供同形
  ctx.layout；审批 answerer 已保留）。
- fork 而非直接启用官方包：后续要改渲染层结构（ai 卡不包对话框/瀑布流卡片/统一收尾
  actions），fork 后可以任意改而不受官方包不可改限制。
- 泳道接入：泳道已在官方对象层，官方投影直接消费（零适配）。
- **验证**：官方默认 UI 能渲染泳道真实消息流（user/assistant/tool 官方默认卡片）+
  composer 能发送（session.prompt）+ 审批官方卡能应答。**确保官方完全工作**。

### 阶段 A：设计定稿（与阶段 0/C 并行，Pencil 逐卡重设计）
按 §2 设计语言 + §决策，在 design.pen 新建「会话区重设计」画板，逐卡画到实机尺寸
定稿（用户逐卡确认）：user 品牌气泡 / ai 过程（avatar 开头 + 瀑布流卡片）/ ai 收尾
（统一 actions：fork/点赞/复制/耗时）/ 工具聚合卡（可展开）/ 审批卡 / 头部 / 输入区 /
统计 / 空态 / 弹层。深浅双版。

**已完成画稿（2026-08-29，Pencil 画板 id）**：
- `iV2D5` 一轮瀑布（user 气泡 / ai 轮头一次 / reasoning 摘要 / 正文裸流 / 工具聚合卡 / 统一收尾行 fork·heart·copy·retry+耗时）
- `J1wTo3` 审批卡（warn 描边玻璃卡 + 拆分按钮「允许一次▾」+ 拒绝）
- `qVHA8` 输入区（上行输入 + 下行工具条 ＋/🛡/@Agent/模型/🎤/发送）
- `BetQ9` 子Agent卡（avatar bot / 任务 / Running chip / 进度条 / Step n/m）
- `BUWxN` Review卡（chevron + N 文件已更改 + diff + 全部撤销/全部保留）
- `OcW3B` 错误卡（error 描边 + circle-alert + 错误摘要 + 重试）
- `kIlNH` 统计弹层 popup-status（玻璃卡 + 轮次/LLM耗时/工具/Token/费用 五行）
- `lMEUw` Convo Header（对话/轨迹选项卡 + 分叉/统计/关闭 hbtn）
信息架构见 `DESIGN-conversation-information-architecture.md`（方向已确认）。

### 阶段 B：逐卡实现（fork 包内重构 + 设计稿对齐）
按阶段 A 定稿，在 fork 包内逐卡重构成新设计：user → ai 过程/收尾 → 工具聚合卡 →
审批 → 头部 → 输入区 → 统计 → 弹层。每步 CDP 实机验证（泳道真实消息流渲染 + 交互）。

### 阶段 C：收尾
退役 corum-ide-conversation-ui 的自研数据通路 + 自研 composer（已被官方+fork 取代）；
全量 build + 重启冒烟 + 全面端到端 + 文档（PROGRESS + HANDOFF）+ 提交。

---

## 5. 风险 / 注意

- **~~官方 ui-conversation/ui-chat 启用的连带（已排除）~~**：ui-chat/ui-conversation inject
  `layout` 服务，但 **kkc 壳已提供与官方同形的 `ctx.layout`**（`corum-ide-ui/service.ts`
  `LayoutController implements ILayout`，完整实现 toggleSidebar/openDetails/closeDetails
  三方法、注释明示「the official ILayout exact semantics」）——官方两包对 layout 的
  依赖 kkc 壳直接满足，**无需启用官方 ui-layout**。此风险已排除。
- **泳道特殊事件**：泳道的 chunk/流式/工具事件形态与官方 session 是否完全一致（官方
  投影能否无障碍消费）——阶段 B 验证，若泳道事件缺字段需在 host 投影层补。
- **旧设计稿废弃**：重设计后旧设计稿的对话区卡片作废，DESIGN.md §3.3 组件规范需同步
  更新为新设计（文档与实现一致）。
- **composer 接管自研发送**：自研 send/streamFollow 退役后，发送/停止/queue 全走官方
  composer 管线，需验证泳道 prompt 与官方 composer 的 session.prompt 提交兼容（已是
  官方 session.prompt，应兼容）。
- **不破坏现有**：阶段 B/C 全程可回退（自研 conversation-ui 保留至 D 完成再退役）。

---

## 6. 待确认（开工前）

1. §2 的设计开放点 1-6（尤其 user 卡形态 / ai 卡头部 / 工具行 vs 卡）。
2. 阶段顺序是否认可（先设计定稿再切数据流，还是数据流先通再逐步换卡）。
3. 自研 conversation-ui 的退役时机（D 完成后退役 vs 永久保留作 fallback）。
