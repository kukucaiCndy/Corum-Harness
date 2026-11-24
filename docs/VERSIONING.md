# 版本号规则与发布台账

> 决策：2026-10-03（用户定调）。规则改动先改本文件，再改代码。

## 1. 两条版本线（不要混为一谈）

| 版本线 | 是什么 | 住哪 | 谁改 |
| --- | --- | --- | --- |
| **应用版本**（Corum Harness）| 本产品自己的版本，独立演进 | `packages/desktop/package.json` 的 `version` | 我们，发版时手动 bump |
| **dsh 基座版本** | 依赖的官方 DeepSeek Harness 版本 | `@deepseek-ai/dsh-base` 实际安装的那份 | 官方发版 + 我们升级基座时跟着走 |

界面**只显示应用版本**；基座版本**只进「复制诊断信息」**（剪贴板文本
`Corum v<应用版> · dsh <基座版> · <平台>`）。理由：基座是预发布号（如
`0.1.5-rc.3`），直接当产品版本展示会让用户以为自己在用未发布版本；
而同一个基座下我们会发多个应用版本，两条线不是一对一。

## 2. 取值来源（不许手填）

- **应用版本**：`packages/desktop/src/electron/ipc.ts` 读本包 `package.json` 的
  `version`，经 `corum:app-version` 给渲染层。
  ⚠️ 不用 `app.getVersion()`：dev 态主进程入口是 `.js` 文件而非 app 目录，
  Electron 无包可读，会回落成 **Electron 自身的 bundle 版本**（实测显示
  `v43.4.1` 而非应用版本）。
- **基座版本**：同文件读**实际安装**的 `@deepseek-ai/dsh-base/package.json`，
  经 `corum:dsh-baseline-version` 给渲染层。**从安装产物读、不从依赖声明或常量读**：
  声明是 `^0.1.5-rc.3` 这种范围，写进界面会撒谎；`.pnpm` 里还可能同时存在多个
  版本（实测同时有 `0.1.3-alpha.1` 与 `0.1.5-rc.3`），只有**解析后的那一份**是真话。
  取不到时渲染层省略该段，不编造。

## 3. 什么时候 bump 应用版本

- **patch**（`0.2.0 → 0.2.1`）：修缺陷、调样式、改文案，不动基座。
- **minor**（`0.2.0 → 0.3.0`）：新增用户可见能力（新插件、新工作面、新交互）。
- **major**（`0.2.0 → 1.0.0`）：对外承诺稳定，或出现破坏性变更（配置格式、
  会话存储格式不兼容）。
- **升基座不必然 bump 应用版本**，但**建议同时 minor**：基座升级常带来行为变化，
  版本号能帮我们日后对应「这份构建基于哪个基座」——映射关系记在下面台账里。

## 4. 发布台账（应用版 ↔ 基座版）

**每次发版必须追一行**——这是「这个应用版本基于哪个基座」的唯一事实源。

