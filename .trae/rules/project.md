# kkc-desktop 项目规则（每次对话必加载）

## 项目定位

kkc-desktop（corum）是基于 DeepSeek Harness（dsh）fork 的桌面 IDE。壳层（shell）+ 插件（plugins）架构，大量 UI/能力是从官方 dsh 包 fork 后定制的（包名前缀 `@corum/*`），通过 `cordis.patch.yml` / `cordis.ide.patch.yml` 以 patch 层叠加替换官方实现。

## 参考源码地址

- **官方 dsh 源码（本地参考）**：`/Users/kukucai/dsh`
  - 这是 corum fork 的上游官方实现。遇到「参考官方实现」「对照官方逻辑」时，到该目录查找对应包的源码（`packages/` 下按领域分目录：client / host / llm / interaction / api / boot / bundle 等）。
  - 注意：本机 `node_modules` 里没有官方 `dsh-client-*` 的实体包，**官方源码以 `/Users/kukucai/dsh` 为准**，不要在本仓库 node_modules 里找。
- 用户记忆中的路径是 `/Users/kkc/dsh`，实际路径为 `/Users/kukucai/dsh`（注意是 `kukucai`，不是 `kkc`）。

## 关键架构事实

- **桌面 home**：`~/.corum`（`CORUM_HOME` 可覆盖），插件启停持久化在 `~/.corum/plugins.disabled.json`。旧版 `~/.corum-shell` 启动时自动迁移到 `~/.corum`。
- **插件中心**：`packages/desktop/src/host/plugin-manager.ts` 提供 list/setEnabled/install/uninstall；`@corum/*` 默认归类为可启停的 plugin，运行时基元归 runtime（只读）。
- **基础能力不可关闭**：`plugin-manager.ts` 中 `CORE_PLUGIN_PACKAGES` / `CORE_PLUGIN_ENTRIES` 白名单内的插件（当前：`@corum/corum-ui-model-selection`）不可停用/卸载，boot 时会过滤其禁用残留。
- **模块加载**：fork 插件的浏览器半端是「闭包工厂」bundle，经 `window.__ModuleLoader__.load({id, factory})` 注册，`dsh.client` 声明的包才进 `__DSH_BOOT__` 图。**改完插件源码必须 `pnpm build` 并重启桌面应用**才生效（bundle rev 以内容 hash 为缓存键）。
- **浮层**：composer 卡片有 `backdrop-filter`，会建立 `position:fixed` 的新包含块。需要真正飞出卡片的浮层用 `createPortal(..., document.body)`；仓库通用浮层出口是 `packages/plugins/ui/corum-ui-base/src/client/FloatingLayer.tsx`。

## 适配官方 dsh 基座升级的原则（重要）

corum 是「发行版」，**跟随官方架构、只叠加差异化**，绝不与官方架构对着干。

- **以官方最新基座为基线重新 fork**：当官方 dsh 有破坏性变更（如 0.1.1-rc.2 把 React 绑定内化、删除 seed 词、纯函数内化成 Cordis 服务），corum 的对应 `@corum/*` 插件应该**以官方对应包的最新源码为基线逐行重新 fork**，再叠加 corum 的差异化改动（如 image-input 开关），而不是在旧版代码上打最小补丁。
- **禁止「简化思路」规避官方架构**：例如用「本地 fork 纯函数」替代官方新引入的 `ctx.settingsSchema` / `ctx.settingsScope` Cordis 服务。corum 的闭包工厂 bundle 能走服务注入（提供服务的包已在 graph 里），规避是错的。**要注重实现质量，而非最小改动量；哪怕重写。**
- **官方对齐的验证标准**：`diff -rq 官方包/src corum包/src`，最终应该**只剩 corum 真正差异化的文件**（如 `ModelListEditor.tsx`、`locales.ts`）有差异，其余文件与官方逐行一致。
- **官方源码为准**：遇到「参考官方实现」到 `/Users/kukucai/dsh` 找对应包源码，对照官方逻辑适配，不要臆造。

