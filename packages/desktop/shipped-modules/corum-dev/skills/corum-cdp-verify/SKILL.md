---
name: corum-cdp-verify
description: 在 corum Agent OS 桌面应用（kkc-desktop 仓库）里用 CDP 做实机功能验证与界面调试：启自己的验证实例（不碰用户主实例）、一份声明式规格跑完所有断言、截图留证。适用于改了 client 插件 / UI / 桌面功能后需要真实验证的场景；不适用于纯编译检查或官方 dsh 包内部开发。
---

# corum CDP 实机验证

在 kkc-desktop 仓库开发桌面应用功能后，用 Chrome DevTools Protocol 驱动真实运行的
Electron 应用做端到端验证。**只编译通过不算完成**——每个功能点都要经「RPC 驱动 +
事件日志核对 + UI DOM 断言」三层实机验证。

## 驱动方式：**自验一律用脚本打自己的 :9333**；chrome-devtools-mcp 只面向主实例

> ⚠️ 2026-09-12 实测事故：子 Agent 跑 `cdp.mjs` 时没设 `CDP_PORT`（旧默认 9222）→ 驱动了
> **用户主实例**、读到用户真实会话，并据此误判「:9333 的宿主就是我」，差一步就去重启用户的应用。
> 启动/重启统一入口：`scripts/corum-instance.sh`（2026-09-25 由 cdp.sh / verify-instance.sh /
> dev-ide.sh / combo.sh / pack-instance.sh 五个脚本合并而来；`--home=verify` 即验证实例）。
> 现在的护栏：`cdp.mjs` 默认端口 = **9333**；显式要打 9222 必须 `CORUM_ALLOW_MAIN=1`（会拒并提示）。
> 下面这套 MCP 配置连的正是**主实例**（`--browser-url=http://127.0.0.1:9222`）——它是给**用户/主 Agent
> 在被授权时**用的，不是子 Agent 的自验通道；子 Agent 自验只走 `$SKILL/scripts/cdp.mjs` + `ui-verify.mjs`（:9333）。

### ⚠️ 子 Agent 起 9333 会被沙箱守卫拒绝 —— 用 `--allow-sandboxed`（2026-10-11 补）

**症状**：子 Agent 跑 `corum-instance.sh start --home=verify` 报
`❌ 拒绝在**沙箱内**启动验证实例（sandbox-exec 探针失败）`（退出码 3）。

**原因**：agent 的 `terminal.mode` 常为 `sandbox`（如「Corum 开发」预设），而实例进程树会
**继承当前沙箱** ⇒ 实例内**子 Agent 的 bash 全部失败**（嵌套 `sandbox-exec` 无法应用 profile：
`sandbox_apply: Operation not permitted`）。守卫因此**硬拒绝**（`corum-instance.sh` 的
`assert_not_sandboxed`；判据是 `sandbox-exec` 空 profile 探针，Linux 侧用同款 bwrap 探针）。

**出口**：加 `--allow-sandboxed` 显式放行：

```bash
"$SKILL/scripts/corum-instance.sh" start --home=verify --allow-sandboxed
```

**边界（必须守住）**：放行后实例内**子 Agent 的 bash 会全部失败**，所以
**只有纯 UI 断言可用**——隔离 / 子 Agent / worktree 类断言**必然假失败**（不是产品 bug，
是嵌套沙箱的固有后果）。要验隔离或子 Agent 行为，必须请用户在**沙箱外**（用户终端 /
监督侧会话）起实例。

**另一条路（更干净）**：若只要验 UI，先 `status` 看有没有**已在跑**的实例可直接复用——
起停实例的授权边界是「读 + 复用」，只有起**新的**才需要上面的放行。

DSH web profile 的 `~/.dsh/profiles/web/cordis.patch.yml` 已配 `mcp-chrome-devtools`，
以**连接模式**挂到 corum 应用的 CDP 端口（`--browser-url=http://127.0.0.1:9222`）。
会话里的 `mcp__chrome_devtools__*` 工具（list_pages / evaluate_script / take_screenshot /
click / fill / take_snapshot / wait_for 等）直接驱动 corum 主窗口，是**默认首选**：

- `list_pages` → 找 corum 主窗口（`http://127.0.0.1:<ephemeral>/`，coding combo 标题
  为 DeepSeek Harness；dev-agent combo 为 corum 界面）。如有多个 page（floating 窗等），
  用 `select_page` 切到主窗口再操作。