| 应用版本 | dsh 基座版本 | 日期 | 主要变更 |
| --- | --- | --- | --- |
| `0.8.2` | `0.2.1-rc.3` | 2026-11-24 | **更新功能本身的两个修复**（用户装上 0.8.1 后直接撞上）：①macOS/Windows 的应用内自动安装被一行**不看平台**的判定挡死（`UpdatePanel` 里 `downloadedPath.endsWith('.AppImage')` 只认 Linux 资产；macOS 走 `.zip`、Windows 走 `.exe` ⇒ 恒 false，还配上 Linux 专属 deb 文案），而宿主 `installDarwin()`/`installWin32()` 一直完整、永远等不到调用。改为 `canInstallInPlace(assetPlatform, path)` 按资产标注平台取扩展名表（darwin .zip / win32 .exe / linux .AppImage，与宿主三实现逐一对应）；`.deb` 仍不可应用内安装（/opt 属 root，真限制）。②新增「打开所在目录」按钮 + `corum:show-item-in-folder` IPC （`shell.showItemInFolder`，只揭示不执行、路径须存在）+ `manualInstallHint()` 给出可照抄的 `sudo dpkg -i "<绝对路径>"`；旧文案既无文件位置也无命令。③更新日志显示上一版本内容：`CHANGELOG.md` 自 v0.7.0（82b9692b, 10-23）后再未追加，面板按 `currentVersion` 找不到节即回落 `sections[0]`；补齐 v0.8.0/v0.8.1 两节并给 `release.mjs --write` 加门禁（两份副本都必须有该节且内容一致）。**机制要点**：`CHANGELOG.md` 有**两份独立副本**（仓库根 vs `packages/desktop/assets/`），运行时只读随包那份、非硬链接，只改根目录不生效。实机验证：:9333 dev 实例临时降版本复现（验完还原），面板由「需用包管理器安装（禁用）」→「重启安装（可用）」，日志由回落 v0.7.0 → 精确命中当前版本节（fallbackTo: null）。发版说明手工版 `RELEASE-NOTES/v0.8.2.md` |
| `0.8.1` | `0.2.1-rc.3` | 2026-11-24 | **三个用户报障修复**：①右侧编辑器/资源管理器不跟随当前会话（判据读了 rc3 `SessionListState` 里**不存在**的 `current` 字段 ⇒ 恒 undefined ⇒ 回落 `workspaces.items[0]`，而该数组按 `createdAt` 倒序 ⇒ 永远显示「最新创建的工作区」；改读 `corumNavigation.selection` + 纯函数 `resolveProjectRoot`，无选中会话给空态）；②切换会话时分栏不自动收起（重新 inject `corumNavigation`，按 selection **值变化**调 `closeSplitPane`，避免同值广播误收）；③助手正文链接点了没作用（`conversation.view` 从未包 `MarkdownDelegateProvider` ⇒ 本地链接退化成纯文本、外链走原生锚点被静默丢弃；接上委派后本地文件带 `#L12` 定位到行、外链经 `openExternal` 只放行 http/https）。**MCP 连接可靠性**：修两处竞态（建连期死亡发布死连接 / 拿到后未用即死 ⇒ 池抱死连接），改为复位+重连一次且不掩盖其它错误。**提炼任务**：落盘在 finally 与读回的竞态（改为等「内容到位」）。**CI 收口**：pr-gate 自 #234（11-20）以来首次三道全绿——构建改走 `build-all.mjs`（源码级类型环）、`plugin-build` 的 `inputOptions` 默认态、以及 4 簇 Windows 隐式平台假设（`USERPROFILE` / `fileURLToPath` / 分隔符 / POSIX 可执行位），后者已在 **win10 真机逐条验穿**。发版说明手工版 `RELEASE-NOTES/v0.8.1.md` |
| `0.8.0` | `0.2.1-rc.3` | 2026-11-15 | **基座升级 0.1.5-rc.3 → 0.2.1-rc.3**（官方 dsh 全量升级，fork 四包适配、运行期 bundle 机制保留、guard §17 断言对齐 rc3）。**本场用户报障修复**：①子 Agent 胶囊点击跳转后消失（roster 基线读幻影键 `subagentsByParent` → 改读官方投影存储 `subagentCatalog`）；②配置向导重复供应商静默覆盖（`taken` 全目录误报 → 仅计已配置供应商 + 品牌族感知 + 自定义 route 占用拦截）；③空壳内置供应商卡片（base 预设与空命名空间被 `configured` 宽口径误标 → 改用 user 段判据门控）；④API Key 占位符 `[object Object]`（向导本地化渲染修 `brandNameOf`）；⑤task agent 审批 `unavailable` deny（审批转发载荷缺 `sessionId`，无 UI 附着会话无法审批 → 补 sessionId 转发）。**Windows 工作区 ACL 提权修复**（admin 属主目录 shell 全不可用 → UAC 提权 helper + 引导卡，实机端到端验穿）。**CTS 自测中心**：目标自配置 + 远程 Windows 能力（`prep-target` 模块 + `cdp-router` 远程 CDP 目标支持）。另有：子 Agent 模型候选集（全局/预设两级）、编排 `orchestrate` 移除 script 模式只留声明式、审批卡进会话流、deb 包 `chrome-sandbox` setuid 修复、Linux 自动更新选资产。发版说明手工版 `RELEASE-NOTES/v0.8.0.md` |
| `0.7.0` | `0.1.5-rc.3` | 2026-10-23 | **Windows · 修「清完 C 盘后应用起不来、凭证全失效」**（本版最重要）：userData 从系统临时目录移到 `%APPDATA%` 持久目录 + 升级首次启动迁移密钥文件，已保存 API Key 继续可用（#136）。**Windows · 内置 VC++ 运行库**（启动检测缺失即静默安装，#133）。**Windows · 8.3 短名工作区**：路径是短名时改动不再被误判「工作区外」（修 CI 全红，#131）。**编排**：`orchestrate` 移除 script 模式只留声明式（#126）。**编辑器**：主题与显示偏好对齐（#129/#132）。**三平台门禁落地** + 11 处平台缺陷修复含 5 处实现缺陷（#114）。发版说明手工版 `RELEASE-NOTES/v0.7.0.md` |
| `0.6.0` | `0.1.5-rc.3` | 2026-10-18 | **启动动画**：分段视频成为内置默认启动动画，按启动阶段循环播放 + 阶段回调与实际加载进度同步；旧 HTML 启动动画下线。**联网搜索**：`corum-web-search` 聚合 provider（默认 DeepSeek，可添加其他供应商）+ 供应商名中英双语 + pi-ai 目录驱动供应商清单。**应用内 Issue 上报**：GitHub device-flow 认证 + API 提交 issue + 自动检测环境信息（平台/版本）。**版本号区分本地构建与正式发布**（侧栏显示）。**打包链**：出包一律从零构建（`--clean`）+ 全量编译脚本 `build-all.mjs`。修 `--clean` 删 `build/node` 致缺 Node 运行时、检查更新弹窗品牌图被裁。模型：阿里百炼三通道加区域/订阅后缀避免同名、新增 Kimi Code 条目 |
| `0.5.0` | `0.1.5-rc.3` | 2026-10-16 | **启动动画**：新启动主题（代码片段汇聚成 Corum Harness）+ 分段视频主题按启动阶段切换播放片段 + 启动动画与实际加载进度同步（阶段回调）。**Windows 终端修复**：终端默认用 powershell + 白色主题下终端内容可见（#62）+ 终端 shell 用完整路径修 Win10 `spawn cmd.exe ENOENT`（#58）。**打包链**：`buildApp` 跟随 `--platform/--arch` 不硬编码 `--mac --arm64` + 根治 electron-builder + pnpm `link:` override 不兼容 + Windows 只出 NSIS exe 不再出 zip（#47）。**安装包自带便携版 Git**（修干净系统 `spawn git ENOENT`，#49）。**导入向导**：冲突处理 diff split-view 详情面板 + per-item 选择 + zip 安装修复。**corum-dev 预设独立仓库**（extract preset into independent repo）。移除项目记忆（scope 收敛为 agent 单维度）。`disabled` patch 过滤修复（撤掉 #54 的 filter——它破坏 fork 顶替官方包的禁用关系）。内测声明弹窗永久关闭 |
| `0.4.0` | `0.1.5-rc.3` | 2026-10-13 | **活动栏用户菜单修复 + 会话栏按设计稿重构**。①活动栏「我的」菜单被会话列表遮挡（backdrop-filter 创建 stacking context 困住 z-index）——给 activityBar 设 z-index:5、菜单底色 glass-1→glass-4（85% 不透明消除重叠）、边框转霓虹青、位置从偏右上调到紧贴按钮上方；②默认头像换日系立绘（general-assistant.png）；③会话栏新建任务从大按钮改 panel-head 小按钮（SquarePen）、搜索从胶囊改常驻搜索框、视图选项+添加工作区移入 panel-head；④右键上下文菜单注册（#32）；⑤提交卡片 turn-scoped 快照对比（#34）。**发版阻断修复**：win32 打包 `corum-tools must be under`（pack.mjs 清理 workspace symlink 时 readlinkSync 在 Windows 返回反斜杠路径，正斜杠匹配失效——统一路径分隔符后修复，#40）。tag 重指（首跑 win32 失败 → 修复合入 → 重指 v0.4.0 到 e3de3c2 → 二跑三平台全绿）。发版说明手工版 `RELEASE-NOTES/v0.4.0.md` |
| `0.3.0` | `0.1.5-rc.3` | 2026-10-12 | **首个 Windows 随版本正式发布**（三平台由各自 runner 同一次 release 出资产；此前 Windows 是事后挂到 `v0.2.2`）。两个**阻断级修复**：交叉打出的包**白屏起不来**（平台专属原生依赖改按 `<pkg>-<os>-<arch>` **命名规律**整体校正，不再维护包名白名单；打包链加产物启动硬门禁 `pnpm assert:boot`）＋ **新建工作区 exit 128**（git 属主 `safe.directory`，仅 Windows、只放行该目录）。另有：git/node 子进程**无窗口运行**（`windowsHide` ×6，消掉控制台黑框）＋ **闭包减重**（裁源码/声明/maps/文档，实测 ≈185MB / 2 万文件）＋ **Agent 预设模块化**（导入向导 + 发布流程：把 Agent 连技能与 MCP 依赖收成自洽目录）＋ 修「MCP 服务配了 `guidance` 就让整个 preset 挂载失败、Agent 完全打不开」（issue #3）＋ 提交卡片**改挂会话流**且**提交过程收进卡片**（默认收起）＋ 三处可见缺陷（子 Agent 模型选择回弹「未设置」/ 侧栏工作区分组空态 / 新建任务工作区下拉首项）。发版说明改为**手工版优先**（`RELEASE-NOTES/<tag>.md`，见 §5） |
| `0.2.2` | `0.1.5-rc.3` | 2026-10-09 | **修发布阻断：macOS 钥匙串密码弹窗 + 应用起不来**（根因 = electron 浮动 range `^43.4.0` 被一次 install 从 `43.4.1` 漂到 `43.7.9`，二进制 cdhash 改变使钥匙串条目 ACL 失配）。钉死 electron `43.4.1`（进 overrides）；dev 态主密钥不可用时**降级启动**、打包态保持 fail-loud；新增 `pnpm smoke:packaged` 凭证加密门禁（直接 exec 产物、不预注入主密钥）；拆 `corum-instance.sh` 两处炸弹（硬编码 Electron 路径 + 漏 `app.setName` 致自动解主密钥一直是坏的） |
| `0.2.2` | `0.1.5-rc.3` | 2026-10-12 | **同版追加 Windows x64 资产**（事后挂到已发布的 `v0.2.2` Release，不新开版本号）：NSIS 安装器 + 免安装 zip（`pack:win` 四步链；NSIS 按用户安装 `perMachine: false`、`requestedExecutionLevel: asInvoker`）。Windows 差异：**未签名**（首次运行会被 SmartScreen 拦，点「更多信息 → 仍要运行」即可，属预期）；凭据走 DPAPI（`secretStore: 'dpapi'`，重装系统/换用户后旧凭据不可解密，需重填 Key）；**暂无托盘**（关窗即退出）；终端按 `pwsh → powershell → cmd` 顺序探测。Windows 版说明见 `RELEASE-NOTES/v0.2.2-win.md` |
| `0.2.1` | `0.1.5-rc.3` | 2026-10-08 | **新增 Linux 桌面端**（AppImage + deb，首个 Linux 发布）；修复 Linux 凭证不可保存（显式 `gnome-libsecret`）、`fetch-node.mjs` 硬编码 darwin/arm64、`pack:linux` 跳过前置三步、`corum-instance.sh` 沙箱探针 macOS 专用；启动直接进主界面、「新建任务」去掉「选择新目录」；立「三平台覆盖」为开发核心原则（规范 §16）<br>⚠️ **该版的 macOS 资产（dmg/zip）含缺陷、已由 `0.2.2` 取代**：用的是 Electron 43.7.9，在用户机上会弹钥匙串密码框且应用起不来。Linux 资产（AppImage/deb）不受影响 |
| `0.2.0` | `0.1.5-rc.3` | 2026-10-03 | 版本号规则确立（应用版与基座版分线）；集成中心磁贴（共享 mosaic 包、按形状分档贴内布局、卡片简介移入详情）；侧栏品牌区改文案标题、会话列表固定 220 不可拖 |
| `0.1.0` | `0.1.5-rc.3` | 2026-09-29 | 官方基座升级 0.1.3-alpha.1 → 0.1.5-rc.3（见 `docs/UPGRADE-0.1.5-rc3.md`）；此前 `0.1.0` 是初始值，未随基座调整 |
| `0.1.0` | `0.1.3-alpha.1` | 2026-09-09 前后 | 初始 fork 版本（应用版本号自始写死 `0.1.0`，未与基座联动）|

