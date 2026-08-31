# B1 boot 图机制调研：ui-base external 化的技术依据（round 9 子 Agent 实证）

> 定位：本笔记是「共享模块 + 插件自声明」专项（B1-pre + C1 合并）的技术依据。
> 内容由一次完整的 external 化试做（已回退）实证得出，含官方源码位置、机制结论、
> 改造步骤清单与风险评估。试做的全部源码改动已回退，仅保留本调研。

---

## 1. boot 图（__DSH_BOOT__.entries）如何发现 dsh.client 并生成 entry

**结论：一个包要进 `__DSH_BOOT__.entries`，必须同时满足两条：**
1. package.json 有 `dsh.client` 声明（`platform: 'web'`）——让 cordis loader 把它当
   「有 client 半的插件」纳入扫描；
2. 该包经 `exports['./client']` 暴露一个**构建产物 bundle**（closure-factory 格式，
   即 `window.__ModuleLoader__.load({id, factory})`），host 侧 webserver 把它服务出 URL。

**官方源码位置（均在 `node_modules/@deepseek-ai/dsh-client-modules/lib/`，本包经
`exports['./src/*']` 也可读到未编译源码）：**

- **host 侧扫描与 entry 组装**：`dsh-client-modules/lib/index.js`
  - `resolveMeta(loaderName, baseUrl)`（~L620）：读包的 package.json，经
    `parseDshClient` 解析 `dsh.client` 声明（`inject`/`external`/`immediately`）。
    无 `dsh.client` 或 `platform !== 'web'` 的包返回 `null`（不进图）。
  - `clientExportOf(packageName, pkg.exports)`：要求 `./client` exports 指向一个
    存在的 bundle 文件路径（`clientPath`），host 把它 stat + 经 webserver 服务。
    **若 `./client` default 指向源码 `.ts`，host 服务的是 TS 源码而非可执行 bundle，
    无法作为模块表条目**——这是 ui-base 改造前不是模块表条目的直接原因。
  - `graphRow(id, rev, fields)`（~L330）：entry 形如 `{id, url, rev, inject?, external?, immediately?}`，
    `url = comboUrl([id], rev)`，`rev` 是 bundle 内容的短哈希（cache-busting + HMR invalidate 凭据）。
  - `orderByModuleGraph(entries)`（~L345）：**按 `external` 声明拓扑排序**——一个
    external 指向另一 graph row 时，被依赖的 row 必须排在消费者之前（`require` 是同步
    的，动态包必须先于消费者 arrival）。external 指向静态 seed 词（react 等）则不加图边。

- **browser 侧模块表**：`dsh-client-modules/lib/client.js`
  - `stripClientSuffix(spec)`（~L61）：`<id>/client` 与裸包名 `<id>` 归一到**同一条
    graph row**。这是「各消费包 external 写 `@corum/corum-ui-base/client`、ui-base 注册
    id 写 `@corum/corum-ui-base`，二者命中同一模块」的机制基础。
  - `ClientModuleSystem`（~L183）：
    - `materialize(id)`：**每个模块只 materialize 一次**，record 存 `loadCache`，被所有
      require 共享 → **单例语义是模块系统核心**，动态 bundle 与静态 seed 同为单例。
    - `makeRequire` 解析顺序：seed 词 → 已 materialize 的 record → 已注册 factory →
      否则 throw（`require("<spec>") missed the module table`）。
    - `import(specifier)`：seed → loadCache → graphRows（arrive 该 row 及其 external 依赖，
      递归）→ materialize。

**单例语义官方源码注释（client.js 头部）**：「executing a plugin bundle only REGISTERS its
factory … Materialization … happens on first import/require and is memoized in
ClientModuleLoader.loadCache」。即「包进 boot 图 + 消费包 external 它 ⇒ 天然单例」成立。

---

## 2. 纯 client 无 apply 的包能否进 boot 图？

**结论：能进 boot 图（entry 生成只看 `dsh.client` 声明 + `./client` bundle，不看 apply），
但不能被 cordis 当作可激活插件——必须有 apply，否则 loader create() 直接抛错。**

依据（`node_modules/@deepseek-ai/cordis/lib/index.js`）：
- `plugin(plugin, config)`（~L1618）：`const callback = this.resolve(plugin)`；
  `if (!callback) throw new Error('invalid plugin, expect function or object with an
  "apply" method, received …')`。
