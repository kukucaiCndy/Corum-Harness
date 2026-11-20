/**
 * @corum/plugin-build —— 插件构建契约的唯一载体。
 *
 * ## 为什么需要它（58 份重复的代价）
 *
 * 2026-10-20 全量扫描：39 份 `tsdown.config.ts`（52–87 行/份，其中 27 份的
 * `CLIENT_EXTERNALS` / banner / footer / intro / `define` / `noExternal` / CSS 管线
 * **逐字相同**）+ 27 份 `scripts/inline-css.mjs`（只差包名常量）。
 *
 * 重复本身还不是最贵的：贵在**它们无法被第三方复用**。第三方要产出一个能被
 * `__ModuleLoader__` 装载的 client bundle，就得手抄 banner/footer/externals —— 抄错任何一个
 * 字节都是「装不上、且报错指向别处」。把这套契约写进包，规范（docs/PLUGIN-SPEC.md §7）才有载体。
 *
 * ## 两种产物
 *
 * | 半 | 产物 | 关键点 |
 * |---|---|---|
 * | 宿主半 | `lib/index.js`（ESM / node） | 入口是 `tsc -b` 的产物 `lib/types/*.js`，不是源码 |
 * | 客户端半 | `lib/client.js`（CJS / browser 闭包） | `window.__ModuleLoader__.load({id, factory})`；CSS 由 `corum-inline-css` 内联 |
 *
 * ## 与官方 / 既有配置的关系
 *
 * 这里**不重新发明**任何选项：每个字段都是从既有 39 份配置里提取的公共交集 + 显式开关。
 * 迁移的判据是「产物字节不变」（`lib/*.js` 的 sha256 与迁移前一致），不是「能构建」。
 *
 * @module @corum/plugin-build
 */

import { defineConfig, type UserConfig } from 'tsdown'

/**
 * 桌面 module table 固有的一批外部依赖（**基础集**）。
 *
 * 这些 id 由 loader 的 module table 提供，必须 external：打进 bundle 会得到第二份实例
 * （React 双实例 ⇒ hooks 报错；cordis 双实例 ⇒ 服务注册撞名）。
 */
export const CLIENT_EXTERNALS_BASE: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
]

/** 宿主半：`tsc -b` 产物 → `lib/` 下的 ESM（node）。 */
export interface HostConfigOptions {
  /** 包名（tsdown 的 `name` 字段，出错时用它定位）。 */
  id: string
  /** `tsc -b` 的产物入口。缺省 `['lib/types/index.js']`；多入口用对象形态。 */
  entries?: string[] | Record<string, string>
  /** 额外 external（通常是 `peerDependencies` 里的 `@deepseek-ai/*`）。 */
  external?: string[]
}

/**
 * 客户端半：源码入口 → `lib/client.js` 闭包工厂（browser / CJS）。
 *
 * 闭包形态（banner/footer/intro）**不可自定义**：那是 loader 的装载契约，
 * 每个字节都由 `packages/desktop` 的 `__ModuleLoader__` 消费。
 */
export interface ClientConfigOptions {
  /** 包名。同时是 `__ModuleLoader__.load({ id })` 的 id 与产物文件名基准。 */
  id: string
  /** 源码入口，缺省 `src/client/index.ts`。 */
  entry?: string
  /**
   * 增量 external：模块表里**另有**行号的 corum 包（例如 fork 的
   * `@corum/corum-ui-conversation` 由它自己的 bundle 注册）。这些必须 external，
   * 否则会在消费 bundle 里被内联成第二份实现。
   */
  extraExternals?: string[]
  /**
   * 是否钉死解析条件（`production`/`development` → `browser`/`import`/`module`/`default`）。
   * 官方 clientBundle preset 用它让 lexical & co 取到静态的 production 版本。
   * 缺省 `false`（与既有 27 份配置里的 22 份一致）。
   */
  pinConditionNames?: boolean
  /**
   * CSS 提取模式：
   * - `single`（缺省）→ `css: { splitting: false }`：闭包必须单文件，样式随 bundle 走；
   * - `default` → 不写 `css` 选项，交回 tsdown 默认（仅少数包的既有配置如此，逐字保真用）。
   */
  cssMode?: 'single' | 'default'
}