> 注：`0.1.0` 那一版的历史行是**回溯补记**——应用版本号在 2026-10-03 之前
> 与基座完全无关联（长期停在 `0.1.0`，而基座从 `0.1.3-alpha.1` 走到了
> `0.1.5-rc.3`）。故上表前两行的基座版本按当时的升级记录补出。

### `v0.3.0` 的实发经过（首跑失败 → 修两处阻断 → 重指 tag → 二跑全绿）

首跑（run `38269968789`）：**darwin ✅ / linux ❌ / win32 ❌ / publish skipped ⇒ 一个 Release 都没建**。
两处真因（详见台账 `release.v0.3.0.*`）：

1. **win32 `Pack win32` 失败**——`installer-details.nsh` 把 `ShowInstDetails show` 写进
   `!macro customInit`，而 electron-builder 把 `nsis.include` 的 macro **展开在 `Function .onInit` 内**，
   该指令在 NSIS 里不允许出现在 Function 内 ⇒ 直接 abort。**该文件来自 PR #15、作者也未验证过**
   ⇒ 整段回退（`fix/v0.3.0-release-blockers`）。
2. **linux 冲烟 `沙箱前置（bwrap）` 失败**——`ubuntu-latest`（24.04）默认 AppArmor 限制非特权
   user namespace ⇒ 装了 bubblewrap 也起不了 profile。修法是 CI 放开该限制（**不放松判据**）。

