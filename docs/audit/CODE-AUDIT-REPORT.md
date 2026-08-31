# corum-desktop 代码审计与整改报告

> 审计方式：4 个子 Agent 并行分片深度审查（只读，未改任何文件），覆盖全部源码约 5.15 万行 / 30 个包；主 Agent 另做横切检查（typecheck、依赖、复制粘贴、git 卫生）交叉验证。
> 对照基线：`/Users/kukucai/dsh` 官方源码及 `AGENTS.md` / `packages/client/AGENTS.md` 官方规范。
> 审计日期：当前工作区 HEAD（`aa74de49`）。
>
> 分片原始报告存于 `.dbg/audit-{A-shell-host,B-session,C-ide-ui,D-agent-eng}.md`，主 Agent 横切事实存于 `.dbg/audit-crosscut-findings.md`。

---

## 一、总体结论

这是一套**架构判断力很强、工程纪律中上**的 dsh 发行版。核心资产质量很好：

- **架构红线守住了**：官方能力（agent/preset/MCP/skill/会话数据通路）全部 wrap 而非 rewrite。`corum-agent-dev` 把 AgentProfile 编译落盘到官方 `.agent-presets` 目录、走 `agentPresets.mount` 官方组装链路，是教科书式的「不改内核只做用户空间」。session 插件群的核心数据通路与官方零漂移。Electron 安全姿态（contextIsolation/nodeIntegration:false/sandbox）与官方壳一致。
- **差异化是真差异化**：GridView 自由网格 + 浮动窗 + 液态玻璃主题是官方没有的能力，数据模型（分割树 + min 传导 + 让位传导）实现质量高。
- **卫生基线好**：显式 `any` 仅 1 处、TODO 仅 1 处、无 `dangerouslySetInnerHTML`、无产物入库、无幽灵依赖、dsh 版本全仓 100% 对齐（315×`^0.1.2-alpha.1`、26×cordis `^4.0.1`）、跨组静态 import 为 0。

**主要短板高度集中在五条系统性主线**（四份报告互证，非孤立个例）：

| 主线 | 覆盖范围 | 严重度 |
|---|---|---|
| **① 类型纪律失守**：`noImplicitAny:false` 全插件群统一关闭 + 多处 `as` 穿透官方类型边界 | 20/26 插件包 | **P0** |
| **② 质量工具链全缺失**：0 lint/format/test/git-hook，1.3 万行官方测试整体丢弃无替代 | 全仓 | **P0** |
| **③ 安全若干真洞**：渲染层权限放大、CDP 开放、stdio 协议无校验、密钥明文落盘 | 壳/host/agent | **P0** |
| **④ 脚手架/退役产物滞留**：双 AgentRuntime、孤儿目录、退役包、测试探针、微信小程序残留 | workspace/git | **P1** |
| **⑤ 契约/文档漂移**：README 目录契约与实际脱节、复制粘贴构建基建（21+26+14 份）、运行时状态混入 git | 全仓 | **P1** |

**综合评级：良好（B+）**。无颠覆性架构错误，但 P0 项触及「类型防线、质量门禁、安全边界」三条命脉，应在下一轮迭代优先处理。

---

## 二、P0 级发现（正确性 / 安全 / 架构红线，必须整改）

> 共 15 项。每条标注来源分片（A/B/C/D）。

### 🔒 安全（5 项）