- `evaluate_script` → 跑任意 JS，含 RPC 桥调用（见下「RPC 调用」）。**替代原
  `cdp.mjs eval/evalfile`**：把验证脚本作为 function body 传入即可，长脚本建议先写到
  临时文件再读出来传（避免一次次手拼）。
- `take_screenshot` → 截图。**注意**：`filePath` 参数受 DSH 工作区沙箱限制，写
  `/tmp/...` 会被拒；**省略 filePath** 让它内联返回图片即可。
- `take_snapshot` → a11y 树快照，适合做 DOM 结构断言和定位可交互元素 uid。
- `click` / `fill` / `fill_form` / `press_key` → 纯 UI 链路验证（React controlled input
  用这些工具，不要用 evaluate_script 直接 `el.value=`——不触发状态更新）。

**MCP 不可用时回退 `cdp.mjs`**：

```bash
# 用技能自带的那一份（推荐——见下节「脚本位置」）：
SKILL="$CORUM_HOME/skills/corum-cdp-verify"
node "$SKILL/scripts/cdp.mjs" evalfile /tmp/check.js   # 从文件执行 JS（推荐，免 shell 转义）
node "$SKILL/scripts/cdp.mjs" eval '<js表达式>'
node "$SKILL/scripts/cdp.mjs" shot <截图名>             # 截图到 /tmp/corum-cdp/shots/
```

## 脚本位置：随技能打包，路径自带「主 checkout」解析（2026-09-12 用户定调）

**要在 CORUM_HOME 的技能路径里自带全套脚本** —— 技能是 `<CORUM_HOME>/skills/corum-cdp-verify/`，
`SKILL.md` + `scripts/`（`cdp.mjs`、`corum-instance.sh`、`rpc-helper.js`、`ui-verify.mjs`、
`app-launch-guard.sh`）+ `agents/` 一起打包，所以**不在仓库里也能用**：
子 Agent 在隔离 worktree（`.corum-worktrees/wt-*`）里 cwd 没有构建产物，但技能路径是绝对且稳定的。

各脚本（`corum-instance.sh` / `cdp.mjs` / `ui-verify.mjs`）都按同一口径解析
**主 checkout**（拿依赖、构建产物、验证实例 home 的那份）：

1. `CORUM_REPO=<主 checkout 根>`（显式最优先；`cdp.mjs` 另有 `CORUM_DESKTOP_PKG`）
2. 脚本自身所在仓库（仓库 `scripts/` 版走这条）
3. cwd 的 git 主仓（`git rev-parse --git-common-dir` —— worktree 里指回主仓）
4. 都不成立 → **快速失败并打印可执行下一步**（绝不猜、不连环试探环境）

**隔离 worktree 里不要另起实例**：验证实例是**一份**（`<主 checkout>/packages/desktop/.corum-verify-home`，端口 `:9333`），`corum-instance.sh` 用 PID + 锁自守——已在跑就复用，别开第二个端口去抢。子 Agent 的授权边界是「读 + 复用」，起停实例由主 Agent 决定（避免两个子 Agent 互相重启对方的中途验证）。

约定：**技能目录/仓库副本二选一都行，但别改副本**——仓库 `scripts/*` 是源，技能里的 `scripts/*`
是打包副本，`./scripts/verify-fork-drift.sh` §18 会断言两者逐字节一致，不一致直接红。
改脚本的正确姿势：改仓库 `scripts/*` → 复制进 `<CORUM_HOME>/skills/corum-cdp-verify/scripts/`。

**沙箱拦截 localhost**：`127.0.0.1:9222` 在 bash 沙箱内必须 `require_escalated`
运行，否则 `Operation not permitted` / `Connection refused`。（MCP 工具无此问题——
MCP server 是独立进程，不走 bash 沙箱。）

## 两条实测把子 Agent 拖死的工具坑（写脚本前先看）

- **写临时脚本用 write 工具，不要用 shell 重定向/heredoc**：现在每次 bash 调用都是
  **一次性 shell**，`cat > /tmp/x.js <<'EOF' … EOF` 不会挂死了（旧版本在持久 shell（pty）
  下会挂到 300s —— 持久终端组已于 2026-09-14 撤销，这条坑的**前提已消失**）。
  正确的姿势与挂死无关，是可控性与可审计性：`write` 工具让引号/缩进/多行由工具层处理
  （shell 里 heredoc 的终止符与转义最容易出错），并且落在改动审查轨迹里；
  `node -e '…'` 只适合真的一行能写完的东西，需要多行就走 write + `node <file>`。
