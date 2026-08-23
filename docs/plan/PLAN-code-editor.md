# 代码编辑器插件（Monaco 集成）设计方案

> 状态：Phase 1 进行中（1A + 2B 已定）。本文记录架构决策、落点、与后续进阶 2A 方案。

## 定位与核心决策

**Monaco 集成进 corum-desktop 这个桌面级 dsh 插件进程，而非新建一个 dsh 客户端插件。**

理由（用户拍板 + 代码确认）：

- corum-desktop 已是 dual-face dsh 插件，client half 跑在 Electron 渲染进程，自带 `corumapp://` / `corump://` 两个协议 + preload IPC 桥，是普通 dsh 客户端插件没有的「桌面级」能力。
- 因此 Monaco 作为 corum-desktop 自己掌控的资源集成，**不必适配 dsh 的模块系统规则**（`window.__ModuleLoader__` + purity gate + seed 白名单）。
- corum-desktop client bundle 的 purity gate（`tsdown.config.ts` 的 `corum-desktop-client-purity`）只拦 `@deepseek-ai/*` 前缀的跨插件值导入；`monaco-editor` 不匹配该前缀，会被 `noExternal: true` 直接内联，**无需改动 dsh 框架任何规则**。
- 审批 / diff / 保存等 dsh 语义，用额外小插件通过 slot/service 暴露给编辑器，不硬塞进壳。

## 版本与依赖

- **monaco-editor `0.56.0`**（npm 最新），走 `registry.npmmirror.com`。
- **ESM 入口**：`monaco-editor/esm/vs/editor/editor.api.js` + language contribution（`esm/vs/language/{typescript,json,css}/monaco.contribution.js`）。
- **不用** `@monaco-editor/react`（它在 dsh 自定义加载器下要绕默认 CDN/worker 加载，直接底层 `editor.api` 更可控）。

## 关键机制：Monaco 如何进 dsh 客户端

### worker 加载（最大难点，已定 1A 方案）

Monaco 靠 web worker 做语言分析。dsh 的 `corump://` 协议只按 entry id 服务 `client.js`，没有 worker 子路径。**1A 方案**：

- 把 monaco 的 worker 文件（`editor.worker.js` + `ts/json/css.worker.js`）打进桌面壳的 **dist staging**（`build/dist/monaco/`）。
- `corumapp://` 协议已能服务 dist 下任意静态文件（`protocol.ts` 的 `appPath` + MIME 表 + SPA 回退），所以 worker 走 `corumapp://app/monaco/<name>.worker.js`，**复用现有协议，不新增协议路径**。
- `MonacoEnvironment.getWorker` 按语言返回 `new Worker('corumapp://app/monaco/...')`。

改动点：
1. `pack-macos.mjs`：从 `node_modules/monaco-editor/esm/vs/...` 复制 worker 到 `build/dist/monaco/`。
2. `src/electron/protocol.ts`：`corumapp://` 的 MIME 表已含 `.js`（`text/javascript`），无需改；确认 worker 文件能被 `readFile` 正常服务（在 dist 根内，无 traversal 问题）。

### 主 bundle 内联

`tsdown.config.ts` 的 client 配置里，`noExternal` 已把非 `CLIENT_EXTERNALS` 的依赖内联。`monaco-editor` 走 ESM 入口，会被 rolldown 内联进 `lib/client.js`。需确认：

- `monaco-editor` 的 worker 文件用 `new Worker(new URL('...', import.meta.url))` 或裸路径引用，**必须 external 化**（否则 rolldown 会尝试把它当模块打包）。
- 若 monaco 的 `editor.api.js` 里有 `import ... from './editor.worker.js'` 之类静态引用，需在 tsdown 里把 `*.worker.js` 标 external。

### 编辑器组件