| # | 位置 | 问题 | 整改 | 源 |
|---|---|---|---|---|
| P0-1 | `host/corum-fs.ts:106-145` | **权限放大（全场最严重）**：`revertWrites` 的 `root` 直接来自渲染层请求参数。realpath 只防逃出 root，而 root 本身由调用方指定——任何持有 dsh-auth cookie 的本机页面可写 host 任意目录（`root=/Users/x, path=.ssh/authorized_keys, kind=restoreContent`） | root 必须来自服务端会话/泳道注册表，或至少校验在 host cwd 之下 | A |
| P0-2 | `electron/main.ts:243` | `remote-allow-origins: '*'` + CDP 端口绑 0.0.0.0 语义：本机任意网页可 `fetch localhost:<port>/json` 接管整个 Agent 窗口调试会话（含审批） | 同时 pin `remote-debugging-address=127.0.0.1`，allow-origins 收窄为实际 origin | A |
| P0-3 | `electron/bridge-client.ts:134-141` + `host/bridge.ts:49-55` | stdio JSON 协议无校验无超时：sessionImport 的 zipBase64 无大小上限（zip-bomb 打爆 host 内存）；sessionExport 无超时（host 卡住→before-quit 永久挂住退出流程）；stdin 帧无 type 判别 | 加超时 + 64MB 上限 + unzip size filter + 帧校验 | A |
| P0-4 | `electron/bridge-client.ts:74-78` + `electron/combos.ts:112-141` | spawn env 整体替换语义 + `combo.env` 无校验透传：用户 combos.json 可写 `NODE_OPTIONS=--require /evil`（文件无权限校验） | spawn 强制合并最小白名单；env 值做 NODE_OPTIONS/LD_PRELOAD/DYLD_* 黑名单过滤（抄官方 BOOTSTRAP_NAMES） | A |
| P0-5 | `agent/corum-agent-dev/src/compile.ts:183` | MCP `env`（常含 API key/token）明文落盘 preset 目录 + `mcp-servers.json`，与 profile 同位置无额外保护，每个引用该 MCP 的 profile 复制一份 | 短期文档明示；中期对齐官方 `dsh-credentials`，敏感 env 引用凭据 id 或写 `$占位` 运行时注入 | D |

### 🏗️ 架构红线（3 项）

| # | 位置 | 问题 | 整改 | 源 |
|---|---|---|---|---|
| P0-6 | `session/corum-ui-chat` ↔ `corum-ui-conversation` | **feature 插件互相依赖**：chat 对 conversation 类型+运行时双重依赖（30+ 处非 type-only import + `tsdown.config.ts:23-24` 列 external + `index.ts:46,49` re-export）。官方规范：feature plugin MUST NOT runtime-import/re-export 另一 feature plugin 的值或声明 external 获取（行为走 Cordis 服务、UI 走 slots） | 共享类型（ConversationNodeDefinition 等）下沉 ui-slots 或独立 contract 包，chat 只留 type-only 依赖 | B |
| P0-7 | `host/session-archive.ts:47-83` | `projectKey`/`encodeSegment` 逐行复制官方 `session-persistence-jsonl/format.ts`（官方未导出、明示 `SESSION_FORMAT_VERSION` 无兼容承诺）。格式漂移→导入静默写错路径、删除时按旧规则 resolve 出**别的会话目录误删** | 推动官方导出 format helpers（或 createRequire require lib/format.js + 版本断言）；至少校验 header 的 SESSION_FORMAT_VERSION | A |
| P0-8 | `host/boot.ts:326` | 每次启动无条件重写 profile 根 cordis.yml：使官方 HMR live-reload（watchUserPatches）失能 + 与官方 tree write-back 竞态，被迫发明 plugins.disabled.json 第二持久层、丢 withFileLock 跨进程保护 | 仅内容不同时写 + 接 withFileLock；长期上推官方做成 Loader 显式选项 | A |

### 🧱 类型防线（2 项）

| # | 位置 | 问题 | 整改 | 源 |
|---|---|---|---|---|
| P0-9 | 20/26 插件包 `tsconfig.json` | **`noImplicitAny:false` 全插件群统一关闭**（14 个 IDE-UI 包逐字节相同 + 6/7 session 包），覆盖根 base 的 `true`，且 session 群不再 extends 官方 `base.client.json`、删 project references。~5 万行 fork 失去最基本类型防线，回归无法被 CI 捕获 | 删除该行恢复 strict，逐包修暴露问题（B 评估约一小时起） | B/C/D 互证 |
| P0-10 | `ui/corum-ide-statusbar-ui` + `ui/corum-ide-test-statusbar-ui` | **typecheck 失败**（主 Agent 实测）：注册 `corum.statusBar` 槽但该槽已无人声明/未入 SlotMap 联合类型（`index.ts:31/28` TS2345/TS2769、`StatusBar.tsx:20` TS2344）。状态栏功能已移除但代码滞留 | 随主线④清理这两包即解决；删除前先解决（见 P1-脚手架） | 主+C |