- **`timeout` 在 macOS 上不存在**：`timeout 60 node scripts/cdp.mjs …` 直接
  `bash: timeout: command not found`（exit 127）。要限时就把超时放进脚本自身
  （`cdp.mjs` 内部已有 30s 连接等待），或用后台 + `kill`；别指望 GNU 工具链。
- **不要在 worktree 里跑 `scripts/*` 的旧副本**：worktree 没有 `node_modules`
  （`Cannot find module 'ws'`）也没有构建产物。一律用技能自带的
  `$SKILL/scripts/…`（它自带主 checkout 解析），或显式 `CORUM_REPO=<主 checkout>`。

## 拓扑判定：**不要试图知道「我的宿主是哪个实例」**（不依赖 ps/lsof）

2026-09-12 实测：子 Agent 在沙箱里被禁 `ps`（`/bin/ps: Operation not permitted`），于是改用
`lsof` 拼凑，最后得出**错误结论**「:9333 的宿主就是我」，并开始考虑重启它——那会杀掉用户的应用。
真相是：**会话从内部无法可靠判定自己的宿主**。所以纪律是：

- **不要**用 `ps` / `lsof` / 端口扫描去猜宿主，也不要用「:9333 页面上出现了我的卡片」反推
  （那可能只是你打错了端口，读到了主实例）。
- 需要知道「哪个实例在跑」时，用**唯一权威口径**：`$SKILL/scripts/corum-instance.sh status --home=verify`
  （读 `<CORUM_HOME>/run/*.pid` + 探测 CDP）；它只报它自己那个 home 的实例。
- 需要知道「我在哪个 home」时，看**你自己的会话文件路径**：
  `<CORUM_HOME>/sessions/<project>/<sessionId>/`——你在哪个 home 下能找到自己的 sessionId，
  就说明宿主用的是那个 home（这条不需要 ps）。
- **永远不要重启/杀掉你的宿主**：你无法确认它是不是用户的主实例。要重启就让主 Agent 决定，
  或明确向用户请求（报告里写「需要重启宿主实例，请确认」）。
- 任何针对 `:9222` 的操作（读也算）都视为**越界**，除非用户当次明确授权。

## 装置起不来时：**不 debug 环境**，走一次可执行下一步，然后如实报告（硬规则）

脚本已内置 fail-fast：解析不到主 checkout、端口不通、PID 记录缺失，都会打印**可执行下一步**
并以退出码 2 结束。你被允许做的是：

- 按它打印的那一步做**一次**（`cd` 到主 checkout / 设 `CORUM_REPO=<根>` / 等 Electron 就绪后重跑 `status`）。

**禁止**（都属于「自己 debug 环境」，本项目已经为此浪费过时间）：

- `lsof` / `pgrep` / `kill -0` 连环试探，猜端口、猜进程；
- 换个端口或换个 home **另起一个实例**绕过冲突；
- 写一次性探针脚本绕过装置去「直接验一下」；
- 手改 PID 文件、手杀不属于自己的进程。

一次重试仍失败 → **停下**，把「完整命令 + 原始输出 + 你已排除的两三个假设」写进汇报，等指令。
验证装置的问题属基础设施缺陷（交主 Agent/用户），不是让你现场修环境。
- 依赖 `ws` 包：默认从 kkc-desktop/packages/desktop 解析；仓库在别处时设
  `CORUM_DESKTOP_PKG=<desktop 包 package.json 路径>`。
- 找不到页面报 `no main page` = 应用没起或端口不对。


---

# 【2026-09-12 新增】两实例纪律 + 声明式验证装置

> 这一节的由来：指挥模式实机测试实测 —— **实现 9.1 分钟，验证 98.8 分钟（占整轮 84%）**，
> 因为验证子 Agent 写了 **48 个一次性探针脚本**，每加一条断言就新写一个脚本 + 一次 bash
> 往返。同时它还要面对一个矛盾：主实例跑的是**启动期 bundle 快照**，改完 build 完也验不到
> UI；而让它去重启主实例，就是把用户正在用的应用整死（2026-09-11 真实事故）。
> 本节的两个装置就是为这两件事做的。

