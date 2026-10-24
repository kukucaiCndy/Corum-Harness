---
name: corum-dev-conventions
description: Use when changing anything in this repo (corum Agent OS / kkc-desktop) — a plugin, the desktop shell, the session/Agent mechanism, UI, or the build tooling. Carries the red lines that must not be broken, the change workflow (prove the owning surface → build the artifact that actually loads → three-layer on-device verification → drift guard → task log), and the traps that have already cost this project time.
---

# corum 开发规范（开发技能）

本技能是 corum Agent OS（kkc-desktop 仓库）开发规范的可执行投影：它讲「动手时按什么顺序做、什么绝对不能做、做完拿什么证明」。本技能是自包含的——所有核心规则直接写在下面，不引用任何项目内部文档路径。它是 guidance，不是脚本。

## 0. 一句话

**先证明你要改的那个面是谁在渲染 / 谁拥有，再动手；改完必须拿出真实运行的证据；「编译通过」不是完成。**

## 1. 红线（违反即回滚）

1. **跨 bundle 共享状态 = cordis service**，绝不用 window 全局或模块级单例。dsh 把 `@corum/*` 源码 inline 进每个 bundle，模块级状态按 bundle 分裂且永不合并（`__corumSidebarMode` 就是死写实例）；cordis service 的实例唯一性由 root context 的 `reflect.store` 保证，天然跨 bundle 单例。合法 window 挂载仅限「写一次、只读」的交接值：`window.corumDesktop`、`__corumNotify`、`__DSH_BOOT__`、`__corumSlotRegistry`。
2. **不随意 externalize `@corum/*`**：dsh 模块表有硬编码种子（9 as of 0.1.5-rc.3），走 `dsh.client` 插件路径自造共享模块会白屏。绕行方案是红线 1 的 cordis service。
3. **跨 bundle 类型脸不匹配 → 用本地能力接口收窄**：consumer 注入到的可能是官方基线的窄接口（corum 运行时是超集），不要耦合到实现包——用本地能力接口（capability interface + helper）收窄。
4. **消费 cordis service 走 `inject` 声明**，不要在未装配的服务上 `ctx.get`（`ctx.remote` 坑）。
5. **host 插件改动必须重启应用**（只有 renderer 走 HMR）；跨包状态 / 壳 / 调度改动必须过**三层实机验证**：界面渲染 + 行为 + 零新增控制台报错。
   - **不要从 `boot()` 的 patch 层栈里 filter 掉 disabled 行**。disabled patch 行有双重职责：①「这个插件被禁用」的索引标记；②**禁用官方包让 fork 独占 cordis service 名**的配置载体。`boot.ts` 里 `.filter(p => p.disabled !== true)`（#54）让官方 `dsh-subagent` / `dsh-sandbox` / `dsh-credentials-local` 重新激活，和 fork 包注册同名 service → `service "…" has been registered` → host bridge exit 1。想跳过 disabled 的 config I/O，改在 cordis 内部做（不解析 config），**绝不在调用方 filter 掉整行**。证据：`docs/LESSONS.md` §1.17；PR #55 回退了 #54 的 filter。
   - **打包时 electron-builder 调用前临时清空 `dependencies`**（`pack-macos.mjs` 的 `buildApp()` 已实现，调完恢复）。app 本体只 import Electron API，不 import dependencies 里的包——host 运行时全在 `build/host/`（extraResources）。不清空则 electron-builder 扫描 dependencies 的 node_modules 软链，遇到 pnpm `link:` override 指向工作区源码的包（`dsh-tools`/`dsh-fs-local`）会报 `must be under .pnpm/`。electron 在 devDependencies，清空 dependencies 不影响 electron 检测。证据：`docs/LESSONS.md` §1.18；PR #57。
