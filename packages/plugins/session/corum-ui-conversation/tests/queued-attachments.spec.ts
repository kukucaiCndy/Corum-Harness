/**
 * issue #211：**排队消息里的图片不能「消失」**。
 *
 * ## 事故（用户实测）
 *
 * Agent 正在跑时发一条带图片的消息（busy ⇒ 进队列），图片看起来丢了。核实结论：
 * 图片**没有真丢** —— durable ref 一直在 `next-turn` 队列行的 content 里，模型也收到了
 * （会话日志里 `agent/inbox/spliced` 与出队后的 `user/message` 是同一份两块内容）。
 * 丢的是**展示**：
 *
 *   · `ChatView` 把 `placement === 'queued'` 的本地回显整条过滤掉（那本来能画缩略图）；
 *   · 排队期间唯一的展示面 `QueueDock` 只取 text 块 ⇒ **纯图片行渲染成空白行**。
 *
 * 还有一条真·永久丢失路径：排队行的「编辑」是**整份替换**（host 侧 `inbox.replace`
 * 只收文本），编辑一次就把图片换成纯文本。
 *
 * ## 本文件钉住
 *
 * 1. `queueAttachmentsOf` 正确拆出图片块 / 其它附件块（纯图片行必须被认出「有内容」）；
 * 2. 排队行渲染缩略图（`data-queue-attachment="image"`）与「N 个附件」占位；
 * 3. 含图片/附件的行**禁用编辑**并给出原因文案（关掉永久丢失那条路）。
 *
 * @module @corum/corum-ui-conversation/tests/queued-attachments
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// primitives 的运行时产物缺 `simple-icons`（官方把运行时依赖放进 devDependencies），
// 不替身整个文件 fail；本用例只关心「排队行画了什么」。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Icon = (): null => null
  return {
    IconCheckOutlineMedium: Icon,
    IconChevronDownOutlineMedium: Icon,
    IconChevronUpOutlineMedium: Icon,
    IconCloseOutlineMedium: Icon,
    IconEditOutlineMedium: Icon,
    IconQueueOutlineMedium: Icon,
    IconSendOutlineMedium: Icon,
    IconTrashOutlineMedium: Icon,
    Tooltip: ({ children }: { children?: unknown }) => children as never,
  }
})

const { queueAttachmentsOf } = await import('../src/client/queue/QueueDock.tsx')

const DOCK = readFileSync(join(import.meta.dirname, '../src/client/queue/QueueDock.tsx'), 'utf8')

/** 一条只有图片的排队消息（用户报障的形态）。 */
const IMAGE_ONLY = [{ type: 'image', attachment: { id: 'a1', mediaType: 'image/png' } }]
/** 图文混排。 */
const MIXED = [{ type: 'text', text: '看这张图' }, { type: 'image', attachment: { id: 'a2' } }]

describe('queueAttachmentsOf —— 排队行里的非文本块', () => {
  it('★ 纯图片行被认作「有内容」（修复前它渲染成空白）', () => {
    const seen = queueAttachmentsOf(IMAGE_ONLY)
    expect(seen.images).toHaveLength(1)
    expect(seen.hasNonText).toBe(true)
    expect(seen.files).toBe(0)
  })

  it('图文混排：图片照旧被拆出来', () => {
    const seen = queueAttachmentsOf(MIXED)
    expect(seen.images).toHaveLength(1)
    expect(seen.hasNonText).toBe(true)
  })

  it('纯文本行不算附件（编辑仍然可用）', () => {
    const seen = queueAttachmentsOf([{ type: 'text', text: '只是文字' }])
    expect(seen.hasNonText).toBe(false)
    expect(seen.images).toHaveLength(0)
  })

  it('文件块记进 files（不冒充图片）', () => {
    const seen = queueAttachmentsOf([{ type: 'file', receiptId: 'r1' }])
    expect(seen.images).toHaveLength(0)
    expect(seen.files).toBe(1)
    expect(seen.hasNonText).toBe(true)
  })
})

describe('QueueDock 渲染与编辑闸门', () => {
  it('★ 排队行渲染图片缩略图与附件占位（不再是空白行）', () => {
    expect(DOCK).toContain('data-queue-attachment="image"')
    expect(DOCK).toContain('data-queue-attachment="file"')
    expect(DOCK).toContain("t('queue.attachments'")
  })

  it('★ 含附件的行**仍可编辑**，但保存时把非文本块原样带回（不改附件、只改文字）', () => {
    // 2026-11-12 第二轮（用户实测：带图片的排队消息改不了字）：编辑重新放开，
    // 前提是保存时把图片/文件块原样带回去 —— 见 host 侧 carried 校验。
    expect(DOCK).not.toContain('queueAttachmentsOf(row.content).hasNonText}')
    expect(DOCK).toContain("filter(block => block.type !== 'text')")
    expect(DOCK).toContain("{ kind: 'edit', content: [...carried, { type: 'text', text: editing.text }] }")
  })

  it('★ 撤回会先还原附件再移除，且只在真丢时报「丢了几张」', () => {
    expect(DOCK).toContain('await restoreDraft(row.content)')
    expect(DOCK).toContain("t('queue.restoreAttachmentsPartial'")
    // 旧的「已从队列中一并移除」是假话（图片现在能还原），不许再出现。
    expect(DOCK).not.toContain('queue.removeAttachmentsDropped')
  })

  it('取图走 uiConversation 的 peek（命中缓存即同步出图，未命中退化成占位）', () => {
    expect(DOCK).toContain('peekImageUrl')
    expect(DOCK).toContain("inject: ['slots', 'conversation', 'sessions', 'uiConversation']")
  })
})
