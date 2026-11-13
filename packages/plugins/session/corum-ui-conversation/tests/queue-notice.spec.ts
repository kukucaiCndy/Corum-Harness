/**
 * `next-turn` 队列里的**运行时通知**不能画成「用户排的队」。
 *
 * ## 事故形态
 *
 * 父 Agent idle 时，子 Agent 的结算账单（`source.kind === 'subagent-settled'`）以 user-role
 * 消息进 next-turn inbox（投递机制见 `corum-subagent/src/manager.ts` 的 `notifySettlement`）。
 * `QueueDock` 原先不看 `source`，一律渲染成**可编辑 / 可删除 / 可插话**的用户排队卡片：
 * 用户于是能"改"一条运行时账单，而它投递之后又变回正常通知行 —— 同一件事两种身份。
 *
 * ## 本文件钉住
 *
 * 1. `queueNoticeOf`：唤醒消息给出标题 key + 正文（`summary` 优先，否则首个文本块）；
 * 2. **负向控制**：用户排的队（`kind: 'user'` / 无 source / 未知 kind）仍返回 `undefined`，
 *    继续走原来的编辑 / 删除 / 插话分支；
 * 3. 源码断言：通知条分支在编辑分支**之前**提前返回，且通知条里没有任何操作按钮。
 *
 * @module @corum/corum-ui-conversation/tests/queue-notice
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// primitives 的运行时产物缺 `simple-icons`（官方把运行时依赖放进 devDependencies），
// 不替身整个文件 fail；本用例只关心「这一行被分成哪种形态」。
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

const { queueNoticeOf } = await import('../src/client/queue/QueueDock.tsx')

const DOCK = readFileSync(join(import.meta.dirname, '../src/client/queue/QueueDock.tsx'), 'utf8')

/** 结算账单的实际形态：带 summary 的 `subagent-settled`。 */
const SETTLED = {
  content: [{ type: 'text', text: 'Background subagent corum-task-child finished' }],
  source: { kind: 'subagent-settled', senderSessionId: 'corum-task-child', summary: 'completed · 用时 42s' },
}

/**
 * 通知条分支的源码片段（从 `const notice = …` 到用户行 `return (` 之前）。
 *
 * 定位用「用户行 return + 它的 `<li>`」这一整段字面量，普通操作按钮不会出现在其中间，
 * 所以片段边界是稳定的（改用户行内部不影响本片段的右端）。
 */
function noticeBranch(): string {
  const start = DOCK.indexOf('const notice = queueNoticeOf(row)')
  const end = DOCK.indexOf('            return (\n            <li key={row.id} className={css.row}>')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return DOCK.slice(start, end)
}

describe('queueNoticeOf — 哪一行是运行时通知', () => {
  it('★ subagent-settled 行给出通知条（标题 key + summary 正文）', () => {
    const notice = queueNoticeOf(SETTLED)
    expect(notice?.kind).toBe('subagent-settled')
    expect(notice?.titleKey).toBe('trigger.subagentSettled')
    expect(notice?.body).toBe('completed · 用时 42s')
  })

  it('没有 summary 时正文退回首个文本块', () => {
    const notice = queueNoticeOf({ content: SETTLED.content, source: { kind: 'agent-message' } })
    expect(notice?.titleKey).toBe('trigger.agentMessage')
    expect(notice?.body).toBe('Background subagent corum-task-child finished')
  })

  it('空 summary 视同缺失（不渲染空正文也不吞掉文本块）', () => {
    const notice = queueNoticeOf({ content: SETTLED.content, source: { kind: 'goal', summary: '' } })
    expect(notice?.body).toBe('Background subagent corum-task-child finished')
  })

  it('GitHub 来源的 webhook 用专属标题（与 durable 卡片同口径）', () => {
    expect(queueNoticeOf({ content: [], source: { kind: 'webhook', provider: 'github' } })?.titleKey)
      .toBe('trigger.github')
    expect(queueNoticeOf({ content: [], source: { kind: 'webhook' } })?.titleKey).toBe('trigger.webhook')
  })

  it('★ 负向控制：用户排的队不是通知（继续走用户卡片）', () => {
    expect(queueNoticeOf({ content: SETTLED.content, source: { kind: 'user', rpcId: 'r1' } })).toBeUndefined()
    expect(queueNoticeOf({ content: SETTLED.content })).toBeUndefined()
    expect(queueNoticeOf({ content: SETTLED.content, source: { kind: 'something-new' } })).toBeUndefined()
    expect(queueNoticeOf({ content: SETTLED.content, source: 'steer' })).toBeUndefined()
  })
})

describe('QueueDock 渲染分支', () => {
  it('★ 通知行渲染只读通知条（data-queue-notice + 标题 + 正文）', () => {
    expect(DOCK).toContain('data-queue-notice={notice.kind}')
    expect(DOCK).toContain('{t(notice.titleKey)}')
    expect(DOCK).toContain('{notice.body !== \'\' && <span className={css.noticeBody}>{notice.body}</span>}')
  })

  it('★ 通知条里没有编辑 / 删除 / 插话按钮，也不进编辑态', () => {
    const branch = noticeBranch()
    expect(branch).toContain('data-queue-notice')
    // 三种用户动作一个都不许出现（含编辑态输入框与保存/取消那一组）。
    expect(branch).not.toContain('css.action')
    expect(branch).not.toContain("t('queue.edit'")
    expect(branch).not.toContain("t('queue.remove'")
    expect(branch).not.toContain("t('queue.steer'")
    expect(branch).not.toContain('editing')
  })

  it('★ 通知条在用户行之前提前返回（用户行逻辑逐字不变）', () => {
    const start = DOCK.indexOf('const notice = queueNoticeOf(row)')
    const userRow = DOCK.indexOf("t('queue.edit')")
    expect(start).toBeGreaterThan(-1)
    expect(userRow).toBeGreaterThan(start)
    // 用户行原样保留：编辑 / 删除（连带还原）/ 插话三个动作都还在。
    expect(DOCK).toContain("t('queue.edit')")
    expect(DOCK).toContain("t('queue.remove')")
    expect(DOCK).toContain("t('queue.steer')")
    expect(DOCK).toContain('await restoreDraft(row.content)')
  })
})