6. **三个平台，每次改动都要过（核心原则）**：改完问一句「这在 darwin / linux / win32 上是否不同——三个都覆盖了吗？」**「编译过」与「我机器上跑得通」在这里都不算完成**——本仓最贵的失败是**隐式假设**（硬编码 `/bin/zsh`、`~/.corum-desktop`、只用 `/` 拼路径、macOS 交通灯像素内边距、POSIX 专用命令白名单），它们在第三个平台上**不报错、只是行为不同**。
   - **两种合法布局**：corum 自有代码可用 `platform/` 目录（一平台一实现）；**官方 fork 包沿用官方「同级文件」惯例**（`fs-local/src/{fsio.ts, win32.ts}`）——**同一包内不混用**。
   - **平台选择只跟随实际运行平台**（`getPlatform()` → `process.platform`），烘入常量（`__CORUM_TARGET_PLATFORM__`）只用于一致性断言与诊断，**不得用于选实现**。
   - **两道守卫缺一不可**：运行时断言（默认开启，抓「烘入值 ≠ 产物目标」）+ 冲烟的 `checkNodeRuntimePlatform()`（抓「产物内部混装」）。
7. **打包/发版：产物必须能证明它跑得起来，且平台专属依赖按「类」校正**（2026-10-12 Windows 白屏事故的直接对策）：
   - **出包必过产物启动断言**：`pnpm assert:boot`（= `scripts/assert-packaged-boot.mjs`），用**产物自带的** Node 跑**产物自己的** host 桥，断言 `exit 0` + `{"type":"ready"` + 无致命行。无 GUI 依赖 ⇒ 无头 CI 可跑，已接进 `build-matrix`（硬门禁）与 `release`（发布阻断）。
     **判据**：「Pack 步骤绿」**不等于**包能用——那次白屏的包**每一步都是绿的**，electron-builder 对一个插件树加载不起来的包照样报成功。
   - **交叉出包时，用宿主平台跑的自检是假绿**：`pack-macos.mjs` 的 `smokeBridge()` 曾用宿主 Node boot 闭包，于是对那个「Windows 上白屏」的包照样打印 `host bridge boots OK`。现在目标≠宿主时**直接拒绝运行并告警**。**规则：目标≠宿主时，boot 自检是带警告的 no-op，绝不是绿勾。**
   - **平台专属 optional 依赖按「命名规律」校正，不许按包名白名单**：`pnpm deploy` 从**构建机**物化闭包，`optionalDependencies` 带的是宿主二进制。旧实现硬编码 `@koromix/koffi`，注释还断言「只有 koffi 有平台专属依赖」——而 `@vscode/ripgrep`、`@img/sharp`、`node-addon-require-builtin` **早已推翻它**。用 `parsePlatformPackageName()` 的 `<pkg>-<os>-<arch>[-<abi>]` 规律：版本 pin 自**主包声明**、取目标那份、**删宿主那份**，且**仅当目标≠宿主**。
     **判据别写错**：**不是**「Windows 包里不许出现 darwin 字样」（会误报 `node-pty` 全平台 prebuilds、`node-addon-system`（上游无 win32 包、降级为 `undefined`）、纯 JS 的 `dsh-win32-process`），而是「**目标平台的那份必须能解析到**」。
   - **缺一个原生绑定 = 整树 boot 失败，不是「某个功能降级」**：那次三个包各自都能让宿主插件树加载不起来（`sharp` 被 `dsh-attachment-local` 顶层 import；`node-addon-require-builtin` 供 loader 取 Node internal ESM loader，缺了它裸包名 `corum-desktop` 会按 loader 自己的目录解析而找不到；`ripgrep` 是功能级失败）。⇒ 遇到平台绑定缺失，**先问宿主树还能不能起来**。
   - **`unpacked` 目录名要对实机核对，别猜**：**不统一** —— macOS 是 `dist/mac-<arch>/Corum.app/Contents/Resources`，Windows/Linux 是 `dist/win-unpacked/resources` / `dist/linux-unpacked/resources`（**无 arch 段**）。用打包日志的 `appOutDir=` 核对。
   - **CI 出包成功 ≠ 包可用；不要用交叉打包发版**：三平台矩阵是**各 runner 本机打包**（win32 跑在 `windows-latest`），**根本不会触发**交叉闭包缺陷 ⇒ 矩阵可以绿而本机交叉打出的 Windows 包是坏的。每个平台的资产从**它自己的** runner 出；本机 `pack.mjs <别的平台>` 只当诊断手段。
   - **Windows 的 git 需要显式 `safe.directory`**：git 按**工作区根目录**属主判定「dubious ownership」（不是 `.git/` 的），把属于别的账户的已有目录加成工作区 ⇒ **所有** git 命令 exit 128（`init`/`add` 还能过，**第一个 `commit` 才炸**）。受影响用户通常**根本没有 `.gitconfig`**，所以别人设的全局 `safe.directory = *` 帮不上。用 `gitSafeDirectoryArgs(root)`（`['-c','safe.directory=<目录>']`、**仅 Windows**、**只放行该目录**、绝不用 `*`），唯一事实源在 `@corum/corum-platform/src/git-safe-directory.ts`。