## 构建与验证

- 插件构建：`pnpm --filter <pkg> build`（`tsc -b && tsdown && node scripts/inline-css.mjs`）。
- 桌面模式：`minimal`（默认）/ `ide`（`CORUM_DESKTOP_MODE=ide`，挂载 IDE 覆盖层）/ `dev-agent`（`CORUM_DESKTOP_MODE=dev-agent`，挂载 corum-agent-ui-dev 覆盖层）。启动日志看 `[corum-desktop] desktop mode: ...`。

## 依赖与编译（关键约束）

- **依赖全走 registry**：官方 `dsh-*` 包锁定 registry 版本（当前 `0.1.1-rc.2`），**不依赖 `/Users/kukucai/dsh` checkout 的产物**（checkout 只作源码参照）。cordis 系列用独立稳定版（`cordis@^4.0.1` 等）。
- **client UI 包必须显式声明为 dependencies**：官方 `dsh-client-ui-*` 包在 registry 里不被 `dependencies` 引用、只被 `cordis.patch.yml` 的 insert 行引用，registry 时代必须显式声明进 `packages/desktop/package.json`，否则 boot 图缺包。
- **改依赖后必须重跑 install**：改 `package.json` 依赖或改 `workspace:*` 包名/目录后，立即 `CI=true pnpm install --no-frozen-lockfile`，并检查 `node_modules/<scope>/` 旧 symlink 是否清干净（否则 loader 解析失败无法启动）。
- **tsconfig.base.json 必须含** `"allowImportingTsExtensions": true` + `"rewriteRelativeImportExtensions": true`（源码用 `.ts` 扩展名相对导入）。改 tsconfig 后若「类型检查过但 bundle 失败」，先 `rm -rf packages/desktop/lib` 再 build（tsc 增量缓存不重发旧产物）。
- **原生模块**：`pnpm-workspace.yaml` 的 `allowBuilds` 批准 `node-pty`/`koffi`/`protobufjs`/`dsh-subprocess-local`/`@google/genai`。

## 调试与运行

**遇到问题加日志快速定位，不要深度推理。** 桌面是三层进程，每层改动生效成本不同（会话历史持久化在 `$CORUM_HOME/sessions/`，重启不丢上下文）：

| 改动层 | 代码位置 | 生效方式 |
|---|---|---|
| 渲染端 UI | `src/client/**`、插件 `*/client` | 重建 `lib/client.js` → HMR 热替换 |
| 宿主端 | `src/host/**`、`cordis.patch.yml` | `window.corumDesktop.restartHost()` 热重启子进程 |
| Electron 主进程 | `src/electron/**` | 重启 App |

