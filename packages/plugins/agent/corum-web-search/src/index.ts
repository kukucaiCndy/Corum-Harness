/**
 * @corum/corum-web-search —— corum 联网搜索（host 半）。
 *
 * 用户诉求（2026-10-17 拍板，方案 B = 聚合 provider）：websearch 单独拎出来放在
 * 「扩展」里配置；**默认使用 DeepSeek 供应商**（配了 DeepSeek 的 API KEY 即可用）；
 * 用户还能**添加并启用**其他供应商的 websearch。
 *
 * 为什么只能是聚合 provider：
 *   - dsh 的 `searchProvider` 只在 `WebRuntime` 构造时读一次 ⇒ 写死的 pin 让任何新
 *     provider 永远选不上；
 *   - 官方 `deepseek-official` 的 `available()` 恒为 true ⇒ 摘掉 pin 再启用第二个
 *     立刻 `WEB_PROVIDER_AMBIGUOUS`。
 * 聚合 provider 同时做到「即时生效、不需重启、不会 AMBIGUOUS」。
 *
 * 装配（同一纪律：短行 id + 只在 `packages/desktop/cordis.patch.yml` 挂一次）：
 *   - host 半 provide cordis 服务 `corumWebSearch`，并把聚合 provider
 *     （id `corum-web-search`）注册进 `ctx.web`；overlay patch 把 `web` 行的
 *     `searchProvider` pin 到它。
 *   - client 半在「设置 → 扩展」注册「联网搜索」section（order 193）。
 *
 * @module @corum/corum-web-search
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CORUM_WEB_SEARCH_SERVICE_NAME, CorumWebSearchService } from './web-search-service.ts'
import { DEEPSEEK_SUB_PROVIDER_ID } from './deepseek-sub-provider.ts'

export type {
  WebSearchProvider,
  WebSearchSubProvider,
  WebSearchSubProviderView,
  WebSearchStatus,
} from './types.ts'
export {
  CORUM_WEB_SEARCH_PROVIDER_ID,
  CORUM_WEB_SEARCH_SERVICE_NAME,
  CORUM_WEB_SEARCH_SETTINGS_NS,
  CorumWebSearchService,
} from './web-search-service.ts'
export { AggregateWebSearch } from './aggregate.ts'
export type { AggregateWebSearchOptions } from './aggregate.ts'
export {
  createDeepSeekSubProvider,
  currentDeepSeekSection,
  DEEPSEEK_SUB_PROVIDER_ID,
  resolveDeepSeekOptions,
} from './deepseek-sub-provider.ts'
export type { DeepSeekSearchSection } from './deepseek-sub-provider.ts'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'corum-web-search'

/**
 * 运行时依赖的服务。
 *
 * `web`：注册聚合 provider 的 seam。
 * `settings`：激活项（namespace `corum-web-search`）。
 * 两者都是本插件**必需**的接线，故用声明的 inject（红线 4：不靠 `ctx.get` 兜一个
 * 尚未装配的服务）。credentials / launchEnvironment / agents 只在子 provider 内部
 * 可选访问（缺席时按官方语义回落），因此不进 inject。
 */
export const inject: string[] = ['web', 'settings']

/**
 * rc3 Config 声明（volatile 字段 → settings.describe() 自动发现 ns）。
 *
 * settings ns = entry id = `corum-web-search`（cordis.patch.yml insert 行 id）。
 * `activeProvider` volatile 让 SettingsForms.write() 持久化进 profile patch；
 * 服务侧 `activeId()` 从 `settings.describe()` 直读，`setActive()` 走 `update()`。
 *
 * 不再 `settings.register()`（rc3 已删该 API）。
 */
export interface Config {
  activeProvider: Volatile<string | undefined>
}

export const Config = z.object({
  activeProvider: z.string()
    .default(undefined as unknown as string).volatile(),
})

/**
 * 挂载 `corumWebSearch` 服务（幂等：重复 apply 不再注册，避免 cordis
 * 「service has been registered」硬错——同 corum-ollama 的既有做法）。
 *
 * @param ctx - 插件 ctx。
 */
export function apply(ctx: Context): void {
  if (ctx.get(CORUM_WEB_SEARCH_SERVICE_NAME) === undefined) {
    new CorumWebSearchService(ctx)
  }
}
