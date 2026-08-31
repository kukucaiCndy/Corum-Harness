# 子 Agent B 报告：session 插件群（已收，32230 行）

纪律性总体较好但工程卫生欠债明显的官方 fork 群。核心数据通路（snapshot-builder/assembler/input facade/审批提问 waterfall）与官方零漂移，定制集中在渲染层，fork 策略成立。四条跨包系统性问题：全包 noImplicitAny:false、~1.3 万行官方测试整体丢弃无替代、新增 UI 硬编码中文绕过 i18n、chat 对 conversation 运行时+类型双重依赖破坏官方「feature 插件互不依赖」红线。无内存泄漏大坑、无 dangerouslySetInnerHTML/eval。

## 跨包系统性（P0/P1）
- 【P0】6/7 包 tsconfig.json:9 显式 noImplicitAny:false + 不再 extends 官方 base.client.json + 删 project references（conversation/chat/settings-models/model-selection/questions/approval；仅 session-archive 除外）。2.6 万行 fork 失去类型防线。
- 【P0】chat→conversation 架构红线：tsdown.config.ts:23-24 把 corum-ui-conversation 列 external（运行时模块表请求）、index.ts:46,49 re-export 其值、30+ 处非 type-only import。官方规范：feature plugin MUST NOT runtime-import/re-export 另一 feature plugin 的值或声明 external 获取（行为走 Cordis 服务、UI 走 slots）。官方 ui-chat 对 ui-conversation 是 import type{} 零运行时边。应把共享类型下沉 ui-slots/独立 contract 包。
- 【P1】全 7 包官方测试套件整体丢弃（官方 ui-conversation 30 测试文件/ui-chat 26 个，corum 0）且 fork 改了逻辑无回归网。应移植实质修改文件的对应用例。
- 【P1】7 份 inline-css.mjs 复制粘贴（md5 全不同、不同演化版本，脆弱 data-plugin 幂等判定）；7 份 tsdown.config ~86 行逐字复制循环参照。应收共享 preset。
- 【P1】依赖从官方 workspace:^ 改 npm ^0.1.2-alpha.1 全挪 dependencies（官方规范浏览器/类型关系只进 devDependencies）；源码对照官方 alpha.2 而依赖锁 alpha.1 双向差一代。
- 【P1】新增 UI 系统性硬编码中文绕过 locales 设施（EmptyStateHero/ConversationRoot/QuestionCard/ApprovalPanel/chat 的 'You'/'zh-CN'），en 词典下界面仍出中文。
- 【P2】lucide-react 与官方 ui-primitives 图标体系并存（同一权限概念两套图标）。二选一。
- 【P2】invariant companion 纯模板复制；settings-models invariant.ts 成死代码（exports 已删 ./invariant）仍被打包。

## corum-ui-conversation（P1）
ConversationRoot.tsx:12 未使用 import HeroShell；InputBar.tsx:36 未使用 import ContextMeter + :439 console.log('优化提示词') 调试遗留；大量死 CSS 类（.crumb*/.modes/.tbtn*/.dirField 等 20+ 类定义无 TSX 引用）；click-outside handler 三处重复；useEffect+alive flag 异步模式重复 6 处；apply.ts ctx.get('uiWorkspace')/ctx.get('connection') 硬取+双断言（connection 未声明 inject）；资源路径硬编码 corumapp://；裸操作 sessionStorage；无 ErrorBoundary、异步列表无 loading 态。

## corum-ui-chat（P0+P1）
- 【P0】ChatNodeSeat.tsx:153 工具调用折叠被硬编码禁用 const foldable=false（官方逻辑删了但折叠 UI 全套代码保留成死路径，rebase 必冲突）。
- 【P0】corum-reskin.css:21-58 全局 CSS 污染（[data-slot=...] button[class*="primary"] 等命中其它插件 DOM、类名 hash 变即失效/误伤、注入 style 无卸载机制）。
- 【P0】apply.ts:93,174 ctx.get('connection') as 两处硬取未声明 inject。
- 【P1】SubagentCard.tsx:53 running 写死 true（done 分支永不可达）+ correlateChild 只按时间猜子会话无 lineage 校验；turn 签名 ~ / | 裸字符串编解码未转义（模型文本含竖线即错位）+ decode 两处重复；review-source 订阅永不退订 + WeakMap 缓存每次全量 aggregateReviewChanges；AssistantMarkdown.tsx:131 渲染期 new Date() 流式重渲时间每秒变 + 时区硬编码 zh-CN；ChatView.tsx:688 t as unknown as 双断言；slots.ts:129 contract 层 inline import 渲染层 review-source（契约反向依赖渲染层）；getAgentName 手搓 RPC 重复造轮子 + inject 每次新闭包致重复重跑 + sid.startsWith('corum-task-') 写死命名约定；MessageItem 删官方「无 hover 设备最新行常显」可达性设计。
- 【P2】review-changes write/create 整文件计 added 统计误导；review-revert write/insert 一律 skipped 但 ok 判定 skipped===0 致含 write 的「全部撤销」永报失败卡片永不消失；cwd 快照非响应式；ReviewCard 展开无 aria-controls/无虚拟化。