- **启动脚本**：`packages/desktop/scripts/dev.sh`（唯一启动器：默认纯壳 combo 启动器；`--combo=coding` 直接进 IDE）。**停实例只 `pkill -f "node lib/cli.js"`，不要 `pkill -f corumapp`**（误伤渲染/helper 进程致窗口卡死）。
- **HMR 分级**：core provider（wire root、`dsh-client-modules`）走页面刷新；叶子 UI 插件走零刷新纤维热替换。**改 AppFrame/GridView 等根结构后 HMR 热替换不干净，必须重启实例再判 bug**（否则「点击没作用/菜单一闪即关」多为旧 bundle 假象）。
- **CDP 走查**：`CORUM_DEBUG_PORT=9222 bash packages/desktop/scripts/dev.sh --combo=coding`，ws 连 9222 用 `Runtime.evaluate`。9222 被占报 `Cannot start http server for devtools` → `lsof -ti:9222 | xargs kill -9`。参考 `packages/desktop/scripts/e2e-grid.mjs`。
- **验证宿主 API 最快方式**：bridge stdio 直发 unary（`{type:'unary', id, pathname:'/api/...', body:{...client-request信封...}}`），看 host 确切报错。
- **环境变量前缀是 `CORUM_HOME`**（不是 `KKC_HOME`）；用错会落到默认 `~/.corum`（workspace 外可能 EPERM）。
- **MCP `serverName` 必须进程内唯一**：`dsh-mcp-client` 对 serverName 做 per-app 全局保留，撞名导致 preset 挂载失败并静默回退默认 preset。不同 preset 配同一 MCP 服务器时须用不同 serverName。
- **渲染进程调试**：Electron 43 的 `console-message` 是新签名 `(details, level, ...)`，`details.message` 才是文本。
- **CDP 断言注意**：输入框占位文本用 `querySelectorAll('input').map(i => i.placeholder)`（`document.body.innerText` 不含 placeholder）；主题断言直接操作 `body[data-ds-dark-theme]` 属性（token 翻转的实际驱动）；窗口缩放用 `Emulation.setDeviceMetricsOverride`（Electron 43 删了 `Browser.setWindowBounds`）。
- **GridView 布局残留**：布局持久化在 `localStorage['corum.ide.grid.v1']`，旧布局会覆盖默认。验证布局前先 `localStorage.removeItem('corum.ide.grid.v1')` 或调 `resetGridStorage()`。
- **图片进 bundle**：brand_logo/背景图等静态 PNG 复制到 `packages/desktop/assets/`，走 `corumapp://` 协议的 `/assets/` 路由（`protocol.ts`）；CSS/TSX 用 `corumapp://app/assets/<name>.png` 引用。注意 assets 路由**必须只匹配图片扩展名**，匹配整个 `/assets/*` 会 404 掉 dist 前端 JS 导致整页白屏；打包时 `package.json` 的 `build.extraResources` 需加 `{ "from": "assets", "to": "assets" }`（否则 packaged 图片 404）。
- **Monaco 集成**：用 `monaco-editor/editor/editor.api` 子路径入口（不要主入口，会内联全语言+CSS）；tsdown 必须 `inlineDynamicImports: true`（`__ModuleLoader__` 只加载单 bundle）；worker 须 bundle 成 iife classic 脚本走 `corumapp://app/monaco/`；Monaco CSS 用 `scripts/inline-monaco-css.mjs` 注入 `<style>`；corum-desktop client 是 `inject: []` 的 wire root，注册 view 必须 `ctx.inject(['slots'], ...)` 延迟（顶层 `inject: ['slots']` 会死锁）。

## 桌面壳与官方 web UI 的差异排查模式

桌面壳跳过官方 CLI 的 `composeProfile`，且 overlay 会禁用一批官方「传输行」和「-auto 型动态装配插件」。排查「功能缺失」时优先看：

1. **Typert Remote 端点**（`pluginInventory/*`、`commands/*`、`goals/*` 等）走 `connection.rpc.intercept('/api')`，`connection` 服务没正确提供就全 404。
2. **-auto 型插件**（如 `directory-picker-auto`）动态创建「host 后端 + client 表面」成对 entry，禁用时必须成对补。
3. **preset 依赖包**：preset 的 `agent.cordis.yml` 引用的包（如 `dsh-persona`、`dsh-tool-ask-user`）必须在 host 闭包里可解析，否则 `session.create` 挂载 preset 失败。
4. **官方「浏览器式」插件与桌面 IPC 冲突**：如 `dsh-session-log-export` 走流式 GET + `a[download]`，桌面 IPC 只支持 POST unary，需用原生对话框替代并禁用官方行。

## 打包方案

- `packages/desktop/scripts/pack-macos.mjs` 用 `pnpm deploy --legacy --prod --config.node-linker=hoisted ...` 从 `packages/desktop/desktop-host`（dependency-only deploy 根，全 registry）物化 host 闭包，**不抄 dsh checkout**。
- **`--config.node-linker=hoisted` 是正确性核心**：让整个闭包（含 peer 依赖）平铺到顶层 `node_modules`（真实目录），这是 `healProfilesModuleFallback` BFS 解析 profile 裸插件名所需的布局。
- host manifest 由 `writeHostManifest()` 现场生成（无静态文件，消除漂移）。DMG 构建需 `hdiutil` + `danger-full-access`。