## 装置一：验证实例（`$SKILL/scripts/corum-instance.sh --home=verify`）—— 你随便重启，主实例不动

主实例（用户在用，CDP **:9222**）**永远不要碰**：
不要 kill / pkill / 重启任何不是你启动的进程，不要 `corum-instance.sh start --home=dev`。

你有自己的实例，可以自由重启：

```bash
"$SKILL/scripts/corum-instance.sh" start|restart|stop|status --home=verify
```

> **2026-09-26 变更：三个实例共用同一个 home `~/.corum`**（用户定调「开发和验证的
> CORUM_HOME 都指向同一个路径；打包的走默认路径 ~/.corum」）。
> - dev(:9222) / verify(:9333) / packaged(:9222) 的 `CORUM_HOME` **都是 `~/.corum`**；
> - **身份靠 PID 文件名区分**（`coding.pid` / `verify-coding.pid` / `pack-9222.pid`），
>   **不是**靠 home 路径 —— 三者的 cmdline 完全一样，任何按路径/名字的宽匹配都会互杀；
> - verify 实例的 `stop` **只杀自己 PID 记录的那棵树，绝不做宽匹配兜底**；
> - userData 按 `(mode, port)` 分目录，故单实例锁不冲突，两个实例可同时运行（已实测）。
>
> 旧路径 `packages/desktop/.corum-{dev,verify}-home` 仍可用（`--home=legacy-dev` /
> `legacy-verify`），但**默认已不再使用**；迁移期新旧可能并存。

改完 client 插件后**必须** `restart` 才能看到新产物（bundle 是启动期加载的）：

```bash
pnpm --filter <包名> run build && "$SKILL/scripts/corum-instance.sh" restart --home=verify
```

## 验收工作区纪律：**统一用 `corum-test`，别每次新建**（2026-09-26 用户定调）

做验收时，**在 `/Users/kukucai/work/corum-test` 这一个工作区里新建对话**即可，
不要每次另建工作区。

> 用户原话：「我发现目前每次都新建一个验收工作区有点多余。除非是要验收和工作区
> 相关的，否则都在同一个工作区创建新对话验收。」

**唯一例外**：验收内容**本身与工作区相关**（多工作区、worktree 隔离、跨工作区写
EPERM、路径类断言）—— 那种情况本来就需要不同的工作区身份，另建临时工作区是对的。

### 验收结束后：**保留 `corum-test`，不要删**（2026-10-11 补，此前是空白）

上面说「统一用」，但**没说用完怎么处理**，于是出现两种相反的合理解读。明确规则：

- **常驻的 `corum-test`**：验收完**保留**（工作区注册 + 目录都留着）。它就是要被反复
  复用的那一个；删掉下次还得重建，等于把「别每次新建」的初衷绕回去。
- **验收产生的会话与临时文件**：按需清理——**日志/产物类**痕迹可以清，
  但**不要为了「干净」而删掉工作区本身**。
- **一次性临时工作区**（上面那个唯一例外建的）：用完**应当删**（连同其目录），
  否则正是「侧栏堆积一次性工作区」那件事。

> 判据一句话：**常驻的留、临时的删**。分不清时**留**——留着只是占一个侧栏条目，
> 删错则要重建工作区 + 丢历史验收记录，且重建时更可能撞上下面那条注册一致性陷阱。

**为什么**：每次新建 ⇒ 侧栏堆积一次性工作区、历史验收记录分散（回看某次验收的对话
找不到）、同一个验收对象被反复注册成不同 workspace（2026-09-26 实测：`kkc-desktop`
这个路径被两个 workspace 记录同时认领，**直接导致宿主启动失败**：
`workspace domain is inconsistent: path '...' is claimed by both workspace 'A' and 'B'`）。

**技术要点**（写进 DB 或建工作区的正确方式）：
- 工作区 = `u_workspace_workspaces` 表的一行（key=workspaceId，value 含 `path`/`title`/
  `sessionIds`）**加上** `unit_globals.workspace` 里 `workspaceIds` 的顺序条目；
  **两处必须同时一致**，否则启动即报 `is absent from registry order`。