`src/client/editor/` 下：
- `MonacoEditor.tsx`：封装 `monaco.editor.create` + 主题对齐 dsh 的 `--dsw-*` token。
- `worker.ts`：`MonacoEnvironment.getWorker` 按语言分发到 `corumapp://` worker。
- 只读 v1：`readOnly: true`，行号、折叠、搜索、复制。

## 挂载点

### Phase 1（2B，最小验证链路）——点文件打开 Monaco

现状：`ui-conversation` 的 `openFile` 调 `workspaces.openPath(host.openPath)`，交给 OS 默认应用。

Phase 1 不劫持官方 `openFile`（避免改官方插件），而是：

- 在 corum-desktop 的 client half 里提供「Monaco 查看器」服务/组件。
- 首个落点：**复用 read 卡 / produced-files 行的文件路径**，在桌面壳加一个「在编辑器打开」入口，或先做独立 dev 入口验证加载（一个临时 view/toggle）。

> 具体交互待实现时定：最稳妥是先做「独立编辑器面板骨架 + 手动打开一个固定文件」验证 Monaco + worker 链路，再接入真实 openFile。

### Phase 2（2A，IDE 面板）——记录为进阶方案

dsh UI 已是**三栏布局**（`sidebar + center + details`），且 `conversation.view` 是一个 slot（`kind: 'list', scope: 'session'`），注册进去的每个 view 就是一个 tab（chat、trajectory 等）。

**2A 方案**：注册一个新的 `conversation.view` 条目（id 如 `code-editor`），挂 Monaco 编辑器面板：

- 参照 `ui-trajectory` 的注册模式（`ctx.slots.inject('conversation.view', () => ctx.slots.register({...}, TrajectoryView))`）。
- view 的 `inject(sessionId)` 返回编辑器所需的 hooks（打开的文件、tab 列表、workspace 根）。
- 面板内：文件树（复用 `ui-workspace` + 已修好的 native directory-picker）+ 多 tab + Monaco 编辑器区。

但注意：**Phase 2 的编辑器 view 是否还属于 corum-desktop，还是拆成独立 dsh 客户端插件？**

- 若编辑器完全在壳内：注册 `conversation.view` 需要在 client half 的 `apply` 里做（壳的 client 也是 dsh 客户端插件，能 `ctx.slots.inject`）。
- 若拆独立插件：更符合「审批/diff 用额外小插件」的决策，但 Monaco 本体仍在壳，插件只做 view 骨架 + 桥接。

> 留待 Phase 2 实现时定；倾向：Monaco 组件库在 shell，view 注册 + 审批/diff 桥接拆一个薄插件 `corum-editor-view`。

## 审批 / diff / 保存桥接（辅助小插件）

编辑能力需要接 dsh 语义栈，但**不塞进 shell**：

1. **读文件**：走 host 的 `ctx.fs`（经已有 unary / host.readFile 或新增轻量 unary）。
2. **保存**：Monaco `onDidChangeModelContent` → 收集 diff → 复用官方 `DiffBlock` 预览 → 审批流 → 调 `ctx.fs` 的 `edit`/`write` 语义写回。
3. **write-policy**：满足 dsh 的 read-before-write observation policy。

这条链路由一个薄插件暴露（slot 或 service），shell 的编辑器只调接口，不感知审批细节。

## 风险与待验证项

1. **worker 在 `corumapp://` 协议下的 `new Worker()` 是否被 Electron 允许**：`corumapp` 已注册为 `standard + secure + supportFetchAPI`，worker 从同协议加载应可行，但需实测。
2. **monaco 0.56 的 ESM 体积**：全量 + TS worker 较大，Phase 1 先接受；后续可按语言懒加载 worker。
3. **tsdown/rolldown 对 monaco ESM 的 external 处理**：worker 文件必须 external，否则打包失败。
4. **CSP**：Electron 渲染进程若设了 CSP，需确认 worker 脚本源被放行（当前 desktop 未显式设 CSP，风险低）。

## 已实现的进展（Phase 1，2A 骨架）