## 2. 改动工作流（按这个顺序，别跳）

1. **确认目标面**：先拿证据回答「这一页/这个行为由哪个组件拥有」——读调用点、看 DOM/设计稿、跑一次真实会话。**没确认就动手，等于赌**（本项目多次踩：改错了组件、改对了组件但设计帧不对）。
2. **改拥有者，不改派生物**：`packages/desktop/shipped-presets/` 是官方 preset 的本地副本（升级会覆盖）、`lib/` 是产物、生成物改源头再重生成。
3. **构建真正被加载的那份产物**（最容易白干的一步）：每个插件包的 `lib/index.js`（host 半）/`lib/client.js`（client 半）是**运行时按包名加载的入口**，`tsc -b` 只更新 `lib/types/*`。改完 plugin 用时间戳自查：`find <pkg>/src -newer <pkg>/lib/index.js -name '*.ts*'`。
   - **日常**：`node scripts/build-all.mjs --changed`（只建自上次打包后改过的包 + 依赖它的包）。
   - **全量**：`node scripts/build-all.mjs`（按依赖**拓扑序**，每包都走完整三步，失败即停并指名道姓）。
   - **出包前必用 `--clean`**（用户 2026-10-17 定调）：见 §1.7。
   - ⚠️ 不要再手搓 `./scripts/corum-instance.sh build coding`：那套是**按包名白名单**逐包调用，2026-10-17 的新包（`corum-web-search` / `corum-issue-reporter-ui`）就是这样漏建、直到打包最后一步才炸。
4. **重启纪律**：host 插件 → 必须重启应用；renderer/client → 重建后刷新即可。重启主实例前记住：`./scripts/corum-instance.sh` 的兜底清理会跳过验证实例的整棵进程树。
5. **三层实机验证**：用 `corum-cdp-verify` 技能起**自己的验证实例**（`./scripts/corum-instance.sh start --home=verify`，CDP `:9333`），写声明式断言跑完整套（`scripts/ui-verify.mjs`）并截图留证。**绝不驱动或杀掉用户的主实例（`:9222`）**。
6. **跑守卫**：改了 fork 包 / 事件声明 → `./scripts/verify-fork-drift.sh`（fork 核心文件字节一致、事件声明↔allowlist 双向、域事件名对齐、host emit 存在性）；改了应用启动路径 → 确认 `scripts/app-launch-guard.sh` 仍拦得住沙箱内启动。
7. **出包/发版**（按 §1.7）：`node packages/desktop/scripts/pack.mjs <darwin|linux|win32> [--arch=]` 四步链（build → pack:host → pack:node → pack:app）→ **必跑 `pnpm assert:boot`**（产物启动断言，判据见 §1.7）→ 报产物时带上 SHA-256。**目标平台资产必须从它自己的 runner/机器出**（CI 矩阵已如此）；本机交叉打包只当诊断，**不要拿交叉产物发版**。
   - 要「重打包并重启本机实例」走 `./scripts/corum-instance.sh update --mode=packaged`：它现在是 **4 步**（`build-all --clean` → `build-all --verify` → `pack-macos.mjs --platform/--arch` → 重启），**不再**单独调 `electron-builder`（已被 `pack-macos.mjs` 的 `buildApp()` 接管，见 §1.5 第二条）。
8. **落位**：事实与决策记入 `docs/tasks/log.jsonl`（追加式，用 `key`+`value` 收敛冲突，**不删旧条目**，冲突用新条目 `resolves` 旧的；`node scripts/tasklog-open.mjs` 渲染）。经验记入 `docs/LESSONS.md`（现象→根因→做法+来源）。一物一家：规则不写进 LESSONS，经验不写进规则。
   - ⚠️ **`docs/` 在 .gitignore 里**（公开仓只放行 `docs/assets/` 与 `docs/fork-delta.md`）⇒ 台账与 LESSONS 是**本机资产**，不随仓库走。写台账时把**根因锚点写成源码路径**，别只写产物路径（产物在 `dist/`，同样不入库）。