### 🐛 用户可见正确性 bug（3 项）

| # | 位置 | 问题 | 整改 | 源 |
|---|---|---|---|---|
| P0-11 | `session/corum-ui-questions/QuestionCard.tsx:198` | **「跳过本题」按钮 wired 到 `cancel()`**——取消整组提问并 ASK_CANCELLED 拒绝 Host waterfall，而非逐题跳过；「放弃整组」X 按钮也调 cancel，两按钮同义，与官方 skip 语义完全不符 | 实现真逐题跳过（推进 index、该题空答），或改文案为「放弃」并与 X 合并 | B |
| P0-12 | `session/corum-ui-chat/chat/ChatNodeSeat.tsx:153` | 工具调用折叠被硬编码禁用 `const foldable = false`：官方折叠逻辑删了但折叠 UI 全套代码（:155-224）保留成死路径，长 turn 几十工具调用裸铺，rebase 必冲突 | 若确认不折叠就连 TurnProcessNodeView 折叠分支一起删；更稳妥做成 ChatSettings 开关 | B |
| P0-13 | `session/corum-ui-chat/corum-reskin.css:21-58` | **全局 CSS 污染**：`[data-slot=...] button[class*="primary"]` 等属性/子串选择器命中其它插件 DOM，官方类名 hash 变即静默失效/误伤；注入 `<style>` 无卸载机制（HMR/dispose 不移除） | 可挂类名的收回各 .module.css；markdown pre/code 加本包锚点；dispose 时移除 style 节点 | B |

### 🧪 质量门禁（2 项）

| # | 位置 | 问题 | 整改 | 源 |
|---|---|---|---|---|
| P0-14 | 全仓 | **质量工具链完全缺失**：0 eslint/oxlint/prettier/biome、0 vitest、0 lefthook/husky、0 测试文件、无 AGENTS.md。对照官方（lefthook 6 job + vitest 多 config + .oxlintrc + 100+ verify 脚本 + jscpd）差距最大 | 最小起步：lefthook + oxlint pre-commit typecheck；补 vitest；补 AGENTS.md（见整改路线图） | B/D 互证 |
| P0-15 | 全部 7 个 session 包 | **官方 ~1.3 万行测试套件整体丢弃**（官方 ui-conversation 30 个/ui-chat 26 个测试文件，corum 0），且 fork 改了逻辑（ChatView/ChatNodeSeat/EmptyStateHero 等）无任何回归网 | 至少对实质修改的 ~20 个文件从官方 tests 移植对应用例 | B |

---

## 三、P1 级发现（明显坏味道 / 规范违规，应整改）

> 归纳为 6 大主题，含代表性条目（完整清单见分片报告）。

### 主题 1：仓库 / workspace 卫生（git 混入运行时与无关产物）