## 调试规则

**遇到问题加日志快速定位，不要深度推理。**

- 发现异常行为时，第一时间在关键路径加 `process.stderr.write` 日志（host 端）或 `console.log`（client 端），构建后重启验证。
- 不要在静态代码分析上花太多时间——RPC 调用链、文件系统操作、环境变量等运行时行为必须通过日志确认。
- 日志格式：`[corum-agent] <function> — <key>=<value>`，方便 grep 过滤。
- 确认问题后立即删除调试日志，不要留在代码里。

## Git 提交规范（可回溯）

**每次修改都要提交 git，做到可回溯。**

- 完成一个逻辑改动后立即提交，不要把多个不相关改动堆在一个提交里。
- commit message 用中文，遵循「类型: 简述」格式，说明"为什么"而非仅"是什么"，例如：
  - `fix: 修复模型选择器 hover 二级菜单被 backdrop-filter 包含块裁切`
  - `feat: 收录模型选择器为 corum 基础能力不可关闭`
- 不提交构建产物（`lib/`、`dist/`、`.tsbuildinfo` 等），除非该仓库本就跟踪它们。
- 提交前确认不混入 `.env`、凭证等敏感文件。
- 未经用户明确要求，不执行 `git push`、不 force push、不改 git config。

## fork 官方 client 插件的要点（已沉淀的模式）

fork 官方 presentation 层包（`dsh-client-ui-*`）到 `packages/plugins/`，改完在 `cordis.patch.yml` disable 官方行 + insert fork 行。要点：

1. **复用现有 fork 包的构建模板**（如 `corum-session-archive`）：tsconfig（extends 根 base + jsx + DOM lib）、tsdown（CLIENT_EXTERNALS 白名单 + `window.__ModuleLoader__.load` 闭包）、`scripts/inline-css.mjs`。
2. **`@deepseek-ai/cordis` 用 registry `^4.0.1`**（所有包同一 registry 版，避免跨包 Context merge 到不同物理实例导致 `TS2339`/`TS2353`）。
3. **`noImplicitAny: false`**：registry `.d.ts` 泛型链路比官方源码粗，会在官方源码不报错处暴露 implicit any。
4. **删掉官方 `src/invariant.ts`**（invariant companion，no-op）。
5. **定制块用 `// CORUM-PATCH:` 注释围住**，官方升级时 `diff -rq` 对比官方与 fork，只合并官方改动、保留 CORUM-PATCH 块。
6. **验证**：`pnpm --filter @corum/<name> build` 后，跑 bridge 探针看 `graph.entries` 里 fork 行存在、官方行禁用、`clientPath` 指向 fork 的 `lib/client.js`。

---

## 基于 dsh 开发 corum 插件快速指导

以下是从现有 corum-agent-dev / corum-agent-ui-dev / corum-skill-manager-dev / corum-skill-manager-ui-dev 插件中提炼的开发模式。新建插件时按这些模式复制即可，不需要每次重新查代码。命名规则：正式 UI 插件加 `-ui` 后缀、开发中插件加 `-dev` 后缀、不出现 shell。

### 插件包目录结构