/**
 * 宿主半配置的**精确形状**。
 *
 * 为什么不直接标 `UserConfig`：tsdown 的 `UserConfig['outputOptions']` / `noExternal` /
 * `inputOptions` 都是「字面量 **|** 工厂函数」的联合类型，标成宽类型会让消费方（以及本包的测试）
 * 每读一个字段都要先窄化 —— CI 的 `pnpm -r run typecheck` 就是这样抓出 7 处 TS2339/TS2349 的。
 * 这里把「我们实际产出的形状」写成独立接口，赋值给 `defineConfig` 时结构兼容即可。
 */
export interface HostBundleConfig {
  name: string
  entry: string[] | Record<string, string>
  outDir: string
  format: string[]
  platform: string
  target: string
  fixedExtension: boolean
  dts: boolean
  clean: boolean
  external?: string[]
}

export function hostConfig(options: HostConfigOptions): HostBundleConfig {
  return {
    name: options.id,
    entry: options.entries ?? ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    ...options.external === undefined ? {} : { external: [...options.external] },
  }
}

/** 客户端半配置的精确形状（理由同 {@link HostBundleConfig}）。 */
export interface ClientBundleConfig {
  name: string
  entry: Record<string, string>
  outDir: string
  format: string
  platform: string
  dts: boolean
  sourcemap: boolean
  clean: boolean
  external: string[]
  define: Record<string, string>
  noExternal: (id: string) => true | undefined
  css?: { splitting: boolean }
  inputOptions: {
    resolve?: { conditionNames: string[] }
    /** Shim missing exports for externals whose named exports can't be statically analyzed (e.g. @corum/* wrapped browser bundles). */
    shimMissingExports?: boolean
  }
  outputOptions: {
    entryFileNames: string
    inlineDynamicImports: boolean
    banner: string
    footer: string
    intro: string
  }
}

export function clientConfig(options: ClientConfigOptions): ClientBundleConfig {
  const externals = [...CLIENT_EXTERNALS_BASE, ...(options.extraExternals ?? [])]
  const mode = process.env.NODE_ENV ?? 'production'
  const config: ClientBundleConfig = {
    name: `${options.id}/client`,
    entry: { client: options.entry ?? 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...externals],
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode),
      'import.meta.env.MODE': JSON.stringify(mode),
      'import.meta.env': JSON.stringify({ MODE: mode }),
    },
    noExternal: (id: string) => (externals.includes(id) ? undefined : true),
    ...(options.cssMode === 'default' ? {} : { css: { splitting: false } }),
    // `@corum/*` externals are wrapped browser bundles (window.__ModuleLoader__.load)
    // whose named exports can't be statically analyzed at build time.
    //
    // shimMissingExports was previously `true` to mask runtime `@corum/*` imports
    // (which inline a second copy of the source → duplicate factory registration).
    // Reverted to `false` (the rollup default): cross-bundle shared capabilities
    // must go through cordis services (red line 1), not runtime `@corum/*` imports.
    // A missing-export error at build time is now a **correct guard** — it catches
    // accidental runtime cross-bundle imports before they reach production.
    inputOptions: {
      ...(options.pinConditionNames === true ? {
        resolve: {
          conditionNames: [mode === 'development' ? 'development' : 'production', 'browser', 'import', 'module', 'default'],
        },
      } : {}),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      inlineDynamicImports: true,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(options.id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
  return config
}

/**
 * 一个插件包的完整配置：宿主半 +（可选）客户端半。
 *
 * ```ts
 * // packages/plugins/ui/corum-ui-titlebar/tsdown.config.ts
 * import { definePluginBundle } from '@corum/plugin-build'
 * export default definePluginBundle({ id: '@corum/corum-ui-titlebar' })
 * ```
 */
export function definePluginBundle(parts: {
  id: string
  host?: Omit<HostConfigOptions, 'id'> | false
  client?: Omit<ClientConfigOptions, 'id'> | false
}): () => UserConfig[] {
  return defineConfig(() => {
    const configs: UserConfig[] = []
    if (parts.host !== false) configs.push(hostConfig({ id: parts.id, ...parts.host }) as unknown as UserConfig)
    if (parts.client !== false && parts.client !== undefined) {
      configs.push(clientConfig({ id: parts.id, ...parts.client }) as unknown as UserConfig)
    }
    return configs
  }) as unknown as () => UserConfig[]
}