| 位置 | 问题 | 整改 | 源 |
|---|---|---|---|
| git 根 | `.corum-dev-home-ide/`(6) + `.corum-ide-home/`(6) 运行时状态、根 `.agent-presets/`（**67 文件** preset+CSV）被 git 追踪；`.gitignore` 漏 `.corum-dev-home-ide/`、`.agent-presets/` | `git rm -r --cached` + 补 ignore（或统一 `/.corum*-home*/`、`/.agent-presets/`）；preset 若要版本化迁 `profile/` 并说明 | D（主 Agent 已独立确认 12 文件） |
| git 根 | `project.config.json` / `project.private.config.json` 是**微信小程序残留**（compileType:miniprogram、appid wx181c...）与本项目无关却入库 | 确认后 `git rm` 删除 | D |
| workspace | **双 AgentRuntime 并存**：`corum-project-core/src/runtime.ts`（dev/test/pm 三角色）是被 `corum-agent-dev/src/runtime.ts`（项目×角色×泳道）取代的早期运行时，同名类、功能重叠，仍会被 build | 明确去留：取代则移出 workspace/归档，避免双 runtime 同时 apply 调度分叉 | D |
| workspace | `ide-test-panel` **孤儿目录**（无 package.json、src/scripts 空、仅 lib 残留，全仓无引用）；3 个 `corum-ide-test-*-ui` 是已完成使命的 S0 探针；`corum-ide-conversation-ui`（1588 行）已在 patch.yml 注释退役；`corum-ide-ui/TestModule.tsx` 死 import | 删除/移到 attic/；清理 desktop-host+desktop 两处 dependencies + ide-ui 的 EXCLUDE 条目 | C |
| git | `lib/` 构建产物过期：`settings-models` 14 源文件新于 lib/client.js + 幽灵 d.ts 残留 + tsbuildinfo 不同步 | 全量重建；打包流程校验产物新于源码 | B |

### 主题 2：壳/host 健壮性（超时、校验、竞态、资源管理）

| 位置 | 问题 | 整改 | 源 |
|---|---|---|---|
| `electron/ipc.ts` 多 handler | IPC 入参零校验（slotKey/sessionId 直接拼标题/URL/文件名）；`corum:delete-session` 未 sanitize | 每 handler 入口 typeof 守卫，失败返回 `{ok:false}` | A |
| `electron/ipc.ts:55` + `bridge-client.ts` | host-restart 无并发保护 + restart 不清 pendingSessionOp → 旧 pending 悬挂永不 resolve | restart 内把所有 pending resolve({ok:false}) 并 clear；加互斥 | A |
| `electron/main.ts:194,226` | spawnHost onReady 仅打印日志（host 崩溃重启后窗口停旧 dead URL）；ready 无超时；user-data-dir 默认落 `os.tmpdir()`（多用户可读 dsh-auth cookie + tmp 清理删 profile） | ready 加 30s 超时；重启后主动 loadURL；user-data-dir 改 appData | A |
| `host/boot.ts:144,253,419` | `OFFICIAL_DEV_PRESETS` 硬编码 `/Users/kukucai/dsh` fallback（且 cli.ts DSHSANITIZE 误删 DSH_CHECKOUT → 永远读硬编码路径，**确凿 bug**）；`healProfilesModuleFallbackRegistry` 丢官方 withFileLock（多实例并发 heal 覆盖）；settings 服务 100ms 短轮询 15s 静默放弃 | 修 DSH_CHECKOUT 净化或 pack 时删 fallback 并 warn；引入 withFileLock；改 ctx.inject 正式注册 | A |
| `host/plugin-manager.ts:287,419` | pnpm spawn 无超时无并发互斥；search 无超时无缓存 + registry 硬编码 registry.npmjs.org（企业镜像搜不到）；重抄官方 cli plugin.ts reconcile | 加超时/互斥/缓存；registry 走 Config；评估复用/上推官方导出 | A |
| `electron/combos.ts:24,143` | combo 配置用 `~/.corum-desktop` 而 host home 是 `~/.corum`（命名不一致未迁移）+ 全程同步 IO + writeUserCombos 无原子写 | 统一 home；用官方 dsh-atomic-write | A |

### 主题 3：壳层绕过自建模型（IDE-UI 架构核心）

