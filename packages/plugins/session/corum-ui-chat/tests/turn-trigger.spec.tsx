/**
 * 唤醒消息必须渲染成**子 Agent 卡片**，不能套成 "You" 气泡。
 *
 * ## 事故形态（用户实测截图）
 *
 * 后台子 Agent 结束 / 给主会话发消息时，宿主以 user-role 消息投递（带 `source` 归因），
 * 而 fork 的 `UserMessageNodeView` 只认「user 节点 ⇒ 用户气泡」⇒ 对话流里出现一条
 * 「You：Agent <id> sent a message: …」，看起来像用户自己粘了一大段子 Agent 日志。
 *
 * 判据必须是**持久化 `source`**（官方 `MessageSourceMap` 的 `kind`），不是文案前缀。
 *
 * @module @corum/corum-ui-chat/tests/turn-trigger
 */
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// primitives 的运行时产物缺 `simple-icons`（官方包把运行时依赖放进 devDependencies），
// 不替身整文件 fail；本测试只关心「谁是发送者」的渲染分支。
// 用户气泡那条路径还会用到图标（复制/分叉等），一并给空实现；只 mock 用到的那几个
// 名字不够，会被 vitest 以「No xxx export」整条拒掉。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Icon = (): null => null
  // 覆盖用户气泡路径会点到的图标名（漏一个都会被 vitest 以「No xxx export」整条拒掉）。
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
    IconCloseOutlineMedium: Icon,
  }
})

const { triggerSourceOf, triggerBodyText, TurnTriggerCard } = await import('../src/client/chat/TurnTriggerCard.tsx')
const { UserMessageNodeView } = await import('../src/client/chat/MessageItem.tsx')
const { zh } = await import('../src/client/locale.ts')

const t = ((key: string) => (zh as Record<string, string>)[key] ?? key) as never
const noImages = (() => null) as never

/** 造一个 user 节点（`source` 决定它是谁写的）。 */
function userNode(source: unknown): never {
  return {
    kind: 'user',
    seq: 3,
    data: { seq: 3, time: Date.now(), content: [{ type: 'text', text: 'Agent corum-task-child sent a message: 报告写完了' }], source },
  } as never
}

describe('triggerSourceOf — 只认持久化归因', () => {
  it('subagent-settled / agent-message 都判为唤醒消息', () => {
    expect(triggerSourceOf({ kind: 'subagent-settled', senderSessionId: 'x' })?.kind).toBe('subagent-settled')
    expect(triggerSourceOf({ kind: 'agent-message', senderSessionId: 'y' })?.kind).toBe('agent-message')
  })

  it('用户自己的提交（kind: user）不是唤醒消息', () => {
    expect(triggerSourceOf({ kind: 'user', rpcId: 'r1' })).toBeUndefined()
  })

  it('缺失 / 未知 kind / 非对象 ⇒ 不是唤醒消息（保持用户气泡）', () => {
    expect(triggerSourceOf(undefined)).toBeUndefined()
    expect(triggerSourceOf({})).toBeUndefined()
    expect(triggerSourceOf({ kind: 'something-new' })).toBeUndefined()
    expect(triggerSourceOf('text')).toBeUndefined()
  })

  it('带上 senderSessionId / summary / provider', () => {
    const source = triggerSourceOf({ kind: 'subagent-settled', senderSessionId: 's1', summary: 'completed' })
    expect(source).toMatchObject({ kind: 'subagent-settled', senderSessionId: 's1', summary: 'completed' })
  })
})

describe('triggerBodyText — 非文本块不丢消息', () => {
  it('文本原样、图片与附件用占位说明', () => {
    const text = triggerBodyText([
      { type: 'text', text: '第一行' },
      { type: 'image', attachment: { id: 'a' } } as never,
      { type: 'text', text: '第三行' },
    ] as never)
    expect(text).toContain('第一行')
    expect(text).toContain('[图片]')
    expect(text).toContain('第三行')
  })
})

describe('渲染：子 Agent 通知不再冒充用户输入', () => {
  it('★ agent-message 节点渲染成卡片（标题「子 Agent 消息」），且没有 "You"', () => {
    const html = renderToStaticMarkup(
      <UserMessageNodeView node={userNode({ kind: 'agent-message', senderSessionId: 'corum-task-child' })} renderMessageImages={noImages} t={t} />,
    )
    expect(html).toContain('子 Agent 消息')
    expect(html).toContain('data-turn-trigger="agent-message"')
    expect(html).not.toContain('You')
  })

  it('★ subagent-settled 节点渲染成卡片（标题「子 Agent 已结束」），且没有 "You"', () => {
    const html = renderToStaticMarkup(
      <UserMessageNodeView node={userNode({ kind: 'subagent-settled', senderSessionId: 'corum-task-child', summary: 'completed' })} renderMessageImages={noImages} t={t} />,
    )
    expect(html).toContain('子 Agent 已结束')
    expect(html).not.toContain('You')
  })

  it('★ 用户真正敲的消息仍是用户气泡（含 "You"）——不许把所有 user 节点都当通知', () => {
    const html = renderToStaticMarkup(
      <UserMessageNodeView node={userNode({ kind: 'user', rpcId: 'r1' })} renderMessageImages={noImages} t={t} />,
    )
    expect(html).toContain('You')
    expect(html).not.toContain('data-turn-trigger')
  })

  it('无 source 的老消息按用户气泡处理（向后兼容）', () => {
    const html = renderToStaticMarkup(
      <UserMessageNodeView node={userNode(undefined)} renderMessageImages={noImages} t={t} />,
    )
    expect(html).toContain('You')
  })

  it('卡片默认收起时只露 summary，正文要点开才出（点开是交互，SSR 只验收起态）', () => {
    const html = renderToStaticMarkup(
      <TurnTriggerCard
        source={{ kind: 'subagent-settled', senderSessionId: 'corum-task-child', summary: 'completed · 用时 42s' }}
        content={[{ type: 'text', text: '很长的结算正文' }]}
        time={Date.now()}
        t={t}
      />,
    )
    expect(html).toContain('completed · 用时 42s')
    expect(html).not.toContain('很长的结算正文')
  })
})