```
packages/plugins/
  agent/              ← host 侧插件（无浏览器半）
    corum-agent-dev/
      package.json
      tsconfig.json
      tsdown.config.ts
      src/
        index.ts          ← Cordis 插件入口（name + inject + apply）
        agent-service.ts  ← TypertRemoteService（暴露 /api RPC）
        profile.ts        ← 数据模型
        profile-store.ts  ← 文件系统持久化
        compile.ts        ← 编译逻辑
  ui/                 ← UI 插件（有浏览器半）
    corum-agent-ui-dev/
      package.json
      tsconfig.json
      tsdown.config.ts
      scripts/inline-css.mjs
      src/
        index.ts              ← host 半（no-op）
        client/
          index.tsx           ← client 半入口（slot 注册）
          AgentTestPanel.tsx  ← React 组件
          *.module.css        ← CSS Modules
          css-modules.d.ts    ← CSS Modules 类型声明
```

### 1. package.json 模板

**host 侧**（无浏览器半）：
```jsonc
{
  "name": "@corum/corum-xxx-dev",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "tsc -b && tsdown",
    "typecheck": "tsc -b --pretty false"
  },
  "dependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-typert-protocol": "^0.1.1-rc.2",
    "@deepseek-ai/dsh-home-paths": "^0.1.1-rc.2"
    // ... 按需添加 dsh-* 依赖
  },
  "devDependencies": {
    "@types/node": "^22.20.0",
    "tsdown": "^0.22.2",
    "typescript": "^6.0.3"
  }
}
```

**UI 侧**（有浏览器半，需声明 `dsh.client`）：
```jsonc
{
  "name": "@corum/corum-xxx-ui-dev",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./src/client/index.tsx", "default": "./src/client/index.tsx" },
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "tsc -b && tsdown && node scripts/inline-css.mjs",
    "typecheck": "tsc -b --pretty false"
  },
  "dependencies": {
    "@corum/corum-ui-base": "workspace:^",
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-client-runtime": "^0.1.1-rc.2",
    "@deepseek-ai/dsh-client-ui-slots": "^0.1.1-rc.2",
    "@deepseek-ai/dsh-client-ui-theme": "^0.1.1-rc.2",
    "@deepseek-ai/dsh-client-locale": "^0.1.1-rc.2",
    "lucide-react": "^0.460.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "peerDependencies": { "react": "^18.2.0" },
  "devDependencies": {
    "@tsdown/css": "^0.22.14",
    "@types/node": "^22.20.0",
    "@types/react": "~18.3.31",
    "@types/react-dom": "^18.3.7",
    "tsdown": "^0.22.2",
    "typescript": "^6.0.3"
  },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-locale"],
      "immediately": false
    }
  }
}
```

**关键字段说明**：
- `dsh.client.platform: "web"` — 让模块注册表把此包加入浏览器 boot 图
- `dsh.client.inject` — 依赖的其他 client 包（必须先于本包加载）
- `dsh.client.immediately: false` — 按需加载（fiber 图），非 HTML 解析时立即加载
- `exports["./client"]` — `default` 指向 `./src/client/index.tsx`（源码），让其他 UI 插件可以 import 组件；构建后 `./lib/client.js` 是闭包工厂 bundle

### 2. tsconfig.json 模板

```jsonc
// host 侧
{
  "extends": "../../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types",
    "lib": ["ES2024"],
    "types": ["node"]
  },
  "include": ["src"]
}

// UI 侧（多 jsx + DOM）
{
  "extends": "../../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types",
    "jsx": "react-jsx",
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "noImplicitAny": false,
    "types": []
  },
  "include": ["src"]
}
```

### 3. tsdown.config.ts 模板

**host 侧**（单 Node ESM entry）：
```ts
import { defineConfig } from 'tsdown'
export default defineConfig(() => [{
  name: '@corum/corum-xxx-dev',
  entry: ['lib/types/index.js'],
  outDir: 'lib', format: ['esm'], platform: 'node',
  target: 'es2024', fixedExtension: false, dts: false, clean: false,
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-typert-protocol',
    '@deepseek-ai/dsh-home-paths',
    // ... 所有 @deepseek-ai/* 运行时依赖
  ],
}])
```