| 位置 | 问题 | 整改 | 源 |
|---|---|---|---|
| `corum-ide-ui/AppFrame.tsx:421-557` | 挂 4 个 window CustomEvent 桥（SET_REGION_HIDDEN/CLOSE_REGION/TOGGLE_SIDEBAR/RESET_LAYOUT）绕开自建槽位/服务模型；`BottomPanel.tsx:40` 硬编码事件字符串而非 import 常量；另有 `corum:open-new-task-form`+sessionStorage 跨包字符串耦合无单一事实源 | 把「区域显隐/关闭/重置」做成 LayoutController 方法经 `ctx.layout` 调用，删全部 CustomEvent | C |
| `corum-ide-ui/index.tsx:367-408` | 裸读 `__DSH_BOOT__.entries` 用了不存在的字段（绕过官方 parseBootManifest 校验）+ 36 条硬编码 EXCLUDE 清单猜「哪些插件有 UI」 | 经 parseBootManifest 解析；长期改插件自声明 dsh.client 元数据而非壳猜 | C |
| `corum-ide-ui/AppFrame.tsx:144-191,587` | Agent 标题栏全硬编码假数据（"7轮·12m34s·命中61%"）呈现在正式主界面每屏；每 400ms 全文档 querySelector 轮询对齐标题栏（脆弱+浪费） | 接 dsh-session-stats 投影，未接通前隐藏；几何从 grid state/computeCellSizes 直算 | C |

### 主题 4：契约 / 依赖 / 数据层（agent + session）

| 位置 | 问题 | 整改 | 源 |
|---|---|---|---|
| `agent/corum-agent-dev/runtime.ts:415-432` | `lastEventId` 实例级共享可变状态，reassignTask 因果边不可靠（并发 record 读错） | cancelTask 透传 record 返回值，删 lastEventId 字段 | D |
| `agent/corum-agent-dev/agent-service.ts:497,1266` | task 会话索引寄生伪项目目录 `'task'`（TASK_PROJECT_ID='task'），与项目 id 命名空间碰撞，createProject 无保留字校验 | task 索引改独立根；或 createProject 加保留字表 | D |
| `session/corum-ui-chat/apply.ts:93,174`、`conversation/apply.ts:222-240` | `ctx.get('connection') as ConnectionHandle` 硬取未声明 inject 的服务 + 强转（多处） | connection 显式声明进 dsh.client.inject，用 cordis 类型合并取服务 | B |
| `session/corum-ui-chat` 多处 | SubagentCard `running` 写死 true（done 分支永不可达）+ correlateChild 只按时间猜子会话无 lineage；turn 签名 `~/|` 裸字符串编解码未转义（含竖线即错位）+ decode 两处重复；review-source 订阅永不退订 + 每次全量 aggregateReviewChanges；AssistantMarkdown 渲染期 new Date() 流式重渲时间每秒变 | 逐条修（接通子会话事件/JSON 编码/跟随 ctx.effect 退订/time 取 node 数据） | B |
| `session/corum-ui-questions/index.tsx:88` + `QuestionCard.tsx:62` | QuestionDock uSES 每次返回新扫描结果（违反「快照引用稳定」）；pending 切换状态残留（questions 变化不重置，第二组题少时 `current===undefined` 白屏静默） | 提供稳定 selector；使用处加 `key={pending.key}` | B |
| `session/corum-ui-settings-models/package.json` | **声明不实**：自称「其余逐行一致」实际删官方 operations.ts 109 行封装层、14 文件 380 行改组件直持 Remote wire face（改造质量良好但未声明） | 如实更新描述并文档化该改造 | B |
| `session/corum-session-archive/index.ts:13,17` | inject 声明 ['slots','locale'] + dependencies 留 6 个 UI 依赖，但 UI entries 已移除、slots/locale 零使用、locales.ts 71 行成死代码 | inject 改 []、prune dependencies、删 locales.ts | B |

### 主题 5：i18n / 文案（违反官方 locale-owned 强制规则）

| 位置 | 问题 | 整改 | 源 |
|---|---|---|---|
| session 群新增 UI（EmptyStateHero/ConversationRoot/QuestionCard/ApprovalPanel/chat 的 'You'/'zh-CN'）+ IDE-UI 群（AppFrame aria-label、PluginManagerPanel、SidebarSkeleton、BottomPanel） | **系统性硬编码中文**，locales 设施完好却不用（QuestionCard 注册了 corum-question 词典含全部键，t() 一次未用，词典形同虚设）；en 词典下界面仍出中文 | 全部字符串入 locales.ts；时间复用官方 formatMessageClock；品牌名走 brand 配置 | B/C |
| `electron/combo-page.ts:112`、`ipc.ts:213` | combo 页/原生对话框中文硬编码；`lang=zh-CN` 与窗口标题双语不一致 | 发行版可豁免但建议统一 | A |

