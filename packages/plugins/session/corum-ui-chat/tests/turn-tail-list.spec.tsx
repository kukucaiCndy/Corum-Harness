/**
 * Turn-tail 槽契约（rc3，2026-10-29）：**list** 而不是 chain。
 *
 * ## 缺陷现象（生产 / 实机 console）
 *
 * ```
 * Error: chain slot "conversation.chat.turnTail" requires options.select
 *   at SlotCore.register …
 *   at registerChatNodeRenderers …
 * ```
 *
 * ## 根因
 *
 * 官方 rc3 把 `conversation.chat.turnTail` 从 `chain` 改成 `list`：官方
 * `ui-deliverables` / `ui-plan` / `ui-schedule` 三个包的 tail 卡片都以 **list 条目**
 * 注册在该槽上（`ctx.slots.register({ name, id, … }, DeliverablesTail)`），list 的
 * 注册不需要 `select`。corum fork 的契约/注册表还停在 chain ⇒ 这些官方条目注册即抛错
 * （加载期 console 留错），并且 chain 派发器只会渲染「当选的那一个」。
 *
 * 本文件钉两组判据：
 *   ① 注册面：`registerChatNodeRenderers` 给 turn-tail 节点声明的子槽 kind 是 list；
 *   ② 渲染面：`TurnTailNodeView` 用普通 `renderSlot` 派发，多个 tail 条目**同时**渲染
 *      （chain 只会渲染一个）。
 *
 * @module @corum/corum-ui-chat/tests/turn-tail-list
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Context } from '@deepseek-ai/cordis'

/**
 * 官方 UI 积木包在测试里替身化：它的 `lib/index.js` 带入 `simple-icons` 等
 * **未为单测安装**的运行时依赖（生产走 dsh 的模块表内联，不走 Node 解析）。
 * 本文件断言的是**槽契约与 tail 派发**，与积木视觉无关，故用 Proxy 替身：
 * 任意命名导出都解析成一个空组件（`closing === null` 分支不会渲染它们）。
 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Stub = (): null => null
  return {
    DisclosureRow: Stub,
    IconBranchOutlineMedium: Stub,
    IconCheckOutlineMedium: Stub,
    IconCopyOutlineMedium: Stub,
    IconDataOutlineMedium: Stub,
    Menu: Stub,
    RiskConfirmation: Stub,
    Tooltip: Stub,
    writeClipboard: async (): Promise<void> => {},
  }
})

const { registerChatNodeRenderers } = await import('../src/client/chat/register-node-renderers.ts')
const { TurnTailNodeView } = await import('../src/client/chat/TurnTailNodeView.tsx')

interface Registration {
  options: { name: string; key?: string; children?: Record<string, { kind: string; scope: string }> }
  component: unknown
}

/** 记录式 slots 面：与 `ctx.slots` 的两个方法同形（inject 立即求值、register 只记录）。 */
function recordingSlots(): { ctx: Context; registrations: Registration[] } {
  const registrations: Registration[] = []
  const ctx = {
    slots: {
      inject: (_name: string, run: () => unknown) => run(),
      register: (options: Registration['options'], component: unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  } as unknown as Context
  return { ctx, registrations }
}

type AnyComponent = (props: Record<string, unknown>) => unknown

describe('① 注册面：turn-tail 子槽按 rc3 声明为 list', () => {
  it('turn-tail 节点声明的 conversation.chat.turnTail 是 list（chain 会让官方 tail 条目注册即抛）', () => {
    const { ctx, registrations } = recordingSlots()
    registerChatNodeRenderers(ctx)
    const entry = registrations.find(reg => reg.options.key === 'turn-tail')
    expect(entry, '未注册 turn-tail 节点渲染器').toBeDefined()
    expect(entry?.options.children?.['conversation.chat.turnTail']).toEqual({ kind: 'list', scope: 'session' })
    expect(entry?.options.children?.['conversation.chat.assistant-actions']).toEqual({ kind: 'list', scope: 'session' })
    expect(entry?.component).toBe(TurnTailNodeView)
  })

  it('注册全程不抛，且全部落在 conversation.chat.node 上', () => {
    const { ctx, registrations } = recordingSlots()
    expect(() => registerChatNodeRenderers(ctx)).not.toThrow()
    expect(registrations.every(reg => reg.options.name === 'conversation.chat.node')).toBe(true)
  })
})

describe('② 渲染面：renderSlot 派发，多个 list 条目同时渲染', () => {
  /** 最小 turn-tail 视图 props（closing === null ⇒ 只走 tail 派发分支）。 */
  function propsFor(renderSlot: (key: string, owner: unknown) => unknown): Record<string, unknown> {
    return {
      node: {
        key: 'turn-tail:7',
        location: { kind: 'turn', turn: { turn: 7 } },
        data: { turn: 7, seq: 42, closing: null, branchUnavailable: false },
      },
      openFile: () => {},
      forkAt: () => {},
      t: (key: string) => key,
      useChat: (select: (snapshot: unknown) => unknown) => select({
        locations: { getTurn: () => ['turn-tail:7'] },
        nodes: { get: () => undefined },
      }),
      renderSlot,
    }
  }

  // `TurnTailNodeView` 是 memo(...) 包装：取内层函数直接调用（closing === null
  // 分支不触发任何 React 内置 hook，只有 props 下发的 useChat），再把返回的元素
  // 交给 renderToStaticMarkup —— 这样不必引入 jsdom 也能断言真实渲染结果。
  const Inner = (TurnTailNodeView as unknown as { type: AnyComponent }).type
  const render = (props: Record<string, unknown>): string =>
    renderToStaticMarkup(Inner(props) as never)

  it('两个官方风格的 tail 条目一起出现在输出里（chain 只会渲染当选的一个）', () => {
    const calls: Array<{ key: string; owner: { turn?: { turn?: number }; seq?: number } }> = []
    const html = render(propsFor((key, owner) => {
      calls.push({ key, owner: owner as { turn?: { turn?: number }; seq?: number } })
      // list 派发的返回形状：条目组件渲染结果按注册序拼接。
      return [
        h('div', { key: 'deliverables', 'data-tail-contributor': 'deliverables' }),
        h('div', { key: 'plan', 'data-tail-contributor': 'plan' }),
      ]
    }))
    expect(calls.map(call => call.key)).toEqual(['conversation.chat.turnTail'])
    expect(html).toContain('data-tail-contributor="deliverables"')
    expect(html).toContain('data-tail-contributor="plan"')
  })

  it('owner 面：turn 与 seq 按契约下发（seq = closing.finalNode.seq 或本节点 seq）', () => {
    let owner: { turn?: unknown; seq?: unknown; openFile?: unknown } | undefined
    render(propsFor((_key, next) => {
      owner = next as { turn?: unknown; seq?: unknown; openFile?: unknown }
      return null
    }))
    expect(owner?.turn).toEqual({ turn: 7 })
    expect(owner?.seq).toBe(42)
    expect(typeof owner?.openFile).toBe('function')
  })

  it('无条目 ⇒ 不渲染外壳（空 tail 保持 null，不留空 div）', () => {
    expect(render(propsFor(() => null))).toBe('')
  })
})