- `resolve` 的有效性检查（~L1446）：`object && typeof object.apply === 'function'`。
- web 壳 boot（`dsh-web-frontend/dist/assets/index-*.js` 的 `runPluginBoot`）对
  `manifest.plugins` 的每个 id 做 `o.create({name})` 并 `assertEntriesActive`——
  无 apply 的条目会让整个 boot 失败（loud）。

**官方先例核查**：`node_modules/@deepseek-ai/dsh-client-*/lib/client.js` 全部导出
`exports.apply`（本轮逐一 grep 确认，含 dsh-client-ui-theme 等纯 UI/服务包）。
**没有任何「纯 client 无 apply」的官方 dsh.client 插件先例。**

**对 ui-base 的直接含义**：ui-base 要进 boot 图当共享单例，**必须补一个最小 no-op
`export function apply(): void` + `export const inject: string[] = []`**（空 inject =
不等待任何服务，可即刻激活，不参与 inject 等待链）。本轮试做即如此，已验证可行
（bundle 导出 `exports.apply`/`exports.inject`，build PASS）。

---

## 3. ui-base external 化的完整改造步骤清单（供 B1-pre+C1 专项参考）

> 本轮已完整试做并通过「编译 + bundle 结构 + 内联副本清除」三层验证；**实机回归因
> corum-ide-ui 当时处于 B1-main 半成品状态（root 槽注册失败白屏）而未能干净完成**。
> 步骤本身成立，与 C1 合并专项时可照此复现。

### 3.1 ui-base 身份转变（纯库 → 模块表单例共享模块）
1. `corum-ui-base/package.json`：
   - 加 `dsh.client = { platform:'web', inject:[], immediately:false }`；
   - `exports['./client'].default` 从 `./src/client/index.ts`（源码 TS，被消费包内联
     的根因）改为 `./lib/client.js`（产物 bundle）。
2. `corum-ui-base/src/client/index.ts`：尾部加最小插件面
   `export const inject: string[] = []` + `export function apply(): void {}`（no-op，
   纯共享库无 cordis 服务/槽位要注册）。
3. `pnpm build` → 确认 bundle 头注册 `id: "@corum/corum-ui-base"` 且导出 `exports.apply`。

### 3.2 挂进 cordis 组合（让它进 boot 图）
4. `packages/desktop/cordis.ide.patch.yml` 的 `insert:` 块、**ide-shell 之前**插一行：
   `- id: corum-ui-base` / `name: '@corum/corum-ui-base'`。
   （`immediately:false` 即可——boot 时 `runPluginBoot` 会对所有 `manifest.plugins`
   统一 `create()`，无需立即档；external 拓扑排序已保证它先于消费者 arrival。）

### 3.3 各消费包改 external（boot 图里有 client bundle 的包都要改）
5. 每个消费包 `package.json` 的 `dsh.client.external` 数组加 `"@corum/corum-ui-base/client"`。
6. 每个消费包 `tsdown.config.ts` 的 `CLIENT_EXTERNALS` 加 `'@corum/corum-ui-base/client'`
   （`noExternal` 回调已按此数组判定，加上即不再内联）。

**本轮实际改动且验证的消费包（boot 图内有 client bundle 者）**：
`corum-ide-ui`（ide-shell）、`corum-ide-sidebar-ui`、`corum-ide-explorer-ui`、
`corum-ide-panel-bottom-ui`、`corum-agent-ui-dev`、`corum-ui-conversation`、
`corum-desktop`（壳 client 半，EditorColumn 用 ui-base 常量）。

**无需改的包**：
- `corum-skill-manager-ui-dev` / `corum-team-ui-dev`：**无 `dsh.client` 声明、不进
  boot 图**，只是被 `corum-agent-ui-dev` 源码 import 内联进其 bundle 的组件库。
  `agent-ui-dev` external ui-base 后，它们经 agent-ui-dev 的 bundle 自然共享单例，
  本身无需 external 声明（也无 `dsh.client` 块可挂）。
- `corum-ide-project-ui` / `corum-ide-conversation-ui` / `corum-ide-statusbar-ui` /
  3 个 `ide-test-*`：源码**未 import ui-base**（本轮 grep 全量确认），不消费故无需改。