- ✅ `monaco-editor@0.56.0` 已加入 corum-desktop 依赖；`@tsdown/css` 处理 monaco 的 CSS。
- ✅ `src/client/editor/MonacoEditor.tsx`：React 封装，从 `monaco-editor/editor/editor.api`（exports `./*` 子路径）内联，语言 contribution 用副作用导入（typescript/json/css/html）。
- ✅ `src/client/editor/CodeEditorView.tsx`：`conversation.view` slot 的 view 骨架，Phase 1 显示 demo 文件。
- ✅ `src/client/index.ts`：`inject` 加 `slots`，`apply` 里 `ctx.slots.inject('conversation.view', ...)` 注册 `code-editor` tab。
- ✅ `src/client/editor/monaco-modules.d.ts`：声明 monaco 的 `./*` 子路径类型。
- ✅ 构建通过：monaco 内联为 chunk（`editor.api-*.cjs` 5.2MB、`workers-*.cjs` 2.3MB、各 language mode chunk）。

## ⚠️ 未解决：worker 运行时加载（下一步关键障碍）

**问题**：monaco 0.56 的 ESM worker 入口（`editor.worker.js`、`ts.worker.js` 等）是含 `import` 的 ESM 模块，**不是独立可运行的 classic worker 脚本**，必须经 bundler 处理才能被 `new Worker()` 加载。

当前 `worker.ts` 的 `MonacoEnvironment.getWorker` 返回 `new Worker('corumapp://app/monaco/<name>.worker.js')`，但这些 `.worker.js` 若直接复制到 dist，是未 bundle 的 ESM，无法作为 classic worker 运行。

**已按路径 2 解决**：

- `tsdown.config.ts` 新增 5 个 worker entry（`editor/typescript/json/css/html`），用 `format: ['iife']` + `platform: 'browser'` 打成独立 classic 脚本，输出 `lib/workers/<name>.worker.js`（editor 599KB / ts 11.6MB / json 882KB / css 1.74MB / html 1.24MB）。
- `worker.ts` 的 `getWorker` 按 label 分发到 `corumapp://app/monaco/<name>.worker.js`（含 javascript→ts、scss/less→css、handlebars/razor→html 别名）。
- `protocol.ts` 的 `corumapp` handler 新增 `/monaco/` 前缀：从 `monacoWorkersDir`（shell 的 `lib/workers`）读 worker，dev 和 packaged 都锚定到 shell 自身产物。
- `main.ts` 的 `monacoWorkersPath()` 传入该目录。
- `pack-macos.mjs` 打包时把 `lib/workers` 复制进 `build/dist/monaco`（packaged 布局）。

## Monaco CSS 内联

monaco 的 ESM 代码 import 大量 `.css`（theme tokens、codicon、editor 布局），tsdown 的 `@tsdown/css` 提取成 `lib/style.css`（178KB）。shell client 是 CJS（`window.__ModuleLoader__.load` 包裹），无法 `import` CSS。**解法**：构建后脚本 `scripts/inline-monaco-css.mjs` 把 `style.css` 内容作为 `<style data-corum-monaco>` 注入 `client.js` 头部，并删除 CSS 文件。`bundle` 脚本已串联该步骤。

## 待实测（下一步）

- `new Worker('corumapp://app/monaco/*.worker.js')` 在 Electron `corumapp` 自定义协议下是否真能加载 worker（需 renderer console 确认）。
- code-editor tab 是否出现在会话视图环，点击后 Monaco 是否渲染 demo 文件 + 语法高亮。

## 阶段验收

- **Phase 1**：桌面壳内 Monaco 只读打开一个文件，语法高亮（TS/JSON）、行号、折叠、搜索可用，worker 无报错。
- **Phase 2**：`conversation.view` 出现「代码编辑器」tab，多文件 + 文件树 + 编辑 + diff 预览 + 审批写回全链路。
