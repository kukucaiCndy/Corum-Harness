/**
 * `corumWebSearch` —— corum 联网搜索的 cordis 服务（跨 bundle 状态的唯一家）。
 *
 * ## 它解决的两条硬事实（读源码确认，见 aggregate.ts 文件头）
 *
 * 1. `dsh-web` 的 `searchProvider` **只在 `WebRuntime` 构造时读一次**，写死的 pin
 *    ⇒ 任何新注册的 provider 永远选不上。
 * 2. 官方 `deepseek-official` 的 `available()` 恒为 true ⇒ 摘掉 pin 又启用第二个
 *    立刻 `WEB_PROVIDER_AMBIGUOUS`。
 *
 * ⇒ 本服务把 pin 变成「钉在一个永远在册、永远可用的 corum 聚合 provider 上」，
 * 把「用哪个供应商」降级成聚合 provider 内部的一个 settings 值。
 *
 * ## 面
 *
 * - **RPC**（`TypertRemoteService` + `@Remote` ⇒ `/api/corumWebSearch/*`，无需
 *   typert codegen；发现机制同 `pluginManager`/`localLlm`）：
 *   `describe()` 当前状态；`setActive(id)` 切激活项。
 * - **cordis 服务面**：其它插件在**自己的** ctx 上 `ctx.corumWebSearch.registerSubProvider(p)`
 *   即可加入可选列表（红线 1：跨 bundle 共享状态走 cordis 服务，不用模块级单例；
 *   注册是调用方 fiber 上的 effect，插件卸载即自动注销）。
 * - **settings**：namespace `corum-web-search`，字段 `activeProvider`。由本插件的
 *   host apply 直接注册，而 host 行是 boot 常驻行 ⇒ 冷启动即在册（不需要
 *   corum-memory 那种独立 settings-registrar 行——那个纪律针对的是「只在按需打开的
 *   设置页里注册」的插件）。
 *
 * @module @corum/corum-web-search/web-search-service
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type { WebSearchSubProvider, WebSearchStatus } from './types.ts'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { AggregateWebSearch } from './aggregate.ts'
import { createDeepSeekSubProvider, DEEPSEEK_SUB_PROVIDER_ID } from './deepseek-sub-provider.ts'

/** 聚合 provider 在 `ctx.web` 里的注册键（overlay patch 的 pin 值）。 */
export const CORUM_WEB_SEARCH_PROVIDER_ID = 'corum-web-search'

/** cordis 服务名（RPC 前缀 `/api/corumWebSearch/*` 也由它派生）。 */
export const CORUM_WEB_SEARCH_SERVICE_NAME = 'corumWebSearch'

/** settings namespace：承载「启用哪个子 provider」。 */
export const CORUM_WEB_SEARCH_SETTINGS_NS = 'corum-web-search'

/** settings namespace `corum-web-search` 的解析值。 */
export interface CorumWebSearchConfig {
  /** 当前激活的子 provider id。 */
  activeProvider: string
}

/**
 * 本 namespace 的 schema。`activeProvider` 是**唯一**字段——子 provider 自己的
 * 参数（endpoint / maxUses / Key 引用）仍归各自 provider 的 namespace，本服务不复制。
 */
const CorumWebSearchSettings: z<CorumWebSearchConfig> = z.object({
  activeProvider: z.string().default(DEEPSEEK_SUB_PROVIDER_ID),
})

/**
 * 聚合搜索 provider 的宿主服务。
 *
 * 构造即完成三件事（幂等由调用方 `apply` 的「服务已在册」判定负责）：
 * ① 注册 settings namespace；② 注册内置 DeepSeek 子 provider；③ 把聚合 provider
 * 注册进 `ctx.web`。三者的释放都绑在本插件 fiber 上。
 */
export class CorumWebSearchService extends TypertRemoteService {
  /** inject 由插件层声明（见 index.ts）；服务类自身不额外等待，同 corum-ollama。 */
  static inject: string[] = []

  private readonly aggregate: AggregateWebSearch