## corum-ui-settings-models（P1，无 P0）
package.json description 声明不实（自称「其余逐行一致」实际删官方 operations.ts 109 行封装层、14 文件 380 行改组件直持 Remote wire face——改造质量良好但未声明）；lib/ 产物过期（14 源文件新于 lib/client.js + 幽灵残留 + tsbuildinfo 不同步）；ModelListEditor 图片开关无样式裸 checkbox；onboarding-copy.ts WELCOME_NOTICE_COPY 死代码双事实源。

## corum-ui-model-selection（教科书式最小 fork，无需整改）
model-unavailable 从错误 toast 改信息提示，实现精确克制零漂移。仅 2 个 P2（冗余可选链、scope.get as）。

## corum-ui-questions（P0+P1）
- 【P0】QuestionCard.tsx:198「跳过本题」按钮 wired 到 cancel()（取消整组提问拒绝 waterfall）而非逐题跳过；「放弃整组」X 按钮也调 cancel 两按钮同义。skip 语义错误。
- 【P1】注册 NS='corum-question' 词典（含全部键）+ 声明 locale:NS，组件却全硬编码中文 t() 一次未用（词典形同虚设）；pending 切换状态残留（questions 变化 index/drafts 不重置，第二组题数少于 index 会 current===undefined 白屏静默）——官方靠 key={pending.key} 重挂载；QuestionDock uSES 每次返回新扫描结果违反「快照引用稳定」规范；contract.ts:42-126 自实现 PendingQuestion 与官方同形复制（80 行结算生命周期双事实源，官方修复不联动）。
- 【P2】composer block reason 硬编码中文 + 手搓接口而非复用现成类型；inline style 与 CSS Modules 不一致；busy-finally 重复。

## corum-ui-approval（P1）
ApprovalPanel.tsx:38,63,78-80 硬编码中文/品牌名（'Corum Agent' 未走 t()）locales 设施完好却不用；「始终允许」菜单永久 disabled 死 UI 暴露；menuOpen 无 click-outside/Escape（同群 ModelSelect 有，规范不统一）；引 lucide-react。

## corum-session-archive（最小包，质量最高）
inject 声明 ['slots','locale'] + dependencies 保留 6 个 UI 依赖，但「UI entries 已移除」slots/locale 零使用、locales.ts 71 行成死代码（声明与现实脱节，inject 应改 [] + prune deps + 删 locales）。controller.ts 并发去重/disposed 竞态检查是全群质量最高的新写代码（标杆）。

## 与官方对齐点（fork 纪律好）
数据通路零漂移（chat 的 conversation-nodes 15 大文件仅 import 改名；conversation 核心 assembler/facade/location-index/machine 逐字节相同；rebase 成本集中在 ~20 个实质修改文件）；插件契约形状对齐；契约扩展方式正确（新增可选字段不改官方字段）；审批/提问 waterfall 生命周期逐行一致；model-selection 教科书式最小 fork。

## 偏离理由评估
成立：uiWorkspace 可选降级（环境限制）、hero 语义改 hasSession（产品需求）、提问改 dock 卡片（不遮盖对话）、PendingQuestion 自实现（官方只 export type）。
不成立：chat 运行时 external/re-export conversation（违反 export discipline）、ChatNodeSeat 折叠禁用（删逻辑留死代码）、lucide-react、全局 noImplicitAny:false、测试整体丢弃。
部分成立：settings-models 删 operations.ts（质量好但未声明）、corum-reskin 全局换肤（markdown 部分成立、跨插件选择器不成立）。

## 重复造轮子
PendingQuestion 运行时类（被迫成立）；getAgentName 手搓 RPC（可避免）；inline-css×7/tsdown×7（官方是共享 preset）；click-outside/alive-flag 模式各处重复；TurnUsageDisclosure 取代官方（有意重设计）。

## 值得肯定
fork 注释文化好（// fork（corum）：/CORUM-PATCH: 标注+日期+原因，rebase 可检索）；session-archive/controller.ts 新写代码标杆；questions/index.tsx 头部注释把架构决策写清；model-selection errorKind 克制；settings-models 传输失败 try/catch 补强修官方真实缺口；locale 键集自检（satisfies Record）zh/en 同构编译器保证。

## B 给出的整改优先级
①恢复全包 strict（P0，一小时）；②处理 ChatNodeSeat 折叠死代码 + corum-reskin 全局污染（P0，rebase 前必须）；③修 QuestionCard「跳过本题」语义 bug + key 重置（P0/P1 用户可见）；④connection 服务入 inject（chat/conversation 各两处）；⑤收敛 7 份构建脚本/配置；⑥新增 UI 字符串全量入 locales；⑦从官方 tests 移植核心回归用例。
