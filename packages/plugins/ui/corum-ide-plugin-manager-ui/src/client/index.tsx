/**
 * @corum/corum-ide-plugin-manager-ui client half —— IDE 插件中心
 * （业务 chrome 拆出壳，NEXT-PHASE-DEFERRED §3）。
 *
 * 职责：
 *   - 监听壳 LayoutController 经 `layout.openPluginManager()` 广播的
 *     `corum:open-plugin-manager` 事件，打开 modal 面板；
 *   - 面板三区（已安装清单 / npm 检索 / 视图管理），数据走 pluginManager RPC
 *     （0.1.2 起官方 connection.rpc）+ ctx.layout 网格面（hidden 集投影 +
 *     setRegionHidden + isInGrid）。
 *
 * 壳（corum-ide-ui）不再 import/渲染本面板——它只持
 * `openPluginManager()` 触发器（标题栏/侧栏轨按钮），面板实现完全在本插件。
 * C1：本插件自声明槽（visibility:'hidden'——面板是 modal 浮层，非网格区域，
 * 不进「添加区域」/视图管理清单）。
 *
 * 浮层实现：本插件独立 bundle，复用不了壳 AppFrame 树内的 FloatingLayer；
 * 自建一个 body 级 modal（遮罩 + 居中面板 + Escape/点遮罩关闭），语义与
 * FloatingLayer 的注册式 modal 一致。
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the shell's Context merge (ctx.layout) into scope. 壳的
// client bundle 不可被静态值 import（B1-pre：dsh 内联每个消费 bundle 一份，
// 静态值 import 经 tsdown 解析 lib/client.js 失败）——事件名与 ctx.layout
// 扩展面用本地镜像（C3a/C3b 能力接口收窄模式：编译期保障、零运行时耦合）。
import type {} from '@corum/corum-ide-ui/client'
import { registerSlot } from '@corum/corum-ui-base/client'
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import { PluginManagerPanel } from './PluginManagerPanel.tsx'
import css from './PluginManagerPanel.module.css'

/** 本插件自声明的槽 key（C1；hidden——modal 浮层非网格区域）。 */
export const PLUGIN_MANAGER_SLOT = '@corum/corum-ide-plugin-manager-ui'

/**
 * 插件中心触发事件名（= 壳 service.ts 的 OPEN_PLUGIN_MANAGER_EVENT）。
 * 壳广播、本插件监听；字符串字面量本地镜像（壳 bundle 不可静态值 import，
 * 见上 import 注释）——改壳侧事件名时同步此处（编译期无联动，靠注释锚定）。
 */
const OPEN_PLUGIN_MANAGER_EVENT = 'corum:open-plugin-manager'

/**
 * ctx.layout 的网格读面能力接口（C3b 收窄）：官方基线 ILayout 窄接口不含
 * 网格面，corum 运行时 LayoutController 是超集。只取本插件用的 4 个方法。
 */
interface GridCapableLayout {
  setRegionHidden(slot: string, hidden: boolean): void
  hiddenSlotsSnapshot(): readonly string[]
  onGridChange(listener: () => void): () => void
  isInGrid(slot: string): boolean
}

/** Required services: slots registry + connection rpc + layout grid face. */
export const inject = ['slots', 'connection', 'layout']

/**
 * Client plugin body: listen for the shell's open-plugin-manager event and
 * mount the modal panel on demand.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // C1 插件自声明槽：modal 浮层非网格区域 → hidden（不进任何网格清单）。
  registerSlot(PLUGIN_MANAGER_SLOT, { label: '插件中心', defaultWeight: 400, visibility: 'hidden' })

  const connection = ctx.get('connection') as ConnectionHandle
  // ctx.layout 收窄为网格读面（C3b 能力接口模式）。
  const layout = ctx.layout as unknown as GridCapableLayout

  // pluginManager RPC caller（0.1.2 起官方 connection.rpc）。
  const callRemote = async <T,>(method: string, args: Record<string, unknown>): Promise<T> => {
    const result = await connection.rpc.call('/api', `pluginManager/${method}`, { args })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as T
  }

  ctx.effect(() => {
    let host: HTMLDivElement | null = null
    let root: Root | null = null

    const close = (): void => {
      root?.unmount()
      root = null
      host?.remove()
      host = null
    }

    const open = (): void => {
      if (host !== null) return // 已打开（单例 modal）
      host = document.createElement('div')
      host.className = css.overlay
      host.setAttribute('data-plugin-manager-overlay', '')
      // 点遮罩关闭（不穿透到面板）。
      host.addEventListener('mousedown', (e) => { if (e.target === host) close() })
      document.body.appendChild(host)
      root = createRoot(host)
      root.render(
        createElement(PluginManagerPanel, {
          subscribeGrid: (listener) => layout.onGridChange(listener),
          getHiddenSnapshot: () => layout.hiddenSlotsSnapshot(),
          isRegionSlot: (slot) => layout.isInGrid(slot),
          onSetRegionHidden: (slot, hidden) => { layout.setRegionHidden(slot, hidden) },
          onClose: close,
          callRemote,
        }),
      )
    }

    // Escape 关闭（面板打开时）。
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && host !== null) close()
    }
    document.addEventListener('keydown', onKeyDown)

    // 壳触发器（标题栏/侧栏轨按钮）→ layout.openPluginManager() → 本事件。
    const onOpen = (): void => { open() }
    window.addEventListener(OPEN_PLUGIN_MANAGER_EVENT, onOpen)

    return () => {
      window.removeEventListener(OPEN_PLUGIN_MANAGER_EVENT, onOpen)
      document.removeEventListener('keydown', onKeyDown)
      close()
    }
  }, 'ide-plugin-manager: modal panel + open listener')
}