**UI 侧**（双 entry：Node 库 + 浏览器闭包工厂 bundle）：
```ts
import { defineConfig } from 'tsdown'

const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-theme/client',
]

const CLIENT_ID = '@corum/corum-xxx-ui-dev'

export default defineConfig(() => [
  // 1. Node 库（tsc 产出的 ESM）
  {
    name: CLIENT_ID, entry: ['lib/types/index.js'], outDir: 'lib',
    format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, dts: false, clean: false,
  },
  // 2. 浏览器闭包工厂 bundle
  {
    name: `${CLIENT_ID}/client`, entry: { client: 'src/client/index.tsx' },
    outDir: 'lib', format: ['cjs'], platform: 'browser',
    dts: false, sourcemap: true, clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    css: { splitting: false },
    outputOptions: {
      entryFileNames: 'client.js',
      inlineDynamicImports: true,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
```

**关键**：
- `CLIENT_EXTERNALS` — 这些包不打包，运行时经 `window.__ModuleLoader__` 模块表解析
- `noExternal` — 非 external 的全部内联打包（含 `@corum/corum-ui-base`、lucide-react 等）
- `banner/footer/intro` — 闭包工厂三件套，让 bundle 注册到 `window.__ModuleLoader__`
- `scripts/inline-css.mjs` — 构建后把 CSS 内联到 client.js（桌面 loader 不服务 CSS 文件）

### 4. Host 侧入口模式（src/index.ts）

```ts
import type { Context } from '@deepseek-ai/cordis'
import { MyService } from './my-service.ts'

export const name = 'dev-xxx'
export const inject = ['agents', 'agentPresets', 'sessions']  // 依赖的 Cordis 服务
export function apply(ctx: Context): void {
  new MyService(ctx)  // 构造即注册（TypertRemoteService 的 super(ctx, name) 完成注册）
}
```

### 5. TypertRemoteService 模式（暴露 RPC 端点）

```ts
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'

// Context 增强：让其他插件可通过 ctx.myService 访问
declare module '@deepseek-ai/cordis' {
  interface Context {
    myService: MyService
  }
}

export class MyService extends TypertRemoteService {
  static inject = ['agents', 'sessions']  // 镜像插件的 inject

  constructor(ctx: Context) {
    super(ctx, 'myService')  // → /api/myService/* 路由前缀
  }

  @Remote('listItems')
  listItems(): { items: Item[] } { ... }

  @Remote('createItem')
  async createItem(name: string): Promise<{ ok: boolean }> { ... }
}
```

**关键**：
- `super(ctx, 'myService')` — 服务名 = URL 路由前缀（`/api/myService/*`）
- `@Remote('methodName')` — 标记方法为 RPC 端点
- `declare module` — Context 类型增强

### 6. Client 侧入口模式（src/client/index.tsx）

```tsx
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ThemePresenter } from '@corum/corum-ui-base/client'
import { MyComponent } from './MyComponent.tsx'

export const inject = ['slots', 'theme']

export function apply(ctx: ClientContext): void {
  // 主题投影
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (s) => { presenter.apply(s) })
    return () => { off(); presenter.dispose() }
  }, 'xxx: theme presenter')

  // root 槽注册（占满整个窗口）
  ctx.effect(() => {
    const dispose = ctx.slots.register({
      name: 'root', children: {}, inject: () => ({}),
    }, MyComponent)
    return () => { dispose() }
  }, 'xxx: root registration')
}
```

### 7. 桌面 IPC RPC 桥模式（浏览器调 host）

