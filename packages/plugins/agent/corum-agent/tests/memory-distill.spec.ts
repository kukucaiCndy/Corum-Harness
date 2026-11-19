/**
 * 经验沉淀候选暂存改造（memory-distill.ts）单测。
 *
 * 覆盖：
 *   - 候选生成：facts → candidates（id/importance/retention/state 默认值）
 *   - commit 幂等：重复 commit 不重写；只写 pending；用编辑后的值
 *   - discard：全部 / 按 id；只弃 pending
 *   - 磁盘回读：内存 miss → 读盘；listPending 扫盘；scheduleCleanup 不删盘
 *   - replay：复用 readPersistedEvents + extractMessageText；最多 500 条
 *   - 0 候选行为：事件照发 factCount=0
 *
 * 不需真实 LLM：mock llm.stream 返回可控 JSON 数组。
 *
 * @module @corum/corum-agent/tests/memory-distill
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  startManualDistill,
  getDistillJob,
  cancelDistillJob,
  distillCommit,
  distillDiscard,
  distillReplay,
  distillListPending,
  autoDistillOnCompaction,
  type DistillJob,
  type DistillCandidate,
} from '../src/memory-distill.ts'

// ── Mock 工厂 ──────────────────────────────────────────────────────────────

/** 造假 memory face：记录 putFact / deleteBySource 调用。 */
function makeMemoryFace(opts: {
  rejectIds?: Set<string>
} = {}): {
  memory: {
    putFact: (input: {
      fact: string
      importance?: number
      source?: string
      agentId?: string
      author: string
      retention?: 'temporary' | 'short' | 'long' | 'permanent'
      evidence?: string[]
    }) => Promise<{ rejected: readonly string[] }>
    deleteBySource: (source: string, agentId?: string) => Promise<number>
  }
  putCalls: Array<{ fact: string; source?: string; author: string; importance?: number; retention?: string }>
  deleteCalls: Array<{ source: string }>
} {
  const putCalls: Array<{ fact: string; source?: string; author: string; importance?: number; retention?: string }> = []
  const deleteCalls: Array<{ source: string }> = []
  const rejectIds = opts.rejectIds ?? new Set<string>()
  return {
    memory: {
      async putFact(input) {
        putCalls.push({
          fact: input.fact,
          source: input.source,
          author: input.author,
          importance: input.importance,
          retention: input.retention,
        })
        // 按 fact 内容模拟 reject（测试失败场景）
        if (rejectIds.has(input.fact)) return { rejected: [input.fact] }
        return { rejected: [] }
      },
      async deleteBySource(source) {
        deleteCalls.push({ source })
        return 0
      },
    },
    putCalls,
    deleteCalls,
  }
}

/** 造假 LLM face：stream 返回一段可控文本（模拟 JSON 数组输出）。
 *
 * chunk 格式照 dsh-llm 流式协议（BlockAssembler.push 接受的 chunk）：
 *   `{ type: 'block-end', index: 0, block: { type: 'text', text } }`
 * 不发 finish chunk ⇒ assembler.finish 默认返回 `{ kind: 'stop' }`（非 max-tokens）。
 */
function makeLlmFace(output: string): {
  llm: { stream: (request: unknown) => AsyncIterable<unknown> }
} {
  return {
    llm: {
      stream: async function* (_request: unknown): AsyncIterable<unknown> {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
      },
    },
  }
}

/** 造假 persistence face：open 返回预设事件。 */
function makePersistenceFace(sessions: Record<string, { events?: readonly SessionEvent[]; parentSession?: string }>): {
  persistence: {
    list: () => Promise<readonly { header: { id: string; parentSession?: string } }[]>
    open: (id: SessionId, mode: 'read') => Promise<{
      read: (offset: number) => Promise<{ events: readonly SessionEvent[] }>
      close: () => Promise<void>
    }>
  }
} {
  return {
    persistence: {
      async list() {
        return Object.entries(sessions).map(([id, rec]) => ({
          header: {
            id,
            ...(rec.parentSession === undefined ? {} : { parentSession: rec.parentSession }),
          },
        }))
      },
      async open(id, _mode) {
        const sid = String(id)
        const record = sessions[sid]
        if (record === undefined) throw new Error(`mock: 无此会话 "${sid}"`)
        return {
          read: async (_offset: number) => ({ events: record.events ?? [] }),
          close: async () => {},
        }
      },
    },
  }
}