- 三条宿主启动时强校验的不变式（违反任一即**整棵树加载失败**，不是降级）：
  ① 同一 `path` 不能被两个 workspace 认领；② 同一 `sessionId` 不能被两个 workspace
  认领；③ 注册表顺序与表内容必须一一对应。
- **推荐**用应用自己的 RPC 建（自动满足全部不变式）：
  `POST /api/workspace/create`，args 形如 `{ request: { path: "<绝对路径>" } }`
  （注意是 `request` 包一层，直接传 `path` 会被拒：`args fields do not match the descriptor`）。
  已存在的路径会返回 `created: false` 而**不报错**（幂等）。

### ⚠️ 清理验收痕迹（**必须**；2026-09-26 我违反本纪律并把应用改成起不来之后补）

**`--home=verify` 不隔离 home**：dev / verify / packaged **共用 `~/.corum`**（用户 2026-09-26
定调）。所以自验会**直接写进用户的真实会话索引与工作区注册表** —— 侧栏会堆一次性工作区。
真隔离请用 `--home=/abs/path`；否则**跑完必须清理下面全部**：

| # | 位置 |
|---|---|
| ① | `~/.corum/sessions/<workspace-key>/<sessionId>/` |
| ② | `~/.corum/sessions.json` 里指向它的条目 |
| ③ | `~/.corum/storages/kv.sqlite` → `u_workspace_workspaces` 的行 |
| ④ | 同一 DB → `unit_globals` 中 `unit='workspace'` 的 `workspaceIds` 顺序条目 |
| ⑤ | `~/.corum/review/<id>/` |
| ⑥ | 工作区目录本身 |

★ **③ 与 ④ 必须同一个事务里成对增删**，否则启动即
`workspace domain is inconsistent: registry order references missing workspace '<id>'`
（反向为 `... is absent from registry order`）⇒ **整棵插件树加载失败**（不是降级，
用户实例重启后也起不来）。删完核验：`workspaceIds` 与表的 key 集合**一一对应**。

★ **别把 SQL 报错当「空结果」**：`unit_globals` 主键列是 **`unit`** 而非 `key`；
`SELECT key FROM unit_globals` 会报错。我把它误读成「表是空的」，只删表不删顺序 ⇒ 当场改坏。

> 更推荐：清理后用**自己的** `:9333` 启一次，确认日志出现 `combo "<x>" host ready`
> 且**没有** `plugin tree failed to load`，再收工。

## 装置二：声明式断言跑器（`$SKILL/scripts/ui-verify.mjs`）—— 一轮验证 = 一份规格 + 一次调用

**不要**再「一条断言写一个脚本」。写一份 JSON 规格，跑一次，拿一份 PASS/FAIL 报告：

```json
{
  "port": 9333,
  "before": [ { "click": "button[aria-label='插件中心']" }, { "wait": 1500 } ],
  "assert": [
    { "label": "浮层已打开", "selector": "[data-plugin-manager-overlay]", "exists": true },
    { "label": "标题正确",   "selector": "[class*=panel]", "textContains": "插件中心" },
    { "label": "圆角 24",    "selector": "[class*=panel]", "style": { "borderRadius": "24px" } },
    { "label": "市场截图",   "screenshot": "market-overlay" }
  ]
}
```

```bash
node "$SKILL/scripts/ui-verify.mjs" /tmp/market.spec.json   # 退出码 0=全 PASS，1=有 FAIL，2=连接/规格错
```

- `before` 步骤：`click`（CSS 选择器，或 `text:显示文字` 按可见文字找按钮）、`wait`（毫秒）、`eval`（原始 JS）、
  `type`（**真打字**：`{ "type": "…", "into": "选择器", "submit": true }`，走 `Input.insertText`——
  React 受控输入只有这条路数；`submit` 追加 Enter）、`key`（单键/组合键，如 `"Escape"`、`"Meta+a"`）、
  `resize`（`{ "width": 1100, "height": 620 }` / `{ "reset": true }`，压视口用）。
- `assert` 断言：`exists` / `count` / `textContains` / `textEquals` / `style`（计算样式精确匹配）/
  `js`（原始表达式 + `expect` 深比较；省略 `expect` 即「取真值」——滚动量、折叠行数、computed 值用它）/
  `screenshot`（存 `<CDP_OUT>/<名>.png`，默认 `/tmp/corum-cdp/shots`）。