```ts
type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

async function callRemote<T>(
  service: string, method: string, args: Record<string, unknown>
): Promise<T> {
  const bridge = (window as unknown as {
    corumDesktop?: { unary?: (pathname: string, body?: string) => Promise<{ status: number; body: string }> }
  }).corumDesktop
  if (bridge?.unary === undefined) throw new Error('desktop bridge unavailable')
  const rpcId = crypto.randomUUID()
  const message = { type: 'client-request', rpcId, method: `${service}/${method}`, payload: { args } }
  const { status, body } = await bridge.unary(`/api/${service}/${method}`, JSON.stringify(message))
  if (status !== 200) throw new Error(`${service}/${method}: HTTP ${status}`)
  const envelope = JSON.parse(body) as { type: string; rpcId: string; result: RpcResult<T> }
  if (envelope.rpcId !== rpcId) throw new Error(`rpcId mismatch`)
  if (!envelope.result.ok) throw new Error(`${envelope.result.error.code}: ${envelope.result.error.message}`)
  return envelope.result.value
}

// 调用示例
const { profiles } = await callRemote<{ profiles: Profile[] }>('corumAgent', 'listProfiles', {})
const result = await callRemote<ImportResult>('skillManager', 'importFromFile', { skillName, sourcePath })
```

### 8. Combo 注册模式

在 `packages/desktop/src/electron/combos.ts` 的 `BUILTIN_COMBOS` 中添加：

```ts
{
  id: 'dev-xxx',
  name: 'XXX 开发',
  description: 'XXX 描述',
  agentPreset: 'standard',
  plugins: ['@corum/corum-xxx-dev', '@corum/corum-xxx-ui-dev'],  // combo 加载的插件包
  env: { CORUM_DESKTOP_MODE: 'dev-xxx' },                // 注入的环境变量
  cwd: '', patches: [],
  icon: { type: 'lucide', value: 'bot' },
  createdAt: now, lastUsedAt: now, builtin: true,
}
```

同时在 `packages/desktop/package.json` 的 `dependencies` 中添加 `"@corum/corum-xxx-dev": "workspace:*"` 和 `"@corum/corum-xxx-ui-dev": "workspace:*"`。

### 9. 桌面模式 + Patch Overlay 模式

**1. 在 `boot.ts` 的 `resolveDesktopMode()` 添加新模式**：
```ts
export function resolveDesktopMode(): DesktopMode {
  const value = process.env[DESKTOP_MODE_ENV]
  if (value === 'ide') return 'ide'
  if (value === 'dev-xxx') return 'dev-xxx'  // ← 新增
  return 'minimal'
}
export type DesktopMode = 'minimal' | 'ide' | 'dev-xxx'  // ← 更新类型
```

**2. 在 `boot.ts` 添加 patch 文件常量**：
```ts
const DEV_XXX_PATCH = fileURLToPath(new URL('../cordis.dev-xxx.patch.yml', import.meta.url))
```

**3. 在 `boot.ts` 的 overlay 加载逻辑添加新模式**：
```ts
const modeOverlays =
  mode === 'ide' ? loadOverlayPatches(NAME, IDE_PATCH) :
  mode === 'dev-xxx' ? loadOverlayPatches(NAME, DEV_XXX_PATCH) :
  []
```

**4. 创建 patch 文件 `packages/desktop/cordis.dev-xxx.patch.yml`**：
```yaml
# 禁用官方 presentation 行
- id: ui-layout
  disabled: true
- id: ui-sidebar
  disabled: true
- id: ui-workspace
  disabled: true
- id: ui-conversation
  disabled: true
- id: ui-settings-general
  disabled: true

# 插入 corum 插件行
- insert:
    - id: dev-xxx-shell
      name: '@corum/corum-xxx-ui-dev'
```

**5. 在 `packages/desktop/package.json` 的 `exports` 和 `files` 中添加 patch 文件**：
```jsonc
"exports": {
  "./cordis.dev-xxx.patch.yml": "./cordis.dev-xxx.patch.yml",
  // ...
},
"files": ["lib", "cordis.patch.yml", "cordis.ide.patch.yml", "cordis.dev-xxx.patch.yml"]
```

### 10. Skill 管理架构

