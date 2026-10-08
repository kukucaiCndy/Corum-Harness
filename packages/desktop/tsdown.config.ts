/**
 * corum-desktop build: standalone tsdown config (not part of the repo root
 * workspace build). Node entries run in the Electron main/host processes; the
 * client bundle is the browser half carrying the desktop framework surfaces
 * (notifications + the resident editor column) — the transport is the official
 * web stack, so there is no connection glue here. The closure-factory format
 * mirrors the official client plugin bundles: the bundle calls
 * window.__ModuleLoader__.load and resolves externals through the loader table.
 */
import { defineConfig } from 'tsdown'
import type { UserConfig } from 'tsdown'

/** Platform modules the loader table answers: kept external in the browser bundle. */
const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** Wire/type layers a client bundle may inline (no shared runtime identity). */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(session|llm|tools|brand)(\/|$)/

const CLIENT_ID = 'corum-desktop'

/**
 * 打包期平台注入（P0）：`CORUM_TARGET_PLATFORM` 由 pack 脚本（scripts/pack.mjs
 * 包装器，四步打包链的第 1 步 build 也走它）显式钉死，这里把它烘成编译期常量
 * `__CORUM_TARGET_PLATFORM__`（字符串字面量 ⇒ tsdown 做死代码消除，方案 §4.2
 * 已实测成立）。
 *
 * ⚠️ 纪律（方案 §2.1）：**显式传入，绝不回落构建机的 process.platform** ——
 * 回落会让「常量烘 darwin / fetch-node 取 mac Node / electron-builder 出 linux」
 * 三者口径分裂，制造内部混装的静默缺陷（真实踩过）。
 * **用途受限**（方案 §7.1）：该常量只用于①运行时一致性断言②host 侧编译期
 * 特化瘦身③诊断——行为决策只跟随 process.platform（getPlatform()）。
 */
const CORUM_TARGET_PLATFORM = process.env.CORUM_TARGET_PLATFORM

/** 需要烘入平台常量的 node 侧 entry（Electron 壳三件套 + 断言所在的 main）。 */
const PLATFORM_DEFINE: Record<string, string> | undefined = CORUM_TARGET_PLATFORM === undefined
  ? undefined
  : { __CORUM_TARGET_PLATFORM__: JSON.stringify(CORUM_TARGET_PLATFORM) }

const nodeEntry = (name: string, options: Partial<UserConfig> = {}): UserConfig => ({
  name: `${CLIENT_ID}/${name}`,
  entry: [`lib/types/${name}.js`],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // `electron` is a devDependency, so tsdown's auto-externalization (which
  // keys on `dependencies`) would inline it — but electron/index.js uses
  // __dirname and must stay an external import resolved at runtime. `koffi`
  // ships a native .node binding loaded by its own JS bootstrap — inlining it
  // breaks the binding path, so it stays external too (resolved from
  // node_modules at runtime).
  external: ['electron', 'koffi'],
  // 打包期烘入目标平台常量（dev 态未设置 = 不烘，运行时 typeof 守卫兜住）。
  // 仅 Electron 壳（main/preload/cli）读它；host/bridge 与 bridge-client 是
  // 平台无关构建（同一份 host 闭包被三平台产物复用），不烘 —— 它们的
  // getBakedTargetPlatform() 改读 main 透传的 CORUM_TARGET_PLATFORM 环境变量。
  define: name.startsWith('electron/') ? PLATFORM_DEFINE : undefined,
  ...options,
})

export default defineConfig(() => [
  // Node library entries (tsc-emitted from lib/types).
  {
    name: CLIENT_ID,
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  nodeEntry('host/bridge'),
  nodeEntry('electron/main'),
  nodeEntry('electron/bridge-client'),
  nodeEntry('electron/cli', { banner: '#!/usr/bin/env node' }),
  nodeEntry('electron/preload', { format: ['cjs'] }),
  // Browser bundle: the corum-desktop client half.
  {
    name: `${CLIENT_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    // Monaco imports its own stylesheets (theme tokens, codicon glyphs, editor
    // chrome). tsdown extracts them to lib/style.css; the post-build step
    // scripts/inline-monaco-css.mjs folds that stylesheet into client.js as an
    // injected <style> (the __ModuleLoader__ desktop loader serves no CSS file).
    css: { splitting: false },
    plugins: [{
      name: 'corum-desktop-client-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null
        if (INLINE_SAFE.test(source)) return null
        throw new Error(
          `corum-desktop client bundle purity: "${source}" is not a platform module or an inline-safe wire layer — `
          + 'cross-plugin value imports are forbidden; collaborate through cordis services',
        )
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      // The __ModuleLoader__ loader fetches ONE bundle per entry and resolves
      // only the seed table + registered factories; it has no chunk loader.
      // Fold Monaco (and any other dynamic import) into the single client.js
      // so `require("./editor.api-*.cjs")` never appears at runtime.
      inlineDynamicImports: true,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
  // Monaco language workers: independent classic (iife) scripts served over
  // corumapp://app/monaco/<name>.worker.js. Monaco's ESM worker entries import
  // the real worker bodies; bundling each as a self-contained iife gives
  // `new Worker(url)` a directly runnable script (no bundler at worker time).
  ...(['editor', 'typescript', 'json', 'css', 'html'] as const).map((name): UserConfig => {
    const entry = name === 'editor'
      ? 'monaco-editor/editor/editor.worker.js'
      : name === 'typescript'
        ? 'monaco-editor/language/typescript/ts.worker.js'
        : `monaco-editor/language/${name}/${name}.worker.js`
    const fileName = name === 'editor' ? 'editor.worker.js' : name === 'typescript' ? 'ts.worker.js' : `${name}.worker.js`
    return {
      name: `${CLIENT_ID}/worker-${name}`,
      entry: { [name]: entry },
      outDir: 'lib/workers',
      format: ['iife'],
      platform: 'browser',
      target: 'es2020',
      dts: false,
      sourcemap: false,
      clean: false,
      outputOptions: {
        entryFileNames: fileName,
        inlineDynamicImports: true,
      },
    }
  }),
])