- 顶层 `target`：`"main"`（缺省，**排除浮窗**）或 `"floating"`（先 `window.corumDesktop.openFloating(slotKey)`）；
  `pageUrlIncludes` 可做任意子串匹配。**浮窗也是 page**——不指定 target 时断言可能打在浮窗上（假绿）。
- 真实时序原则（2026-09-12 血泪）：按**用户实际的时序**验证——跑完再展开、重启后再看、main 动过之后再对账。
  按实现者的时序（先展开再跑）验证只会得到假绿：第四轮两项交付就是这么绿着上线的（BUG-32/33）。
- **失败即非零退出**，可直接当验收门禁；报告逐条给实际值，便于判断是「真失败」还是「断言语写错」。
- 端口默认 9333（验证实例）。要打主实例就显式 `port: 9222`（一般不需要）。

### 一轮 UI 验证的标准动作（照抄即可）

```bash
pnpm --filter <包名> run build          # 1. 产物
"$SKILL/scripts/corum-instance.sh" restart --home=verify    # 2. 你自己的实例吃上新 bundle
cat > /tmp/spec.json <<'JSON'           # 3. 一份声明式规格（全部断言写在一起）
{ "before": [ {"click": "text:插件"} ], "assert": [ {"selector": "[data-plugin-manager-overlay]", "exists": true} ] }
JSON
node "$SKILL/scripts/ui-verify.mjs" /tmp/spec.json   # 4. 一次调用拿 PASS/FAIL
```

## 启动 / 重启应用：用 `$SKILL/scripts/corum-instance.sh`（安全、记录 PID、不误杀微信）

**两种方式共用同一个启动脚本**——MCP server 是连接模式，自己不启动应用；
每次验证前先确认应用在跑：

```bash
# dev 主实例（:9222）——注意：这是**用户主实例**，子 Agent 只读复用、不要重启
"$SKILL/scripts/corum-instance.sh" status --home=dev
# 你自己的验证实例（:9333）——随便重启
"$SKILL/scripts/corum-instance.sh" start|restart|stop|status --home=verify
```

> 2026-09-25：`cdp.sh` / `verify-instance.sh` / `dev-ide.sh` / `combo.sh` / `pack-instance.sh`
> **五个脚本已合并**为 `corum-instance.sh`（唯一实现 + 长选项区分实例）。旧命令的等价写法：
> `cdp.sh X` → `corum-instance.sh X --home=dev`；`verify-instance.sh X` → `… X --home=verify`。

- **combo**：`--combo=<id>`（默认 `coding`）。可用 id：`corum-instance.sh list --combos`。
- **CORUM_REPO**：skill 快照版（`~/.agents/skills/corum-cdp-verify/scripts/corum-instance.sh`）在仓库外，
  运行时须先 `export CORUM_REPO=/Users/kukucai/work/kkc-desktop`；仓库内 `scripts/corum-instance.sh`
  自动定位仓库根，无需设。

### 为什么用这个脚本（三条红线都踩过）

1. **start 必须秒回**：本脚本常被 Agent 工具以「带超时的 bash 调用」执行。若脚本内
   等 CDP/PID（>10s），外层超时会 SIGTERM **整个进程组**、连带刚起的 Electron
   （GPU/network 崩溃退出，`exit_code=15`）。所以 start 只做 cleanup + 后台 spawn +
   立刻 exit 0；PID 记录/CDP 就绪交给 status 补。
2. **spawn 必须切断与脚本的 fd 血缘**：后台 Electron 若继承脚本的 stdout/stderr fd，
   脚本退出时 shell 会等该 fd 关闭而 **hang**（又触发外层超时连坐）。脚本用独立
   子 shell 包裹 `nohup ... >log 2>&1 </dev/null & disown`，三重 fd 全断。
3. **清理必须精确、绝不误杀微信开发者工具**：微信开发者工具也是 Electron，命令行
   含 `electron`/`node`。**绝不用** `grep -iE "electron|lib/(bridge|main).js"` 这类宽
   pattern——它会匹配微信。脚本只按「PID 文件记录 + `is_self` 校验 cmdline 必含
   本仓库 `packages/desktop` 绝对路径」双保险杀进程；微信路径
   （`/Applications/wechatwebdevtools.app` / `/Applications/微信.app`）绝不含此子串。