## 3. 已经付过学费的坑（动手前扫一眼）

- **「本地绿、CI 红」先怀疑测试读了未隔离的全局状态，别先怪环境**（2026-10-12）：`corum-agent` 的 `kv-store-migration.spec.ts` 在 CI 上**稳定 5 条失败**、本地全绿。真因是 `hasJsonTrace()` **内部自己调 `storagesRoot()`**（读 `CORUM_HOME`、回落 `~/.corum`）而**忽略了传入的 `root`** ⇒ 干净环境判 `empty`；而开发者机器上恰好有同名残留文件（`~/.corum/storages/workspace.json`）就**误打误撞通过** ⇒ 缺陷被「本地绿」掩盖。**结论：纯函数不得读环境，需要路径/配置一律由调用方注入。**
- **`host bridge boots OK` 在交叉出包日志里是假绿**（2026-10-12）：`smokeBridge()` 用**宿主** Node boot 闭包，交叉时验的是宿主平台 ⇒ 对一个「Windows 上白屏」的包照样打印 OK。⇒ **交叉出包必须靠产物启动断言（`pnpm assert:boot`），不能靠这三条假绿守卫。**
- **「Pack 步骤绿」不是「包能用」**（2026-10-12）：那次白屏的 Windows 包**每一步都绿**——`electron-builder` 对插件树加载不起来的包照报成功。出包后必须**真的启动一次产物**。
- **Windows `.exe` 在 macOS 上跑不了**（`EACCES`）：产物启动断言在异平台会失败，**这是正确行为**——必须到它自己的平台上跑。
- **`dist/` 与 `docs/` 都在 `.gitignore` 里**：打包证据与报告**不随仓库走**。写台账时把**根因锚点（源码路径）**写进去，别只写产物路径。
- **插件包产物陈旧**：改了 host 插件、`tsc` 绿、build 绿、重启后行为没变 → `lib/index.js` 是旧时间戳。
- **`corum-instance.sh` 的仓库级兜底清理会连带杀掉验证实例**（命令行都含本仓库 `packages/desktop/lib`）→ 现象是验证实例静默消失、日志无报错。已修：排除验证实例整棵进程树。
- **在 agent 沙箱里启动应用会坏**（seatbelt 下 `git worktree` EPERM、`posix_openpt failed`）→ 用 `scripts/app-launch-guard.sh` 拦；这不是产品 bug。
- **给 corum Agent 的长 brief 必须写成单行**：多行会被拆成多条用户消息（实测被拆过 8-9 条、要求丢失）。
- **`corum-agent` 的 `inject` 声明只有模块级 `export const inject` 是权威**，class 上的 `static inject` 是陈旧副本（漏一个就 `cannot get property "x" without inject`）。
- **写工具面 = `write` + `edit`**：`str_replace_editor` 已于 2026-09-11 退场（与 `edit` 职责重叠、失败率最高），新增第三套写工具会拉高整体失败率。
- **`${VAR}（` 这类「变量后紧跟全角字符」**在 bash 里会吞掉变量名 → `set -u` 报 unbound variable 且报错乱码；变量后必须留空格或用引号。
- **CSS 不要写 `-webkit-backdrop-filter`**：Chromium 已删该别名，构建会保留最后一条 → 玻璃模糊静默全灭。只写标准属性。
- **新 UI 的 `font-size` 必须走 `calc(<N>px * var(--corum-ui-font-scale, 1))`**（2026-09-19 用户报「面板字体似乎小一些」+「字体大小是跟随设置面板的」）：全仓 615 处已迁，裸 px 是唯一不随「外观 → 界面字号」（默认 14px / 12–17）变的那块。图标尺寸保持固定 px（同族插件如此）。**新 UI 插件请照抄 `corum-ui-model-ask/tests/design-fidelity.spec.ts` 里那条守卫。**
- **UI 文案克制（2026-10-24 用户定调）**：界面只写用户决策所需的信息，**不写开发注记**（`真源` / `硬编码` / `尚未接线` / `PRD §` / `Monaco` / `npm registry` / 源码行号）；状态用 badge/pill/置灰表达，不写整句；空态标题即全部，desc 最多一句且不复述标题；同一事实只说一次（只读 / 不可操作 / 需重启 / 开发者模式 / 计数）；缺失值用 `—`，不写「未提供描述」；数字与单位不重复（「热度」行不再写「周下载」，计数不再补「另有 N 个，可滚动查看」）。新增一行小字前先问：删掉会不会少信息？不会就删。
- **设计稿不一定是实物尺寸**——并排对比的 mockup 比真实界面窄，其 px（尺寸与字号）都是缩略值。判据：看**共享组件在该稿里的实例宽度 vs 组件定义宽度**（方案C 的 `Chat Input` 实例 372，定义 720 = 提问卡区域用的真实宽 ⇒ ~0.52× 缩略稿）。缩略稿的字号要映射到设计系统自己的字阶（Design System 区域的 `D1·34 H1·24 H2·20 H3·16 B1·14 B2·13 UI·12 Meta·11 Cap·10`），并对照**已实现的同族面板**（提问卡/审批卡正文 13–15px）。直接照抄缩略稿 px ⇒ 比周围界面明显小一截。
- **不能用 `sessionId` 前缀当会话类型判据**：判据写的是 `startsWith('corum-task-')`，而 `sessions.fork` 建出的 id 是随机 UUID ⇒ 前缀不匹配 ⇒ 判成「非 task 泳道」⇒ 该 chip 冒出来。**判语义状态**（该 chip 的有无 = 会话是否还没开始 `summaryBlank`），任何新建会话路径不遵前缀就漏判。
- **「隐藏/绕过对手 UI」的判据必须读对手读的那个信号**：corum 用**列表摘要** `byBy[id].origin==='subagent'` 判断要不要绕过 composer 链，官方 `ui-subagent` 读的是**运行时对象** `session.subagent` ⇒ 边界态两处判据分叉 ⇒ 官方只读条**同时当选**并渲染（`overlay:true` 槽当选时 fallback 是 `display:none` 而非卸载）。读同一枚币才兜得住。
- **「多了个不该有的元素」类报障：先枚举该区域的全部渲染者 + 逐个读它的 render gate**，别先重放用户时序（重放 6 轮没复现，改枚举后一轮定位）。
- **`fs` 服务重复注册**：`fs-local` 必须走 realm 私有符号（`isolate: fs`），否则与 host 的 fs-sandbox 抢 root 导致 mount 失败。
- **官方 preset 的本地副本会被包内置版本静默遮蔽** → `boot.ts` 必须带 `includeShippedRoot: false`（守卫 §17 断言）。
- **技能根只有一处**：corum 只读 `<CORUM_HOME>/skills/<绑定名>`，不读项目 `.dsh/skills`、`.agents/skills`、`~/.agents/skills`、打包内置根（`includeDefaultRoots: false`）。技能进 corum 只有一条路：设置 → 技能 → 导入技能。
- **沙箱内访问 `127.0.0.1:9222` 会被拦**（Operation not permitted）——CDP 脚本需要相应权限；报错是策略拦截，不是脚本 bug。
- **改 UI 插件包构建三步缺一不可**（2026-10-06 实机）：`tsc -b && tsdown && node scripts/inline-css.mjs`。只跑 `tsdown` 会把 CSS 抽成外部 `lib/style.css`，dev 运行时 404 加载不到 ⇒ 样式全失（界面裸奔、`--corum-glass-1` 为空）。inline-css 是该包样式生效的**唯一通道**。判据：`getComputedStyle(body).getPropertyValue('--corum-glass-1')` 为空。
- **settings「object 字段」的成对写入陷阱**（2026-10-06 用户报「子 Agent 供应商点击没作用」）：`corum-subagent` 的 `defaultModel`/`defaultResearchModel` 是**一个 object 字段**，UI 按「provider+model 成对」commit 时，选供应商（model 空）会触发三键全 unset ⇒ 回弹「未设置」。修法：改字段写字段整体（供应商 `{provider}`、模型 `{provider,model}`），联动值用最新 describe 镜像兜底消除回读竞态。排障先分责：mutate 直调验 host，host 接受 ⇒ 责任在 UI commit。
- **「写在 persona 里的强制」不是机制**（2026-09-16）：orchestrate 声明 `merge.verify` 失败却报 `merged + committed`——因为**真值门禁只判「分支是否进 HEAD」，从不看 verify 的退出码**，而集成者用普通 `git merge` 时**合并提交自己就进了 HEAD**。修法：机制**自己跑**声明并取退出码，把「集成成功」收成**一个**函数（git 实况 ∧ verify exit 0），拒绝形态**类型化**。
- **给 orchestrate 结果加字段必须同步输出 schema**：那处是 `additionalProperties: false`，漏声明的字段会让 harness 用 `INVALID_TOOL_OUTPUT` **顶替整个 payload**。同理：**报告里不许写与现场不符的承诺**、**改 persona 前先想它会不会制造新的卡死形态**（`--no-commit` 会留下 `MERGE_HEAD`，毒化后续每一轮 merge/commit）。