### 3.4 防止 ui-base 被误当业务插件
7. `corum-ide-ui/src/client/index.tsx` 的插件 UI 扫描 EXCLUDE 集合加
   `'@corum/corum-ui-base'`（它是纯模块库、无独立 UI，不该被注册成可拖入网格的区域）。

### 3.5 验收（本轮已通过的部分）
- 每个包 build PASS；全仓 typecheck 中**所改各包**单独跑 PASS。
- **内联副本清除**：所有消费包 bundle 的 `registerSlot`/`slotRegistry`/`__corumSidebarMode`
  由 >0 → **0**，仅 ui-base 自身 bundle 含定义。
- **bundle 结构**：ui-base 以 `@corum/corum-ui-base` 注册 + 导出 apply/inject；消费包
  统一 `require("@corum/corum-ui-base/client")` 走模块表（`stripClientSuffix` 归一 →
  命中 ui-base graph row → 单例 materialize）。
- **实机回归**（与 C1 合并专项时必做）：restart 后 IDE 壳正常渲染、无
  `renderSlot('root') before any 'root' registration` / `missed the module table` 报错、
  侧栏 task/project tab 切换正常。

---

## 4. 实际风险点评估

1. **白屏风险（高，且本轮真实撞上）**：ui-base 含 GridView/RegionCard/grid/sidebar-mode/
   theme-presenter 核心，改坏即 IDE 壳白屏。本轮 external 化试做时，恰逢 corum-ide-ui
   处于 **B1-main 半成品**（grid actions 桥，root 槽 `ctx.slots.register` 的 inject 面
   类型不匹配 + 运行时 `renderSlot('root') before any 'root' registration`），导致
   **无法把「我的 external 化」与「别人的 B1-main 改动」在运行时隔离归因**。已用
   git stash 铁证二者无关（HEAD src + 我的配置 = build PASS；预存 src + HEAD 配置 =
   build FAIL），但实机回归被阻塞。**教训：external 化的实机回归必须等 ide-ui 处于
   可渲染基线时做。**
2. **`immediately` 档位误配（中）**：若给 ui-base 配 `immediately:true`，它会进
   `prefetchImmediateTier`，在所有插件 create 前预取——不必要且可能干扰 boot 顺序。
   应 `immediately:false`，靠 external 拓扑排序保证先序 arrival。
3. **类型解析漂移（低）**：`./client` default 从源码 `.ts` 改产物 `.js` 后，tsc 经
   `types` 条件（`./lib/types/client/index.d.ts`）仍解析到正确类型，本轮所改各包
   typecheck 全 PASS。但需保证 ui-base 先 build（产物 + .d.ts 存在）再 build 消费包。
4. **无 apply 直接挂会 loud 失败（已规避）**：见 §2——必须补 no-op apply，否则
   `create()` 抛 `invalid plugin`，整个 web boot 失败。
5. **EXCLUDE 遗漏（低）**：不加 EXCLUDE 时 ui-base 会被 ide-shell 扫描注册成可拖入
   区域，语义错误（虽不一定崩，但污染「添加区域」面板）。

---

## 5. 与 C1 合并的衔接点（为何不单独硬闯）

- `slotRegistry` 按 bundle 拆分的**完整解**依赖 C1（插件自声明槽：各 feature 插件在
  自己 apply 里 registerSlot 自己的槽）。B1-pre 只解决「注册表全局唯一」这一前提，
  单独做兑现不了「插件自声明」的收益。
- `__corumSidebarMode` 挂 window 全局是**有注释、工作正常的小瑕疵**（ui-base/
  sidebar-mode.ts:26-28），external 化后虽天然单例可保留，但删除它属 B1-main 范畴，
  不在本机制改造内。
- 故建议：B1-pre（本笔记的 external 化步骤）与 C1（插件自声明槽）合并为一个专项
  一次做完并统一实机回归，避免在 ide-ui 频繁变动期反复硬闯。

---

## 附：本轮试做的产物状态
全部源码改动**已回退**（git 工作区无 B1-pre 残留）；ui-base 仅保留 A2b 预存改动
（`OPEN_NEW_TASK_FORM_EVENT` 常量及其导出，与本机制无关）。本笔记是唯一保留产出。