### 主题 6：复制粘贴基建漂移（应对照官方共享 preset）

| 位置 | 问题 | 整改 | 源 |
|---|---|---|---|
| 全仓 | **21 份 `inline-css.mjs`**（md5 全不同、31~73 行不同演化版本、脆弱 data-plugin 幂等判定）；**26 份 `tsdown.config.ts`**（~86 行逐字复制、循环参照）；**14 份 tsconfig.json 逐字节相同** | 收敛为共享 preset（官方有 `packages/client/tsdown.client.ts` 先例）：inline-css 按包名参数化、tsdown 抽共享工厂、tsconfig 抽公共 extends | B/C/主 |
| `corum-ui-base/theme-presenter.ts` | fork 落后官方（51 行 vs 官方 68 行，缺 `--dsh-content-font-size` 字号轴）+ 被 4 个 bundle 各自内联实例化（dev 模式若官方 ui-layout 未禁用会双 presenter 写同一 body） | 从官方新版重 fork；dev 包只在官方 ui-layout 已禁用组合里挂 | C |
| `corum-ide-ui/plugin-meta.ts:18-174` | 手写 ~150 个官方包中文元数据表（官方包增删即漂移，fallbackName 格式化出半吊子名） | 明确维护策略（生成 or 删减范围） | C |

---

## 四、P2 级发现（改进建议，择期处理）

按主题归并（完整含行号见分片报告）：

- **死代码 / 调试遗留**：`agent-service.ts:320,1140` 裸 `process.stderr.write` 诊断留主路径；`event-log.ts:116,299` 三元两分支相同死代码；`InputBar.tsx:439` `console.log('优化提示词')`；多个未使用 import（HeroShell/ContextMeter）；session/IDE 大量死 CSS 类（.crumb*/.tbtn*/.dirField 等 20+）；`settings-models/invariant.ts` 死文件仍打包；`onboarding-copy.ts` 双事实源死代码。
- **类型收紧**：IDE 群 9 处 `ctx.get('connection') as` + 3 处 `ctx as unknown as {uiSession}`（官方已做声明合并，应 type-only import 后 `ctx.connection`/`ctx.uiSession`）；`AppFrame.tsx:708,785` renderSlot 强转（应封装带注释 helper）；`ChatView.tsx:688` t 双断言；`protocol.ts:57` 死返回值；`cli.ts:14` 双断言。
- **React 写法**：index 键（AgentTestPanel/McpManagerPanel KvEditor 删中间行复用错 DOM/RuntimeTestPanel）；`FileExplorer.tsx:128` 在 setState updater 内发网络请求（updater 须纯函数）；轮询 effect 依赖高频状态（eventSeq/fromSeq）致 interval 反复重建（改 ref）；`FloatingLayer.tsx:91` updater 内调 onClose 副作用；`McpManagerPanel` toastTimer 未 unmount 清理；click-outside / alive-flag 异步模式多处重复（提取 useClickOutside/useAsyncData）。
- **包/构建规范**：`exports["./client"].types` 指向 src 而非 lib（agent-ui-dev/rpc-client/skill-manager-ui-dev/team-ui-dev），`corum-ui-base` `./client.default` 直指 src（运行时吃源码 TS）；`workspace:*` 与 `workspace:^` 混用；21 个包 tsconfig 冗余 noImplicitAny；`@types/react-dom` 两版本段并存；图标 lucide-react 与官方 ui-primitives 并存（二选一）。
- **文档/配置**：`.npmrc` 指 localhost:4873 私服但 README 快速开始未提前置依赖、pnpm-lock 无 localhost 引用（来源不一致）；`pack-macos.mjs:26-33` 大量 `packages/shell` 路径（包已改名 desktop，脚本当前必然失败）；`desktop/package.json` description 仍写「zero HTTP」与 0.1.2 loopback 架构矛盾、dependencies 混入 25 个 client UI 包。
- **a11y**：ApprovalPanel 无 click-outside/Escape（同群 ModelSelect 有，规范不统一）；「始终允许」菜单永久 disabled 死 UI 暴露；ReviewCard 展开无 aria-controls/长列表无虚拟化；MessageItem 删官方「无 hover 设备最新行常显」可达性设计。
- **规范细节**：JSDoc 缺 @param/@returns；`new AbortController().signal` 永不可 abort（误导）；`main.ts:149` Electron<30 legacy 分支已死可删；`client/index.ts:45` `window.__corumNotify` 调试钩子无 DEV 守卫。