  /**
   * @param ctx - 插件 ctx（必须已 inject web + settings）。
   */
  constructor(ctx: Context) {
    super(ctx, CORUM_WEB_SEARCH_SERVICE_NAME)
    // rc3：settings namespace 由插件 Config（cordis schema）声明，profile patch 写值。
    // 不再 `settings.register()`；读走 `describe()`，写走 `update()`。
    this.aggregate = new AggregateWebSearch({
      aggregateId: CORUM_WEB_SEARCH_PROVIDER_ID,
      // 每次调用现读 settings ⇒ 切换即时生效，不需要重注册 provider、不需要重启。
      activeId: () => this.activeId(),
    })

    // 内置子 provider。注册动作本身在构造期内完成（这样聚合 provider 一注册可用），
    // 释放走 ctx.effect ⇒ 随本插件 fiber 卸载。
    const disposeBuiltin = this.aggregate.register(createDeepSeekSubProvider(ctx))
    ctx.effect(() => disposeBuiltin, 'corum-web-search: builtin deepseek sub provider')

    // 聚合 provider 注册进 dsh 的 web seam。disposer 归本插件 fiber
    // （registerSearchProvider 的 effect 记在**调用方** ctx 上）。
    ctx.effect(
      () => ctx.web.registerSearchProvider(this.aggregate),
      'corum-web-search: aggregate search provider',
    )
  }

  /** 当前激活的子 provider id。 */
  activeId(): string {
    // rc3：从 settings describe() 读 namespace 值；未注册时回落默认。
    const descriptor = this.ctx.settings.describe().find(d => d.ns === CORUM_WEB_SEARCH_SETTINGS_NS)
    const value = (descriptor?.value as CorumWebSearchConfig | undefined)?.activeProvider
    return value !== undefined && value.length > 0 ? value : DEEPSEEK_SUB_PROVIDER_ID
  }

  /**
   * 把一个子 provider 加入可选列表。
   *
   * 调用方传自己的 plugin ctx 时，返回的 disposer 会绑到该 ctx——插件卸载即自动
   * 注销；显式调用 disposer 也可提前注销。
   *
   * @param provider - 子 provider（`id` 是注册键，重复即抛 `WEB_DUPLICATE_PROVIDER`）。
   * @returns 注销它的 disposer。
   */
  registerSubProvider(provider: WebSearchSubProvider): () => void {
    const remove = this.aggregate.register(provider)
    const dispose = this.ctx.effect(
      () => remove,
      `corum-web-search: sub provider ${provider.id}`,
    )
    return () => void dispose()
  }

  /**
   * 当前状态：聚合 id、激活项、全部子 provider 及其可用性/激活标记。
   * @returns 设置页渲染所需的全部事实。
   */
  @Remote('describe')
  describe(): WebSearchStatus {
    const activeId = this.activeId()
    const subProviders = this.aggregate.list().map(provider => ({
      id: provider.id,
      label: provider.label,
      origin: provider.origin,
      // available() 是子 provider 的**本地**判定，不触发网络（dsh 契约要求）。
      available: provider.available(),
      active: provider.id === activeId,
    }))
    const active = this.aggregate.active()
    return {
      aggregateId: this.aggregate.id,
      activeId,
      activeAvailable: active !== undefined && active.available(),
      subProviders,
    }
  }

  /**
   * 切换激活的子 provider（写 settings ⇒ 下一次搜索立刻走新项；不重启、不重注册）。
   *
   * 不做「必须可用才能切」的限制：让用户能提前切到一个尚未配好的供应商（设置页会
   * 标出它不可用），失败在真正的搜索发生时才报——报错信息指名道姓。
   *
   * @param id - 目标子 provider id。
   * @returns 切换后的状态。
   */
  @Remote('setActive')
  async setActive(id: string): Promise<WebSearchStatus> {
    // rc3：走 settings.update() 写 namespace 值。
    await this.ctx.settings.update(CORUM_WEB_SEARCH_SETTINGS_NS, { activeProvider: id })
    return this.describe()
  }
}
