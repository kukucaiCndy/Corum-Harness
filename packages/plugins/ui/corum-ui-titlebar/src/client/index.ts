/**
 * @corum/corum-ui-titlebar client half —— 窗口顶部 40px 带子的**唯一 owner**。
 *
 * 占壳声明的根级槽 `corum.titlebar`：**声明权在 @corum/corum-ide-ui** 的 root 条目
 * children 表（声明 = 排他渲染权），本包只 `register` 同名条目并自带 inject 面。
 * owner props（variant / bandWidth / controlsWidth）由壳的 `renderSlot` 下发；
 * 本包经 inject 工厂补上 `ctx.layout` 的 chrome 源与写面。
 *
 * 为什么 inject 而不是把写面做成 owner props：写路径必须唯一（红线 1 / 本仓
 * 「服务收敛」纪律）——侧栏折叠与集成中心都收在 `ctx.layout` 的 chrome 状态里，
 * 活动栏便利入口与标题栏按钮写的是同一份；插件直接 inject 服务即可，不必再开
 * 一条 props 转发面（先例：corum-ide-sidebar-ui 的 `inject` 里已有 'layout'）。
 */
import { type Context as ClientContext } from '@deepseek-ai/cordis'
// type-only：把渲染器对 Context 的增强（ctx.slots / ctx.renderSlot 面）拉进本单元。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// type-only：把 `ctx.uiSession`（会话域绑定的提供者）拉进本单元——同样只走类型，
// 运行期按服务名取（不 import 实现包，红线 3）。
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// type-only：把壳的 SlotMap 行（corum.titlebar 的 owner 契约）拉进本编译单元。
import type {} from '@corum/corum-ide-ui/client'
import type {} from '@corum/corum-ui-conversation/client' // declaration merge: corumNavigation
import { TitleBar, type TitleBarInjected } from './TitleBar.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * 统一标题栏的**会话段**（面包屑 + 状态胶囊 + 轨迹按钮）。
     *
     * 声明权在本插件（它是 `corum.titlebar` 的 occupant，子槽归声明者排他渲染）；
     * 占位者是 `@corum/corum-ui-conversation`（fork）——它同时声明并渲染
     * `conversation.session.header.actions|utilities` 两个 list 子槽（会话顶栏
     * 那两段 corum chrome 的既有契约，名字保持官方原样、零改签）。
     *
     * ⚠️ 本行与 fork 的 contract/slots.ts 同名行必须**逐字一致**（TS 接口合并要求
     * 完全相同的类型）：两边都写 `{ kind: 'single'; scope: 'session' }`。
     */
    'corum.titlebar.session': { kind: 'single'; scope: 'session' }
  }
}

/** Required services: the slots registry + the layout face (chrome 状态与区域显隐写面). */
export const inject = ['slots', 'layout', 'uiSession', 'corumNavigation']

/**
 * 占位注册：`ctx.slots.inject('corum.titlebar', …)` 保证「壳先声明、本包后注册」
 * 的时序（槽未声明时先挂起，声明后自动补注册）。
 * @param ctx - Client context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.inject('corum.titlebar', () => ctx.slots.register(
      {
        name: 'corum.titlebar',
        children: {
          // 子槽声明 = 排他渲染权：本带子渲染它（见 TitleBar.tsx 的会话段）。
          'corum.titlebar.session': { kind: 'single', scope: 'session' },
        },
        inject: (): TitleBarInjected => ({
          hooks: {
            chrome: ctx.layout.chromeSnapshot(),
            // 会话段是 session 严格域：无绑定时 renderSlot 会抛 SlotAssemblyError。
            // 判据取**槽机制自己用的那份绑定**（uiSession 的 session scope adapter），
            // 而不是会话列表的 `current` —— 后者是「列表选择态」，与「主视图保留的
            // 会话」不是同一个量（见官方 ui-session 的 publishMain），拿来当守卫会
            // 在「选了会话但主视图保留的不是它」时放行渲染并炸掉整条带子。
            sessionBand: ctx.uiSession.adapter.current,
          },
          toggleSidebarCollapsed: () => { ctx.layout.toggleSidebarCollapsed() },
          toggleRegion: (slot) => { ctx.layout.toggleRegion(slot) },
          closeSession: () => { ctx.corumNavigation.clearSelection() },
        }),
      },
      TitleBar,
    )),
    'ide-titlebar: corum.titlebar band',
  )
}