---

## 五、整改路线图（按优先级与投入产出排序）

### 第一刀（安全 + 类型防线，1~2 天，高 ROI）
1. **修 P0-1 corum-fs root 权限放大**（渲染层可写任意目录——最严重）
2. **修 P0-2 CDP allow-origins + loopback 绑定**
3. **恢复全插件群 strict 类型**（删 20 个包 `noImplicitAny:false`，逐包修；B 评估一小时起）
4. **删 `corum-ide-statusbar-ui` + `corum-ide-test-statusbar-ui` 让 typecheck 转绿**（顺便解决 P0-10，并入主线④）
5. **修 P0-11 QuestionCard「跳过本题」语义** + P0-12 ChatNodeSeat 折叠死代码 + P0-13 reskin 全局污染（用户可见 + rebase 前必须）

### 第二刀（质量门禁 + 仓库卫生，2~3 天）
6. **引入 lefthook + oxlint**（参考 dsh `scripts/run-oxlint.ts`），pre-commit 强制 typecheck
7. **补 vitest**：优先给逻辑密度最高的 `event-log.ts` fold 状态机、`runtime.ts` 阻塞/唤醒、`project-data-service.ts` 状态机（TASK_FLOW/BUG_FLOW）补单测；从官方 tests 移植 session 实质修改文件用例
8. **仓库卫生**：`git rm --cached` 运行时目录 + 删微信小程序残留 + 补 `.gitignore`；清理双 AgentRuntime（project-core）、ide-test-panel、3 个 test 插件、退役 conversation-ui
9. **收敛复制粘贴基建**：inline-css / tsdown.config / tsconfig 抽共享 preset

### 第三刀（架构收口 + 契约，3~5 天）
10. **修 P0-6 chat→conversation 依赖红线**（共享类型下沉 contract 包）
11. **修 P0-7 session-archive 物理编码复制**（上推官方导出 helpers + 版本断言）
12. **修 P0-8 根 cordis.yml 重写**（条件写 + withFileLock，上推官方 Loader 选项）
13. **壳层 CustomEvent 桥 → ctx.layout 服务方法**（删全局事件通道）
14. **裸读 __DSH_BOOT__ → parseBootManifest**；动态网格槽 key 收敛为 SlotMap 已知 key 联合类型（两全编译期校验 + 运行时动态）
15. **补 P0-3/P0-4 stdio 协议校验/超时/env 黑名单**
16. **文档契约重写**：README 目录契约改 `packages/desktop` + `plugins/{agent,session,ui}`、`corum-shell`→`corum-desktop`；`docs/TODO.md` 批量替换；`doc/`并入 `docs/`；补 AGENTS.md

### 第四刀（体验与一致性，持续）
17. 新增 UI 字符串全量入 locales（消灭硬编码中文）
18. Agent 标题栏接 dsh-session-stats 真实数据（未接通前隐藏假数据）
19. 图标体系统一（lucide vs ui-primitives 二选一）
20. 各 P2 类型收紧 / React 写法 / a11y 逐个销项

---

## 六、与 dsh 官方的对齐 / 偏离总览

