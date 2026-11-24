/**
 * client-bundle-guard.mjs —— client bundle 的**运行期可解析性**守卫。
 *
 * 为什么把它从 `build-all.mjs` 里抽出来：这套判据的核心是「一个 `require(spec)`
 * 到底能不能解析」，而它此前只在**打包 + 安装 + 真机启动**之后才暴露（用户看到的是
 * 「应用打不开」）。抽成纯函数后，事故形态可以直接进单测 —— 不用起实例、不用打包。
 *
 * ## 威胁模型（2026-11-24 0.8.2 事故）
 *
 * client bundle 跑在 shell 的 `__ModuleLoader__` 里，它的 `require(spec)` 只有三个
 * 合法来源：
 *   1. **平台 seed 词**（`PLATFORM_SEED`，shell 静态注入 module table）；
 *   2. 本包在 `dsh.client.external` 里**声明过**的 specifier；
 *   3. 另一个 client bundle 的 `/client` 子路径（由那条 bundle 自己注册）。
 *
 * 其余一律在运行期抛
 * `client-modules: require("…") missed the module table`，整条插件激活失败。
 *
 * 正常构建时，`@corum/corum-agent/contract`（host 包的子路径导出，纯类型 + 方法名常量）
 * 会被**内联**进消费方 bundle，零代价。但打包前的 `--clean` 从零构建遇到依赖环时会
 * 剪掉 `corum-ui-conversation → corum-agent` 这条边，conversation 便在 `lib/contract`
 * 产出**之前**构建 —— rolldown 解析不到，就**降级成外部裸 require**，而这只报
 * `UNRESOLVED_IMPORT` **警告**、exit code 仍是 0。
 *
 * 结果是：`lib/client.js` 文件在、大小正常、样式也内联了（原有三条就绪判据全绿），
 * 打出的 0.8.2 安装包装上去后主界面永远停在启动页：
 *
 *     web boot: 11 entries did not activate
 *     @corum/corum-ui-conversation: import failed: client-modules:
 *       require("@corum/corum-agent/contract") missed the module table …
 *
 * 所以判据必须看**内容**，不能只看文件在不在。
 *
 * @module scripts/lib/client-bundle-guard
 */

/**
 * 平台 seed 词表（与官方 `@deepseek-ai/dsh-client-web` 的 `PLATFORM_MODULES` 同口径）。
 *
 * ⚠️ 两边必须同步：官方在 `packages/client/web/src/platform.ts` 里把它当作
 * 「seeding / bundling externals / Vite aliases 的唯一来源」。这里复制一份是有意的
 * ——本仓的构建门禁不能依赖 dsh checkout 存在。`client-bundle-guard.spec.mjs` 有一条
 * 断言钉住这份清单的形状，改动时会强制被看见。
 */
export const PLATFORM_SEED = Object.freeze([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** Node 内置模块名：桌面壳自己的 client 入口会用到（如 monaco worker 的 `url`）。 */
export const NODE_BUILTINS = Object.freeze([
  'url', 'path', 'fs', 'os', 'crypto', 'util', 'events', 'stream', 'buffer',
  'process', 'assert', 'querystring', 'http', 'https', 'net', 'zlib', 'child_process',
])

/** 匹配产物里的 `require("spec")`（闭包工厂的同步 require 形态）。 */
const REQUIRE_RE = /require\("([^"]+)"\)/g

/** 剥掉 `/client` 后缀：`@x/y/client` 与 `@x/y` 指的是同一个包。 */
export function stripClientSuffix(spec) {
  return spec.endsWith('/client') ? spec.slice(0, -'/client'.length) : spec
}

/**
 * 判定一个 `require(spec)` 是否**必然**在运行期解析失败。
 *
 * @param spec - 产物里的 specifier。
 * @param options.declared - 本包 `dsh.client.external` 声明的 specifier 集。
 * @param options.clientPackages - 已知是 client bundle 的包名集（含官方插件）。
 * @returns 解析不到时为 true。
 */
export function isUnresolvableRequire(spec, options) {
  // 相对/绝对路径由 loader 的 chunk 机制处理，不在本判据范围内。
  if (spec.startsWith('.') || spec.startsWith('/')) return false
  if (PLATFORM_SEED.includes(spec)) return false
  if (options.declared.has(spec)) return false
  if (NODE_BUILTINS.includes(spec)) return false
  // 跨 client 包引用（由对方 bundle 注册）合法。
  if (options.clientPackages.has(stripClientSuffix(spec))) return false
  return true
}

/**
 * 扫描一份 client bundle 源码，列出运行期不可解析的 `require` specifier。
 *
 * @param source - `lib/client.js` 的文本内容。
 * @param options.declared - 本包 `dsh.client.external` 声明的 specifier 集。
 * @param options.clientPackages - 已知是 client bundle 的包名集。
 * @returns 去重后的 specifier 列表（保序）。
 */
export function foreignRequires(source, options) {
  const offenders = []
  const seen = new Set()
  for (const match of source.matchAll(REQUIRE_RE)) {
    const spec = match[1]
    if (seen.has(spec)) continue
    if (!isUnresolvableRequire(spec, options)) continue
    seen.add(spec)
    offenders.push(spec)
  }
  return offenders
}

/**
 * 把守卫的抱怨写成一句可执行的处置（`notReady()` 直接拼进报告）。
 *
 * @param specifiers - {@link foreignRequires} 的结果。
 * @returns 人类可读的一行。
 */
export function describeForeignRequires(specifiers) {
  return `client.js 里含运行期不可解析的 require（${specifiers.join('、')}）`
    + '——tsdown 解析失败时会降级成外部裸 require 且 exit 0，装出来的应用会卡在启动页；'
    + '先跑 `node scripts/build-all.mjs --clean` 重建'
}