处置：`v0.3.0` **重指到修复后的 main**（`58f4e9e`）。选重指而非跳到 `v0.3.1` 的理由：`package.json`
已是 `0.3.0`，发 `0.3.1` 会落进 §5 明写的「**打号未打 tag**」陷阱。首跑未产出任何 Release ⇒ 无对外发布需撤回。

二跑（run `38272338009`）：三平台 `Pack` / **产物启动断言（发布阻断级硬门禁）** / `Smoke` **全绿**，
publish success，Release 含 **9 个资产**（dmg+zip / AppImage+deb / NSIS exe+zip，各带 blockmap）。
发版说明为**手工版**（`RELEASE-NOTES/v0.3.0.md` 已成为 Release 正文，验证了 §5 的覆盖开关生效）。

> 遗留（未收口）：release.yml 的 `Smoke（--fast，无 --launch）` 判据**跨平台结论不一致**——
> darwin 通过（附着到打包链留下的实例）、linux 靠环境前置才通过。台账
> `ci.release.smoke-attach-platform-inconsistent` 记着待办。

## 5. 发布动作：一条命令（`scripts/release.mjs`）

用户 2026-10-03 要求：「每次发布时要能自动输出 TOP5 的更新日志，注意事项，并自动递增版本」。
`scripts/release.mjs` 是本节规则的可执行投影。

