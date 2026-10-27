/**
 * @corum/corum-web-search client half —— 在「设置 → 扩展」注册「联网搜索」section。
 *
 * ## 为什么在这里（而不是原来的位置）
 *
 * 官方 `web-search-deepseek` provider 的配置卡原先注册进 `settings.plugin.item`，
 * 而那个子槽的**唯一渲染者**（官方/fork 的 ExtensionsSection）已于 2026-10-03 随
 * 「插件管理」设置分区整块移除（`corum-ide-ui/src/client/settings/SettingsSections.tsx`
 * 142/152-159）⇒ web 搜索卡在 UI 上**完全不可达**。所以这一步不是「搬位置」，是
 * 「第一次让它可用」：本 section 自带导航入口，落在「扩展」组（`navGroup` 查不到
 * 就缺省 `'extensions'`，`SettingsSections.tsx:162-186`）。
 *
 * order 193：扩展组现有序次 = 插件管理 145（已移除）→ AI 润色 165 → Ollama 195 →
 * 本地文生图 197；193 落在「AI 润色」与「Ollama」之间。
 *
 * ## 两处订阅的归属判断（原卡里的订阅去哪）
 *
 * 原 `corum-ui-settings-plugins/src/client/index.ts:83-86` 的
 * `credentials/reference-updated` 订阅**搬到这里**，依据：它是**卡自己的**失效
 * 通知（Key 可能在「模型」页被同一个引用写，settings section 不会因此变化），
 * 订阅者与被通知者是同一个 UI 面；卡删除后留在原处就是订阅一个已经不渲染的
 * controller（死写）。同文件另两条 `llm/adapters-updated` /
 * `settings/document-updated` 订阅服务的是 SubagentModelSelectionCard，**留在原处**
 * （与本节无关）。
 *
 * ## 凭据引用规则
 *
 * 「section 声明的 `apiKeyEnv` 否则 DeepSeek 默认」这条规则的家在
 * `@corum/corum-ui-base/client` 的 `webSearchCredentialRef`
 * （该包是本仓唯一被跨 bundle **值** import 的 client 面；跨 client 包值 import 会被
 * tsdown 解析失败）。原第三份拷贝（`web-search-card-controller.ts` 的 `refOf()`）
 * 已随那张卡一并删除。
 *
 * @module @corum/corum-web-search/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：拉入 ctx.remote 的 Context 合并与 $on 的转发事件 key 面。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { webSearchCredentialRef } from '@corum/corum-ui-base/client'
import { useEffect, useState } from 'react'
import { WebSearchSection } from './WebSearchSection.tsx'
import type {
  WebSearchCall,
  WebSearchCredentialsFace,
  WebSearchSectionValue,
  WebSearchSettingsFace,
} from './WebSearchSection.tsx'

/** 官方 DeepSeek 搜索 provider 的 settings namespace（client 不依赖 host 包，故重声明）。 */
const WEB_SEARCH_NS = 'web-search-deepseek'

/** host RPC 调用（形态同 corum-ollama/corum-memory：`/api/<service>/<method>`）。 */
function makeCall(connection: ConnectionHandle): WebSearchCall {
  return async function call<T, A extends object = Record<string, unknown>>(
    method: string,
    args?: A,
  ): Promise<T> {
    const result = await connection.rpc.call('/api', `corumWebSearch/${method}`, { args: args ?? {} })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as T
  }
}

/**
 * section 宿主：把 settings 面 / credentials 域的「当前值」投影成组件所需的
 * `keyRef`，并在两者变化时重渲染（组件本身不管寻址规则）。
 */
function WebSearchSectionHost({ call, settings, credentials }: {
  call: WebSearchCall
  settings: WebSearchSettingsFace
  credentials: WebSearchCredentialsFace
}) {
  const [, force] = useState(0)
  useEffect(() => settings.subscribe(() => force(v => v + 1)), [settings])
  const section: WebSearchSectionValue | undefined = settings.getSnapshot().value
  return (
    <WebSearchSection
      call={call}
      settings={settings}
      credentials={credentials}
      keyRef={webSearchCredentialRef(section)}
    />
  )
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'connection', 'remote', 'remote.credentials', 'configForms']

/**
 * 注册「联网搜索」settings section。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  let slots: ClientContext['slots'] | undefined
  try {
    slots = ctx.slots
  } catch {
    return
  }
  const connection = ctx.get('connection') as ConnectionHandle
  const call = makeCall(connection)
  // rc3：settings 面改走 ctx.configForms.get(ns)（ConfigForm<T>）。
  // 读走共享 mirror，写走官方序列化写链。
  const form = ctx.configForms.get<unknown>(WEB_SEARCH_NS)
  const settings: WebSearchSettingsFace = {
    getSnapshot: () => form.getSnapshot() as {
      status: string
      value: WebSearchSectionValue | undefined
      user: unknown
      revision: number | undefined
      writable: boolean
    },
    subscribe: (listener) => form.subscribe(listener),
    set: async (field, value) => { void await form.set(field, value) },
    unset: async (field) => { void await form.unset(field) },
  }

  // credentials 域的窄化面：查一个引用的状态、写一个引用，外加「该引用被别处改动」
  // 的失效通知（§订阅归属见文件头）。
  const listeners = new Set<(ref: string) => void>()
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref: string) => {
      for (const listener of listeners) listener(ref)
    }),
    'corum-web-search: credential invalidations',
  )
  const credentials: WebSearchCredentialsFace = {
    async describe(ref) {
      const response = await ctx.remote.credentials.describe([ref])
      if (!response.ok) return { configured: false, writable: true }
      const view = response.value[ref]
      // 未知引用按「可写」处理：控件保持可用、由 host 去拒绝，而不是前端替它猜。
      return { configured: view?.configured ?? false, writable: view?.writable ?? true }
    },
    async set(ref, value) {
      // 拒绝会从调用方随后的 describe 里现形：host 才是「Key 现在有没有」的权威。
      await ctx.remote.credentials.set(ref, value)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'web-search',
    order: 193,
    label: '联网搜索',
  }, () => <WebSearchSectionHost call={call} settings={settings} credentials={credentials} />))
}