| 维度 | 判定 | 说明 |
|---|---|---|
| agent/preset/MCP/skill 能力 | ✅ **对齐（wrap）** | 编译落盘走官方组装链路，一行官方代码未改 |
| 会话数据通路（snapshot/assembler/facade/waterfall） | ✅ **零漂移** | rebase 成本集中在 ~20 个实质修改文件 |
| Electron 安全姿态 / boot 层序 / overlay 写法 / authenticatedUrl | ✅ **对齐** | 与官方壳/bundle 逐字段一致 |
| 自由网格 + 浮动窗 + 液态玻璃主题 | ✅ **真差异化** | 官方没有，非重复造轮子 |
| feature 插件依赖纪律 | ❌ **偏离（P0-6）** | chat 运行时依赖 conversation，违反 export discipline |
| 类型纪律（strict/noImplicitAny/多余 any） | ❌ **偏离（P0-9）** | 全插件群关闭 strict |
| 质量工具链（lint/test/hook/verify） | ❌ **严重偏离（P0-14/15）** | 全空白，对照官方差距最大 |
| 文案 locale-owned | ❌ **偏离** | 新增 UI 系统性硬编码中文 |
| 重复造轮子 | ⚠️ **基本克制** | 个别（getAgentName RPC/inline-css×N/build 配置）可避免；streamFollow 已被团队自我纠偏 |
| 偏离有正当理由的 | ⚠️ | realpath 锚点修复（pnpm isolated 布局）、SettingsShell fork（portal 问题）、uiWorkspace 降级、提问改 dock——论证充分，但部分连官方机制（withFileLock/HMR）也丢了，超出必要范围 |

---

## 七、值得肯定的做法（应保持）

1. **preset 编译落盘 + 官方 mount 的 wrap 架构**——全仓最正确的决策，`renderScalar` 对 `!!js ` YAML 标记的处理说明真读过官方语义而非照抄。
2. **event-log「事件是唯一事实源，状态是派生物」**——append-only + 崩溃半行截断 + seq 连续性校验拒载 + 重启 fold 恢复，事件溯源扎实落地。
3. **pendingPermissions 延迟落盘**——「未发第一条消息不留 session 记录」精准对齐官方 lazy materialization（考据式对齐贯穿 agent-service.ts）。
4. **权限网关「角色由 exec.agent 反查、模型不可自报」**——从设计上焊死「模型伪造 role 越权」，安全模型想得清楚。
5. **cordis.patch.yml 组合纪律极佳**——每行禁用写明「为什么禁/谁接管/不接管的后果」，官方包零改动。
6. **fork 注释文化**——`// fork（corum）：`/`CORUM-PATCH:` 标注 + 日期 + 原因，rebase 可检索；`// 踩坑`记录翔实。
7. **session-archive/controller.ts 与 questions/index.tsx 头注**——并发去重/disposed 竞态/架构决策写得清楚，是新写代码标杆。
8. **minimumReleaseAgeExclude 380 行完整维护 + cdp.sh 精确清理纪律**——供应链安全意识与真实踩坑后的工程成熟度。

---

### 附：审计执行记录
- **A**（Electron 壳+host，30 文件逐行）：6 P0 / 16 P1 / 10 P2 → `.dbg/audit-A-shell-host.md`
- **B**（session 群 32230 行，逐文件 diff）：7 P0 / 多 P1/P2 → `.dbg/audit-B-session.md`
- **C**（IDE-UI 群 1.9 万行）：9 P1 / 9+ P2 → `.dbg/audit-C-ide-ui.md`
- **D**（agent 群 7100 行 + 工程规范）：评级 B+，0 P0 / 3 P1 → `.dbg/audit-D-agent-eng.md`
- **主 Agent 横切**：typecheck 逐包实测、依赖/复制粘贴/git 卫生 → `.dbg/audit-crosscut-findings.md`

各分片结论在「类型纪律、工具链缺失、复制粘贴漂移、脚手架滞留、文档漂移」上高度互证，可信度高。