4. **is_self 用 pgrep 不用 ps**：Agent 工具 sandbox 里 `/bin/ps` 被禁
   （Operation not permitted），`ps -p <pid> -o command=` 取空会让 is_self 永远 false、
   cleanup 静默全跳过（2026-08-28 四实例残留事故的根因）。改用
   `pgrep -f "$SELF_MARK"` 集合判定，目标 pid 在集合内即 self。

### 手动启动（备用，需 tty 持久会话）

```bash
cd packages/desktop && CORUM_DEBUG_PORT=9222 CORUM_HOME=$PWD/.corum-dev-home CORUM_DEV_HMR=500 \
  node lib/cli.js --combo=coding
```

- **必须用 tty 持久会话方式启动**（进程挂在会话里）；`nohup ... &` / 后台管道方式
  会在命令结束时被杀，应用秒退。
- `CORUM_DEBUG_PORT=9222` 开启 CDP（壳在 main.ts 里读这个 env 加 remote-debugging）。
- dev home 是 `packages/desktop/.corum-dev-home`（测试数据持久在此；清场重测时
  mv 走 `.agent-presets/* teams/* projects/* agent-profiles`，不要用 rm）。

host 侧插件（corum-agent-dev 等）改动必须重启应用才生效；renderer 侧（UI 包）
改动 HMR 自动热更（但 host 已挂起恢复的循环不会重装配新工具，仍建议重启）。

## RPC 调用（scripts/rpc-helper.js）

renderer 页面里有 `window.corumDesktop.unary` IPC 桥（**仅 dev-agent combo**；
coding combo 主窗口是 DSH Web GUI 本身，无此桥）。把仓库 `scripts/rpc-helper.js`
（或 skill 快照版）的 `call/callRaw` 两个函数复制进你的 evaluate_script / evalfile
脚本顶部即可调全部 host 服务（端点清单见该文件头注释）：

```js
const { projects } = await call('corumProject', 'listProjects', {})
await call('corumRuntime', 'enqueue', { projectId: 'project', profileId: 'dev', type: 'general', summary: '...' })
const events = await call('corumRuntime', 'getDomainEvents', { projectId: 'project', fromSeq: 0 })
```

- 验证**拒绝路径**用 `callRaw`（不抛错，拿 `{ok:false, error}`）。
- RPC 与 UI 表单走同一 IPC 桥同一端点——RPC 驱动 ≈ UI 操作，但关键 UI 链路仍应
  补一次纯点击验证（用 MCP 的 click/fill 工具，或 evaluate_script 里 native setter +
  `input` 事件赋值；直接 `el.value=` 不触发 React 状态更新）。

## 验证三层结构

1. **RPC 驱动**：call 构造场景（建项目/拉团队/派任务/干预）。
2. **事件日志核对**：读 `packages/desktop/.corum-dev-home/projects/<id>/scheduler-events.jsonl`，
   事件链（assigned→started→completed 等）是调度事实源，逐条核对类型/载荷/causedBy。
   也可 `call('corumRuntime','getDomainEvents',...)` 拿结构化数据。
3. **UI DOM 断言**：evaluate_script 读 `document.body.innerText` / take_snapshot 查
   a11y 树验证渲染；查布局溢出用 `scrollWidth>clientWidth`。截图用 take_screenshot。

## 测试数据与场景构造经验

- dev home 已有：项目 `project`/`fresh-check`、团队 `team`、profiles `pm`/`dev`/`qa`
  （pm 是系统兜底统筹角色，删了会在建项目时重建）。
- **flash 模型执行极快**（10s 内完成简单任务）——验证卡住/干预/执行中状态，
  用 `sleep 300` 这类**真实耗时命令**构造执行窗口；编造「逐个创建 50 个文件」
  会被模型用循环命令秒杀。
- 验证阻塞链：任务摘要里声明「关键信息只有 X 知道，不知道就 report_blocked」。
- 长任务（真实编码）要耐心：`runPromptForType` 等 PM 回复可能 2-5 分钟，
  轮询事件日志确认推进（最后活动时间在涨 = 活着）。
- 警惕模型「跑偏」：自测类任务容易陷入本地环境纠缠（起 dev server/杀进程），
  这本身可用于卡住感知验证；验收时看产出物文件而非只听汇报。

## 常见坑