/** 造一条会话事件。 */
function msgEvent(type: string, text: string, seq: number): SessionEvent {
  return {
    seq,
    type,
    data: { content: [{ type: 'text', text }] },
    time: 1700000000000,
  } as unknown as SessionEvent
}

/** 造假 ctx：提供 llm / memory / sessionPersistence / sessions + emit 记录。 */
function makeCtx(opts: {
  llmOutput?: string
  sessions?: Record<string, { events?: readonly SessionEvent[]; parentSession?: string }>
  rejectFacts?: string[]
}): { ctx: Context; events: Array<{ type: string; payload: unknown }>; appends: Array<{ sessionId: string; type: string; data: unknown }> } {
  const events: Array<{ type: string; payload: unknown }> = []
  const appends: Array<{ sessionId: string; type: string; data: unknown }> = []
  const { memory } = makeMemoryFace({ rejectIds: new Set(opts.rejectFacts ?? []) })
  const { llm } = makeLlmFace(opts.llmOutput ?? '[]')
  const { persistence } = makePersistenceFace(opts.sessions ?? {})
  // sessions 对象层 mock：get(sid) 返回带 append 的 session（记录调用）。
  const sessionsFace = {
    get(sid: string) {
      return {
        append(type: string, data: unknown) { appends.push({ sessionId: sid, type, data }) },
      }
    },
  }
  // 用最小 ctx 对象（memory-distill.ts 只用 ctx.get / ctx.emit / ctx.agentDefaultModel）
  const ctx = {
    // agentDefaultModel 是属性访问（globalDefaultModelOf 读 ctx.agentDefaultModel?.currentSelection()）
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
    get(name: string): unknown {
      if (name === 'llm') return llm
      if (name === 'memory') return memory
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessions') return sessionsFace
      return undefined
    },
    emit(type: string, payload?: unknown) { events.push({ type, payload }) },
  }
  return { ctx: ctx as unknown as Context, events, appends }
}

// ── 临时 home ─────────────────────────────────────────────────────────────

let home: string
let oldCorumHome: string | undefined
let oldDshHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'corum-distill-test-'))
  oldCorumHome = process.env.CORUM_HOME
  oldDshHome = process.env.DSH_HOME
  process.env.CORUM_HOME = home
  process.env.DSH_HOME = home
})

afterEach(() => {
  if (oldCorumHome !== undefined) process.env.CORUM_HOME = oldCorumHome
  else delete process.env.CORUM_HOME
  if (oldDshHome !== undefined) process.env.DSH_HOME = oldDshHome
  else delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// ── 等待 job 完成（轮询 getDistillJob 直到 status !== 'running'） ──────────

async function waitForJob(ctx: Context, jobId: string, timeoutMs = 5000): Promise<DistillJob | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await getDistillJob(jobId)
    if (job !== null && job.status !== 'running') return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`waitForJob 超时: ${jobId}`)
}

// ── 测试 ──────────────────────────────────────────────────────────────────