## 4. 证据标准（做完凭什么说完成）

- 「编译通过 / 构建绿 / 单测绿」都**不是**完成；要有真实运行证据：新起的会话日志、CDP 断言、截图、守卫输出。
- **不接受自述**：子 Agent 说「已修好」不算，按原目标自己判。
- **按用户实际的时序验证**（2026-09-12 血泪）：跑完再展开、重启后再看、main 动过之后再对账。按实现者的时序（先展开再跑）验证只会假绿——第四轮四项交付里两项就是这么绿着上线的，真机上「工作区行点不动」「改动段从不出现」（BUG-32/33）。凡是「事件推送 + 组件条件挂载」的组合，先问「挂载晚于事件会怎样」；凡是对账/清扫判据，先找反例（空分支、被检出的分支、符号链接路径）。
- **没验证的就写「未确认」**，不要用措辞掩盖。
- 汇报时说清三件事：**哪个产物时间戳更新了、哪条实机证据为证、跑了哪条守卫**。

## 5. 协作纪律（本项目的团队口径）

- **用户核查、Agent 整改**：用户负责实机核查与拍板，Agent 负责改动 + 构建 + 重启 + 自证。
- **说不清的产品冲突升级给用户**，不要自己拍（模式命名、删不删内置角色、技能归属都属此类）。
- **占位符是未来工作**，不能因为「暂时没人用」就删；只有确实要移除的才移除。
- **破坏性动作先问**：删内置角色 / 删目录 / 动用户 home 与凭据 / 重启用户正在用的实例。
- **不要碰用户的实例与数据**：主实例 `:9222`、`~/.corum`、`~/.agents`；验证用自己 `:9333` 的实例与 `.corum-verify-home`。
- **先读技能再动手**（2026-09-13 立规）：任务匹配某个技能的描述（实机验证 / CDP / ESP32…）时，**先加载技能**——你已经踩过的坑大概率写在它的「常见坑」表里。
- **装置起不来就别 debug 环境**（2026-09-13 立规）：按装置打印的可执行下一步做**一次**（cd 主 checkout / 设 `CORUM_REPO` / 等 Electron 就绪后重跑），仍失败就**停下来报 blocked**并贴原始输出。禁止 `lsof`/`pgrep`/`kill -0` 连环试探、换端口另起实例、写一次性探针绕过、手改 PID 文件（实测代价：一个子 Agent 烧几十步，最后驱动了别人的实例）。
- **动手前先证明「改的是那一处」**（2026-09-13 立规）：给出证据（设置分区注册表行 / 真机 DOM 类名前缀 / 数据来源）再改；验收分两问——先验「改的是不是那一处」，再验「改得对不对」。
- **状态清单由脚本生成，不手维护**（2026-09-13 立规）：交接/BUG 状态/待办队列一律从 `docs/tasks/log.jsonl` 渲染（`node scripts/tasklog-open.mjs`，同 key 后者胜、`supersedes` 裁决演进、`--check` 有冲突即非零退出）。手维护的清单必然过期（实测：写「领先 6 个提交」而实况 9，且漏两条待拍板条目）。