```bash
node scripts/release.mjs              # 预览：版本变更 + TOP5 + 注意事项（不写任何文件）
node scripts/release.mjs --write      # 实际递增两处 package.json + 向台账追记 release.v<新版>
node scripts/release.mjs --bump=patch # 覆盖自动判定的档位（major|minor|patch）
node scripts/release.mjs --since=<ref># 指定基线（默认最近 tag）
node scripts/release.mjs --json       # 机器可读
```

**两块数据源，各有其职**（不要混）：

| 输出 | 来源 | 为什么 |
| --- | --- | --- |
| TOP5 更新日志 | **git 提交信息**（conventional commits）| 提交信息是「这版做了什么」的第一手记录 |
| 注意事项 | **台账 `docs/tasks/log.jsonl`** 的 `lesson`/`risk`/`constraint`/`correction`（最多 8 条）| 提交信息里没有「坑 / 约束 / 风险」这个维度 |

**TOP5 的选择规则**：用户可见影响优先（`feat` > `fix` > `perf`/`refactor` > `docs`/`chore`），
并**按 scope 去重** —— 同一轮改动常拆成多个同 scope 提交，不去重的话 5 条可能全是同一个模块，
等于没让人看到这版都动了哪些地方。

**版本递增判定**：含 `feat!` 或 `BREAKING CHANGE` → major；含 `feat` → minor；其余 → patch。