- **全局 skill 目录**：`~/.corum/skills/`（即 `$DSH_HOME/skills/`，桌面 home 已统一为 `~/.corum`），每个 skill 是含 `SKILL.md` 的子目录
- **SKILL.md 格式**：YAML frontmatter（`name` + `description` 必填）+ markdown body
- **Git 版本控制**：每个 skill 目录推荐 git init，修改后 commit
- **Agent 绑定**：`agent.json` 的 `skills` 字段记录 `SkillBinding[] {name, commitHash}`，Agent mount 前 checkout 到 pinned commit
- **导入方式**：文件路径导入（复制 + 格式校验 + git init）或文本粘贴导入（校验 + 写入 + git init）
- **管理服务**：`@corum/corum-skill-manager-dev`（host RPC）+ `@corum/corum-skill-manager-ui-dev`（独立 UI 组件，可复用到 IDE）

### 11. AgentProfile + Agent 目录架构

- **存储路径**：`~/.corum/.agent-presets/<id>/`
- **目录结构**：
  ```
  agent.json          ← AgentProfile 描述文件
  agent.cordis.yml     ← 编译后的 Cordis 组合
  preset.yml           ← preset 元数据
  ```
- **AgentProfile 字段**：`id` / `prompt` / `model` / `skills: SkillBinding[]` / `mcpServers` / `terminal` / `memoryPolicy` / `version` / `trust`
- **编译流程**：`compilePreset(profile)` → `agent.cordis.yml`（persona + skill-filesystem + tool-skill + terminal + filesystem + MCP 行）+ `preset.yml`
- **persona 行必须用标准模式**：**禁止**设 `complete: true` 和 `includeRuntimeContext: false`。这两个会让 persona 独占 system prompt、压制框架的其他 section（`harness:identity`、工具引导、runtime context 等）。必须让框架正常组装完整提示词，与官方 headless bundle 一致。persona 只是其中一个 section，不是全部。
- **skill-filesystem 必须 `includeDefaultRoots: false`**：只用 `customSkillDirs` 指向 Agent 绑定的 skill 目录，避免 Agent 看到全局所有 skill。
- **Agent 创建**：`ctx.agents.create({ sessionId, meta, agentOptions, setup })` → setup 里 `ctx.agentPresets.mount(agentCtx, profile.id)` + `installModelSelection(agentCtx, selection)`
- **兼容旧路径**：`~/.corum/agent-profiles/<id>.json` 自动迁移到 `agent.json`

### 12. 现有 dev-agent combo 插件清单

| 包名 | 类型 | 作用 |
|---|---|---|
| `@corum/corum-agent-dev` | host | CorumAgentService：AgentProfile 管理 + preset 编译 + Agent 创建 + RPC |
| `@corum/corum-agent-ui-dev` | UI | AgentTestPanel：Profile 编辑器 + 对话 + 日志 + 嵌入 Skill 管理 |
| `@corum/corum-skill-manager-dev` | host | SkillManagerService：skill 导入/删除/版本控制 + RPC |
| `@corum/corum-skill-manager-ui-dev` | UI | SkillManagerPanel：独立 skill 管理组件（可复用到 IDE） |
| `@corum/corum-mcp-manager-dev` | host | McpManagerService：MCP 服务全局注册表 + 连接探测 + 引用查询 + RPC |

### 13. 开发工作流

1. `pnpm install` — 安装/更新依赖
2. `pnpm --filter @corum/corum-xxx-dev build` — 构建 host 插件
3. `pnpm --filter @corum/corum-xxx-ui-dev build` — 构建 UI 插件（含 CSS 内联）
4. `pnpm --filter corum-desktop build` — 重建桌面壳（更新模块图的 bundle rev hash）
5. 启动桌面应用，选择对应 combo 验证（或 `./scripts/combo.sh dev-agent` 一条命令构建+启动）
6. 或直接 `cd packages/desktop && CORUM_COMBO_PLUGINS='...' CORUM_DESKTOP_MODE=... node lib/bridge.js` 启动 host（不经过 Electron，stderr 看日志）
7. 修改源码后重复 2-6
