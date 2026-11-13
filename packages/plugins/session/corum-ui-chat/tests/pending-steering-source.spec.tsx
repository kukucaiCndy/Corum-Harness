/**
 * pending 插话里的**唤醒消息**不能画成用户气泡。
 *
 * ## 事故形态
 *
 * 父 Agent 处于阻塞（活跃）轮次时，子 Agent 的结算账单走 `steer` 塞进 next-step inbox
 * （`corum-subagent/src/manager.ts` 的 `notifySettlement`），`ChatView` 于是用
 * `PendingSteeringBubble` 把它渲染出来 —— 而那个组件原先**只接 content、不接 source**，
 * 一律渲染成 `UserStyleBubble` + 撤回按钮。用户看到的是「You：子 Agent 日志」，
 * 阻塞解除、消息投递后才变回正常通知行：同一份运行时通知在 pending 阶段冒充用户输入。
 *
 * `PendingSteeringBubble` 现在接可选 `source`，按与 durable 投影同源的 `triggerSourceOf`
 * 分流。本文件钉两件事：
 *
 *   1. 唤醒消息 ⇒ TurnTriggerCard，**没有** "You"、没有撤回按钮、没有 pending 标记；
 *   2. 负向控制：用户自己的插话逐字保持原样（"You" + 撤回按钮 + pending 标记）。
 *
 * @module @corum/corum-ui-chat/tests/pending-steering-source
 */
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// primitives 的运行时产物缺 `simple-icons`（官方把运行时依赖放进 devDependencies），
// 不替身整文件 fail；本测试只关心「这条 pending 行被分成哪种形态」。
// 漏一个名字都会被 vitest 以「No xxx export」整条拒掉，故按用户气泡路径会点到的图标全列。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Icon = (): null => null
  return {
    FileTypeIcon: Icon,
    JsonBlock: Icon,
    StateDot: Icon,
    Tooltip: ({ children }: { children?: unknown }) => children as never,
    fileSizeText: () => '',
    IconCopyOutlineMedium: Icon,
    IconBranchOutlineMedium: Icon,
    IconForkOutlineMedium: Icon,
    IconAttentionOutlineMedium: Icon,
    IconChecklistOutlineMedium: Icon,
    IconChevronDownOutlineMedium: Icon,
    IconChevronUpOutlineMedium: Icon,
    IconCheckOutlineMedium: Icon,
    IconCloseOutlineMedium: Icon,
  }
})

const { PendingSteeringBubble } = await import('../src/client/chat/MessageItem.tsx')
const { zh } = await import('../src/client/locale.ts')

const t = ((key: string) => (zh as Record<string, string>)[key] ?? key) as never
const noImages = (() => null) as never
const noRevert = async (): Promise<void> => {}

/** 一条 pending 插话（inbox 投影项的内容块 + 可选 source）。 */
const CONTENT = [{ type: 'text', text: 'Background subagent corum-task-child finished' }]

/** 渲染一条 pending 插话。 */
function render(source?: unknown): string {
  return renderToStaticMarkup(
    <PendingSteeringBubble
      content={CONTENT}
      {...(source === undefined ? {} : { source })}
      renderMessageImages={noImages}
      onRevert={noRevert}
      t={t}
    />,
  )
}

describe('PendingSteeringBubble — source 路由', () => {
  it('★ 子 Agent 结算（subagent-settled）渲染成通知卡片，不冒充用户输入', () => {
    const html = render({ kind: 'subagent-settled', senderSessionId: 'corum-task-child', summary: 'completed' })
    expect(html).toContain('data-turn-trigger="subagent-settled"')
    expect(html).toContain('子 Agent 已结束')
    expect(html).not.toContain('You')
    // 运行时通知撤不回去：不许出现撤回按钮，也不许带 pending 插话标记。
    expect(html).not.toContain(zh['message.revertToQueue'])
    expect(html).not.toContain('data-pending-steering')
  })

  it('★ Agent 间消息（agent-message）同样走通知卡片', () => {
    const html = render({ kind: 'agent-message', senderSessionId: 'corum-task-child' })
    expect(html).toContain('data-turn-trigger="agent-message"')
    expect(html).toContain('子 Agent 消息')
    expect(html).not.toContain('You')
  })

  it('★ 负向控制：用户自己的插话逐字保持原样（"You" + 撤回按钮 + pending 标记）', () => {
    const html = render({ kind: 'user', rpcId: 'r1' })
    expect(html).toContain('data-pending-steering="true"')
    expect(html).toContain('You')
    expect(html).toContain(zh['message.revertToQueue'])
    expect(html).not.toContain('data-turn-trigger')
  })

  it('无 source 的旧形态同样保持用户气泡（向后兼容）', () => {
    const html = render(undefined)
    expect(html).toContain('data-pending-steering="true"')
    expect(html).toContain('You')
    expect(html).not.toContain('data-turn-trigger')
  })

  it('未知 source 不被误判成唤醒消息', () => {
    const html = render({ kind: 'something-new' })
    expect(html).toContain('data-pending-steering="true"')
    expect(html).not.toContain('data-turn-trigger')
  })
})