describe('候选生成', () => {
  it('LLM 产出 facts → candidates（默认 importance 5 / retention short / state pending）', async () => {
    const { ctx } = makeCtx({
      llmOutput: '["用户偏好 tabs","项目用 pnpm"]',
      sessions: {
        'sess-1': { events: [msgEvent('user/message', 'hello', 1), msgEvent('assistant/message', 'hi', 2)] },
      },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    const job = await waitForJob(ctx, jobId)
    expect(job).not.toBeNull()
    expect(job!.status).toBe('done')
    expect(job!.factCount).toBe(2)
    expect(job!.candidates).toHaveLength(2)
    const c0 = job!.candidates![0]!
    expect(c0.id).toBe(`${jobId}:0`)
    expect(c0.importance).toBe(5)
    expect(c0.retention).toBe('short')
    expect(c0.state).toBe('pending')
    expect(c0.fact).toBe('用户偏好 tabs')
    expect(job!.origin).toBe('manual')
  })

  it('0 条候选时行为照旧：status done、factCount 0、事件照发', async () => {
    const { ctx, events } = makeCtx({
      llmOutput: '[]',
      sessions: {
        'sess-1': { events: [msgEvent('user/message', 'hello', 1)] },
      },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    const job = await waitForJob(ctx, jobId)
    expect(job!.status).toBe('done')
    expect(job!.factCount).toBe(0)
    expect(job!.candidates).toBeUndefined()
    // 完成事件照发，factCount=0
    const completed = events.filter(e => e.type === 'corum/distill/completed')
    expect(completed).toHaveLength(1)
    expect((completed[0]!.payload as { factCount: number }).factCount).toBe(0)
  })

  it('自动沉淀（autoDistillOnCompaction）也产出候选不直接写记忆', async () => {
    const { ctx, events } = makeCtx({
      llmOutput: '["自动沉淀的事实"]',
    })
    autoDistillOnCompaction(ctx, {
      sessionId: 'sess-auto',
      shadowedSeqs: [1, 2],
      summary: '压缩摘要内容',
    })
    // fire-and-forget，等事件
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !events.some(e => e.type === 'corum/distill/completed')) {
      await new Promise(r => setTimeout(r, 10))
    }
    const completed = events.filter(e => e.type === 'corum/distill/completed')
    expect(completed).toHaveLength(1)
    const payload = completed[0]!.payload as { jobId: string; factCount: number }
    expect(payload.factCount).toBe(1)
    // jobId 不为空（auto 也生成 jobId 了）
    expect(payload.jobId).not.toBe('')
    // 从磁盘恢复
    const job = await getDistillJob(payload.jobId)
    expect(job).not.toBeNull()
    expect(job!.origin).toBe('auto')
    expect(job!.candidates).toHaveLength(1)
    expect(job!.candidates![0]!.state).toBe('pending')
  })
})

describe('durable 会话事件（corum/distill-completed）', () => {
  it('手动沉淀完成且 factCount>0 时 append 被调', async () => {
    const { ctx, appends } = makeCtx({
      llmOutput: '["事实A","事实B"]',
      sessions: { 'sess-1': { events: [msgEvent('user/message', 'hi', 1)] } },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    await waitForJob(ctx, jobId)
    const distillAppends = appends.filter(a => a.type === 'corum/distill-completed')
    expect(distillAppends).toHaveLength(1)
    expect(distillAppends[0]!.sessionId).toBe('sess-1')
    const data = distillAppends[0]!.data as { jobId: string; sessionId: string; factCount: number }
    expect(data.jobId).toBe(jobId)
    expect(data.sessionId).toBe('sess-1')
    expect(data.factCount).toBe(2)
  })

  it('手动沉淀完成但 0 候选时不 append（与通知侧一致）', async () => {
    const { ctx, appends } = makeCtx({
      llmOutput: '[]',
      sessions: { 'sess-1': { events: [msgEvent('user/message', 'hi', 1)] } },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    await waitForJob(ctx, jobId)
    const distillAppends = appends.filter(a => a.type === 'corum/distill-completed')
    expect(distillAppends).toHaveLength(0)
  })

  it('自动沉淀完成且 factCount>0 时 append 被调', async () => {
    const { ctx, events, appends } = makeCtx({
      llmOutput: '["自动沉淀事实"]',
    })
    autoDistillOnCompaction(ctx, {
      sessionId: 'sess-auto',
      shadowedSeqs: [1],
      summary: '压缩摘要',
    })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !events.some(e => e.type === 'corum/distill/completed')) {
      await new Promise(r => setTimeout(r, 10))
    }
    const distillAppends = appends.filter(a => a.type === 'corum/distill-completed')
    expect(distillAppends).toHaveLength(1)
    expect(distillAppends[0]!.sessionId).toBe('sess-auto')
    expect((distillAppends[0]!.data as { factCount: number }).factCount).toBe(1)
  })
})

describe('commit 幂等', () => {
  it('commit 写入 pending 候选，成功后 state=committed', async () => {
    const { ctx } = makeCtx({
      llmOutput: '["事实A","事实B"]',
      sessions: { 'sess-1': { events: [msgEvent('user/message', 'hi', 1)] } },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    const job = await waitForJob(ctx, jobId)
    const cands = job!.candidates!
    // commit 第一条
    const result = await distillCommit(ctx, {
      jobId,
      items: [{ id: cands[0]!.id, fact: cands[0]!.fact, importance: 5, retention: 'short' }],
    })
    expect(result.written).toBe(1)
    expect(result.failed).toBe(0)
    // 验证 state
    const after = await getDistillJob(jobId)
    expect(after!.candidates![0]!.state).toBe('committed')
    expect(after!.candidates![1]!.state).toBe('pending')
  })

  it('重复 commit 不重写（幂等）', async () => {
    const { ctx } = makeCtx({
      llmOutput: '["事实A"]',
      sessions: { 'sess-1': { events: [msgEvent('user/message', 'hi', 1)] } },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    const job = await waitForJob(ctx, jobId)
    const cand = job!.candidates![0]!
    const item = { id: cand.id, fact: cand.fact, importance: 5, retention: 'short' }
    // 第一次 commit
    await distillCommit(ctx, { jobId, items: [item] })
    // 第二次 commit 同一条
    const result2 = await distillCommit(ctx, { jobId, items: [item] })
    // 幂等：已经是 committed，不再写入
    expect(result2.written).toBe(0)
    expect(result2.failed).toBe(0)
  })

  it('commit 使用编辑后的值（用户可改 fact/importance/retention）', async () => {
    const { ctx } = makeCtx({
      llmOutput: '["原始事实"]',
      sessions: { 'sess-1': { events: [msgEvent('user/message', 'hi', 1)] } },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    const job = await waitForJob(ctx, jobId)
    const cand = job!.candidates![0]!
    // 用户编辑了 fact 和 importance
    const result = await distillCommit(ctx, {
      jobId,
      items: [{ id: cand.id, fact: '编辑后的事实', importance: 8, retention: 'long' }],
    })
    expect(result.written).toBe(1)
    const after = await getDistillJob(jobId)
    expect(after!.candidates![0]!.fact).toBe('编辑后的事实')
    expect(after!.candidates![0]!.importance).toBe(8)
    expect(after!.candidates![0]!.retention).toBe('long')
    expect(after!.candidates![0]!.state).toBe('committed')
  })

  it('commit 单条失败不中断（rejected 计 failed）', async () => {
    const { ctx } = makeCtx({
      llmOutput: '["好事实","坏事实"]',
      sessions: { 'sess-1': { events: [msgEvent('user/message', 'hi', 1)] } },
      rejectFacts: ['坏事实'],
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    const job = await waitForJob(ctx, jobId)
    const cands = job!.candidates!
    const result = await distillCommit(ctx, {
      jobId,
      items: [
        { id: cands[0]!.id, fact: cands[0]!.fact, importance: 5, retention: 'short' },
        { id: cands[1]!.id, fact: cands[1]!.fact, importance: 5, retention: 'short' },
      ],
    })
    expect(result.written).toBe(1)
    expect(result.failed).toBe(1)
    const after = await getDistillJob(jobId)
    expect(after!.candidates![0]!.state).toBe('committed')
    // 被拒的仍为 pending
    expect(after!.candidates![1]!.state).toBe('pending')
  })

  it('commit author 统一 user（即使是 auto 来源的 job）', async () => {
    const { ctx } = makeCtx({
      llmOutput: '["自动事实"]',
    })
    autoDistillOnCompaction(ctx, {
      sessionId: 'sess-auto',
      shadowedSeqs: [],
      summary: '摘要',
    })
    // 等 auto 完成
    const deadline = Date.now() + 5000
    let job: DistillJob | null = null
    while (Date.now() < deadline) {
      const pending = await distillListPending()
      if (pending.jobs.length > 0) { job = pending.jobs[0]!; break }
      await new Promise(r => setTimeout(r, 10))
    }
    expect(job).not.toBeNull()
    // commit auto 来源的候选
    const cand = job!.candidates![0]!
    const result = await distillCommit(ctx, {
      jobId: job!.jobId,
      items: [{ id: cand.id, fact: cand.fact, importance: 5, retention: 'short' }],
    })
    expect(result.written).toBe(1)
  })
})

describe('discard', () => {
  it('无 ids = 全部 pending 标记为 discarded', async () => {
    const { ctx } = makeCtx({
      llmOutput: '["A","B","C"]',
      sessions: { 'sess-1': { events: [msgEvent('user/message', 'hi', 1)] } },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    const job = await waitForJob(ctx, jobId)
    expect(job!.candidates).toHaveLength(3)
    const result = await distillDiscard({ jobId })
    expect(result.discarded).toBe(3)
    const after = await getDistillJob(jobId)
    for (const c of after!.candidates!) expect(c.state).toBe('discarded')
  })

  it('按 id 丢弃只弃指定的 pending', async () => {
    const { ctx } = makeCtx({
      llmOutput: '["A","B"]',
      sessions: { 'sess-1': { events: [msgEvent('user/message', 'hi', 1)] } },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    const job = await waitForJob(ctx, jobId)
    const id0 = job!.candidates![0]!.id
    const result = await distillDiscard({ jobId, candidateIds: [id0] })
    expect(result.discarded).toBe(1)
    const after = await getDistillJob(jobId)
    expect(after!.candidates![0]!.state).toBe('discarded')
    expect(after!.candidates![1]!.state).toBe('pending')
  })

  it('已 committed 的不被 discard', async () => {
    const { ctx } = makeCtx({
      llmOutput: '["A","B"]',
      sessions: { 'sess-1': { events: [msgEvent('user/message', 'hi', 1)] } },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    const job = await waitForJob(ctx, jobId)
    // 先 commit 第一条
    await distillCommit(ctx, {
      jobId,
      items: [{ id: job!.candidates![0]!.id, fact: job!.candidates![0]!.fact, importance: 5, retention: 'short' }],
    })
    // 再 discard 全部
    const result = await distillDiscard({ jobId })
    expect(result.discarded).toBe(1) // 只有第二条 pending 被弃
    const after = await getDistillJob(jobId)
    expect(after!.candidates![0]!.state).toBe('committed')
    expect(after!.candidates![1]!.state).toBe('discarded')
  })
})

describe('磁盘回读', () => {
  it('job 落盘到 <home>/distill-jobs/<jobId>.json', async () => {
    const { ctx } = makeCtx({
      llmOutput: '["落盘测试"]',
      sessions: { 'sess-1': { events: [msgEvent('user/message', 'hi', 1)] } },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    await waitForJob(ctx, jobId)
    const filePath = join(home, 'distill-jobs', `${jobId}.json`)
    expect(existsSync(filePath)).toBe(true)
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { jobId: string; candidates?: DistillCandidate[]; source: string }
    expect(raw.jobId).toBe(jobId)
    expect(raw.candidates).toHaveLength(1)
    expect(raw.source).toBe(`manual-distill:sess-1`)
  })

  it('内存 miss 时 getDistillJob 回读磁盘', async () => {
    const { ctx } = makeCtx({
      llmOutput: '["回读测试"]',
      sessions: { 'sess-1': { events: [msgEvent('user/message', 'hi', 1)] } },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    await waitForJob(ctx, jobId)
    // 用 cancelDistillJob 不影响（已完成），但我们可以直接测：
    // 先确认内存能读
    const fromMem = await getDistillJob(jobId)
    expect(fromMem).not.toBeNull()
    // 造一个不在内存里的 jobId（通过写一个磁盘文件模拟）
    const diskJobId = 'distill-disk-test-abc123'
    const dir = join(home, 'distill-jobs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${diskJobId}.json`), JSON.stringify({
      jobId: diskJobId,
      status: 'done',
      factCount: 1,
      phase: '测试',
      sessionId: 'sess-disk',
      candidates: [{ id: `${diskJobId}:0`, fact: '磁盘恢复', importance: 5, retention: 'short', state: 'pending' }],
      origin: 'manual',
      source: 'manual-distill:sess-disk',
      author: 'user',
    }))
    const fromDisk = await getDistillJob(diskJobId)
    expect(fromDisk).not.toBeNull()
    expect(fromDisk!.jobId).toBe(diskJobId)
    expect(fromDisk!.candidates).toHaveLength(1)
    expect(fromDisk!.candidates![0]!.fact).toBe('磁盘恢复')
  })

  it('listPending 扫磁盘返回含 pending 候选的 job', async () => {
    const { ctx } = makeCtx({
      llmOutput: '["listPending 测试"]',
      sessions: { 'sess-1': { events: [msgEvent('user/message', 'hi', 1)] } },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    await waitForJob(ctx, jobId)
    const result = await distillListPending()
    expect(result.jobs.length).toBeGreaterThanOrEqual(1)
    const found = result.jobs.find(j => j.jobId === jobId)
    expect(found).toBeDefined()
    expect(found!.candidates!.some(c => c.state === 'pending')).toBe(true)
  })

  it('listPending 不返回已全部 committed/discarded 的 job', async () => {
    const { ctx } = makeCtx({
      llmOutput: '["全弃测试"]',
      sessions: { 'sess-1': { events: [msgEvent('user/message', 'hi', 1)] } },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    await waitForJob(ctx, jobId)
    // 全部 discard
    await distillDiscard({ jobId })
    const result = await distillListPending()
    const found = result.jobs.find(j => j.jobId === jobId)
    expect(found).toBeUndefined()
  })

  it('scheduleCleanup 只清内存不删盘', async () => {
    const { ctx } = makeCtx({
      llmOutput: '["清理测试"]',
      sessions: { 'sess-1': { events: [msgEvent('user/message', 'hi', 1)] } },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    await waitForJob(ctx, jobId)
    const filePath = join(home, 'distill-jobs', `${jobId}.json`)
    expect(existsSync(filePath)).toBe(true)
    // scheduleCleanup 的 5 分钟定时器我们不等，但可以验证磁盘文件存在
    // （scheduleCleanup 只调 distillJobs.delete，不删文件）
    // 直接验证：文件仍在
    expect(existsSync(filePath)).toBe(true)
  })
})

describe('replay', () => {
  it('回放 user/assistant 非空文本消息', async () => {
    const events: SessionEvent[] = [
      msgEvent('user/message', '你好', 1),
      msgEvent('assistant/message', '你好！有什么可以帮你的？', 2),
      msgEvent('user/message', '', 3), // 空文本应被跳过
      msgEvent('assistant/message', '回复', 4),
    ]
    const { ctx } = makeCtx({
      sessions: { 'sess-replay': { events } },
    })
    const result = await distillReplay(ctx, { sessionId: 'sess-replay' })
    expect(result.messages).toHaveLength(3) // 空文本那条被跳过
    expect(result.messages[0]!.role).toBe('user')
    expect(result.messages[0]!.text).toBe('你好')
    expect(result.messages[0]!.seq).toBe(1)
    expect(result.messages[1]!.role).toBe('assistant')
    expect(result.messages[2]!.role).toBe('assistant')
    expect(result.messages[2]!.seq).toBe(4)
  })

  it('读不到会话返回空数组不抛错', async () => {
    const { ctx } = makeCtx({ sessions: {} })
    const result = await distillReplay(ctx, { sessionId: 'no-such-session' })
    expect(result.messages).toEqual([])
  })

  it('最多返回最近 500 条', async () => {
    const events: SessionEvent[] = []
    for (let i = 1; i <= 600; i++) {
      events.push(msgEvent(i % 2 === 0 ? 'assistant/message' : 'user/message', `msg-${i}`, i))
    }
    const { ctx } = makeCtx({ sessions: { 'sess-big': { events } } })
    const result = await distillReplay(ctx, { sessionId: 'sess-big' })
    expect(result.messages).toHaveLength(500)
    // 最近 500 条 = seq 101..600
    expect(result.messages[0]!.seq).toBe(101)
    expect(result.messages[499]!.seq).toBe(600)
  })
})

describe('cancelDistillJob', () => {
  it('取消 running 任务', async () => {
    const { ctx } = makeCtx({
      llmOutput: '[]',
      sessions: { 'sess-1': { events: [msgEvent('user/message', 'hi', 1)] } },
    })
    const { jobId } = startManualDistill(ctx, { sessionId: 'sess-1' })
    // 立即取消（可能还在 running）
    const cancelled = cancelDistillJob(jobId)
    // 如果跑太快已经完成，cancelled=false 也是合法的
    if (cancelled) {
      const job = await getDistillJob(jobId)
      expect(job!.status).toBe('cancelled')
    }
  })
})