### 两个已知陷阱（脚本会主动警示，不要绕过）

1. **自动提交**：本仓有 `wip(turn-…): auto-commit on turn end` 这类自动提交
   （实测 v0.1.0 以来 28 个提交里 14 个是 wip）。脚本按 `wip` 前缀过滤它们，
   但**wip 提交里也含真实工作**，所以会**统计并警示占比**（>40% 时提示）。
   占比高说明日志在漏项 —— 发布前应把关键改动落成规范提交，而不是无视警告。
2. **「打号未打 tag」**：脚本基线取「最近 tag」，而版本号可能已在 `package.json`
   里前进却**没有对应 tag**（本仓真实发生过：`0.2.0` 已写进两处，tag 仍停在 `v0.1.0`）。
   此时脚本会把 `0.2.0` 当成未发布、再递增一档 ⇒ 那个版本永远没有发布记录。
   脚本检测到就警示并给出补救（先 `git tag v<当前版本>`）。

### 手工发版说明（可选覆盖，2026-10-12 用户定调）

`RELEASE-NOTES/<tag>.md` **存在时优先于脚本生成**（`release.yml` 的 publish job：
先看该文件，有就 `cp` 成 `release-notes.md`，没有才回落到 `release.mjs`）。

**为什么要有这个口子**：脚本的 TOP5 规则是「`feat` 优先 + 按 scope 去重」（§5），
于是**用户痛感最强的 `fix` 会被全挤掉**——`v0.2.2 → v0.3.0` 那一版实测：26 个提交里
11 个 `fix`（含「MCP guidance 让 Agent 完全打不开」这类），TOP5 一条都没进；
而「注意事项」取自台账原文，里面**可能带着已被推翻的旧结论**（同版实测 1 条）。

**手工版的写作口径**：读者是用户，不是我们。① TOP5 按**用户可见影响**排（不只按
提交类型）；② 注意事项**先给用户须知**（未签名 / 无托盘的平台、安装方式），再附开发约束；
③ 已被推翻的台账条目**不要照抄**；④ 别把「发布预览」那种内部信息（自动提交占比、
基线 tag）搬进正文。

### 发布完的收尾

预览确认 TOP5 文案 → `--write` → 提交 → `git tag v<新版>`。
**打了 tag 才算真发布过**：下一次发布的基线就是它，也是「这版基于哪个基座」的定位点。

## 6. 升基座后的固定动作

按 `corum-official-upgrade` 技能升级基座后，**除技能里那套流程外**，本文件要补：

1. 上表追一行（应用版本 + 新基座版本 + 日期 + 主要变更）；
2. 确认 `@deepseek-ai/dsh-base` 的**实际安装版本**已变（`corum:dsh-baseline-version`
   读的就是它，不需要改代码）；
3. 若本次同时 bump 了应用版本，`packages/desktop/package.json` 与根
   `package.json` 两处 `version` 一起改（两处都写 `0.2.0`，保持同值）。

## 7. 已知的过期之处（顺带记录）

`docs/fork-delta.md` 顶部仍声明「基线 = dsh 检出标签 `dsh-v0.1.3-alpha.1`
（= 当前工作区实际安装的基座版本）」——**该括注已过期**：工作区实际安装的是
`0.1.5-rc.3`（2026-09-29 升级）。fork 增量表本身的数字是那次升级前重算的，
需要重算表时一并更新那句基线声明。