| 症状 | 原因 | 解法 |
|---|---|---|
| 事件流同一任务多条 started | 双 host 残留 | `./scripts/corum-instance.sh stop --home=dev` 清干净再 start |
| tsc 报 Cannot find type definition 'node' | node_modules 被 pnpm verify-deps 剥离 | `CI=true pnpm install --no-frozen-lockfile` 恢复；之后直接用 .bin/tsc 别用 pnpm run |
| UI 改了不生效 | HMR 只热 renderer；host 插件要重启 | 重启应用 |
| 会话恢复后工具缺失 | 已存活 Agent 的 setup 不重跑 | 重启应用（resume 重跑 setup） |
| cdp.mjs evalfile 里模板字符串/展开语法报错 | shell 转义 | 一律 evalfile 从文件读，别用 eval 内联长代码；MCP evaluate_script 无此问题 |
| 启动脚本 hang 住不返回 / Electron 起后秒退（GPU exit_code=15） | 后台 Electron 继承脚本 stdout/stderr fd，或脚本内等 CDP 超时被外层 SIGTERM 连坐 | 用 `scripts/corum-instance.sh`：spawn 独立子 shell + 三重 fd 重定向；start 秒回不等 CDP |
| 清理时误杀微信开发者工具 | 用 `grep -iE "electron\|node\|lib/main.js"` 宽 pattern 匹配进程 | 用 `scripts/corum-instance.sh`：`is_self` 校验 cmdline 必含本仓库 `packages/desktop` 绝对路径 |
| `is_self` 永远 false、cleanup 静默全跳过 | sandbox 里 /bin/ps 被禁，cmdline 取空 | `corum-instance.sh` 用 pgrep 集合判定（2026-08-28 修复） |
| MCP take_screenshot 写 filePath 报 Access denied | DSH 工作区沙箱限制 filePath 必须在工作区内 | 省略 filePath 让截图内联返回 |
| MCP 工具报 "Could not connect to Chrome" | corum 应用没在跑，或 9222 端口被别的实例占用 | `./scripts/corum-instance.sh status --home=dev` 确认；没在跑就 `start --home=dev` |
| shell 脚本报 `VAR�: unbound variable`（带乱码） | 变量后紧跟全角字符（`$VAR（中文`），bash 把全角字符当变量名一部分 | 一律写 `${VAR}（中文`，变量用花括号显式界定 |
| macOS 无 `setsid` 命令 | `setsid` 是 Linux 的，macOS 没有 | 用独立子 shell + `nohup ... & disown` + fd 重定向脱离（见 corum-instance.sh） |
| `cdp.mjs evalfile` 报 `SyntaxError: Unexpected identifier` / `await is only valid…` | evalfile 的脚本被当**单个表达式**求值，顶层多条语句/顶层 await 不行 | 整段包成 `(async () => { … return out })()`；`await` 只出现在该 IIFE 内 |
| `window.corumDesktop.unary is not a function` | 0.1.2 起传输层换成官方 loopback webserver，旧 IPC 桥已删 | 用 fetch 官方端点：POST `/api/<ns>/<method>`，信封 `{type:'client-request', rpcId, method:'<ns>/<method>', payload:{args}}`（见仓库 `scripts/rpc-helper.js`） |
| RPC 报 `args fields do not match the descriptor: unexpected …` | @Remote 端点参数是**唯一裸标识符**，对象入参要再包一层 | 传 `{ input: {…} }`（key = 端点的形参名），别把字段平铺在 args 顶层 |
| 需要下拉真实 option 的 **id**（DOM 只有 label） | commit 用 id 不用 label（「DeepSeek」≠「deepseek-official」） | 从 React fiber 取：`el.__reactFiber$xxx` 顺 `return` 链翻 `memoizedProps`，能拿到 context（settings/rpc）与 options 的 id |
| `corum-instance.sh start` 起不来，日志 `node: command not found` | 沙箱默认 PATH 无 node | `export PATH="/opt/homebrew/bin:$PATH"` 再起实例 |
| Electron 起不来，`Electron failed to install correctly` / `fetch failed` | electron 二进制未下载/损坏 | 走 npmmirror 重装：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/.pnpm/electron@*/node_modules/electron/install.js` |
| 「UI 选了项却被回弹」怀疑 host | UI 层回弹 ≠ host 校验拒绝 | 先分责：用 settings `mutate` 直调同一字段验 host，host 接受 ⇒ 责任在 UI commit 逻辑 |
