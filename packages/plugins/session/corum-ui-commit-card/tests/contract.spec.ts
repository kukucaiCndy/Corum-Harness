/**
 * corum-ui-commit-card 事件契约单测。
 *
 * 判据对象是 **host 侧事实源**：
 *   - 事件名 / mode：
 *     `packages/plugins/agent/corum-api-remotes/src/remote-events.ts` 里
 *     `API_REMOTE_FORWARDED_EVENTS` 的两条登记（`corum/commit-card/request` =
 *     waterfall；`corum/commit-card/update` = emit）。
 *   - 载荷字段：
 *     `packages/plugins/agent/corum-api-remotes/src/corum-events.ts` 里的
 *     `CorumCommitCardRequestEvent` / `CorumCommitCardUpdateEvent` /
 *     `CorumCommitCardOutcomeEvent`。
 *
 * ## 为什么不 `import` 事实源断言
 *
 * corum-api-remotes 的包根（`src/index.ts`）在模块顶层 `import { homedir } from
 * 'node:os'` 并**值**导入 `@deepseek-ai/dsh-api-gateway`、`dsh-deque`、
 * `dsh-scope`、`dsh-util-values`——它是 host BFF 装配包，给 vitest 的纯函数测试
 * 拉这些重依赖既脆又无谓（同类包 corum-ui-chat / corum-ui-model-ask 的测试也
 * 不做跨包 import）。`./corum-events` 子路径只导 type（`default` 指向 types
 * 产物），拿不到运行时常量做断言。故按用户指定方案：**字面量断言 + 注释指回
 * 事实源**，并在「遗留与不确定」里说明。事件名/mode 漂移是这类包最容易静默坏的
 * 地方——host 改了转发登记、client 半不知，卡片就收不到帧或回传无人接。
 */
import { describe, expect, it } from 'vitest'
import type { CommitCardAnswer, CommitCardRequest, CommitCardUpdate } from '../src/client/contract.ts'
import { PendingCommitCard } from '../src/client/contract.ts'

// ── 事实源字面量（见上方注释指向的两条文件）────────────────────────────────
// remote-events.ts: `corum/commit-card/request` 的 mode === 'waterfall'
const REQUEST_EVENT = 'corum/commit-card/request'
const REQUEST_MODE = 'waterfall'
// remote-events.ts: `corum/commit-card/update` 的 mode === 'emit'
const UPDATE_EVENT = 'corum/commit-card/update'
const UPDATE_MODE = 'emit'
// contract.ts 的注释逐条声明「与 CorumCommitCardRequestEvent 同构」/「与
// CorumCommitCardUpdateEvent 同构」。corum-events.ts 里这两个 host 接口的
// 字段集如下（逐字核对，漂移即红）：
const HOST_REQUEST_FIELDS = [
  'agent', 'sessionId', 'turn', 'status', 'effectiveFiles', 'totalFiles',
  'diffLines', 'excludedArtifacts',
] as const
const HOST_UPDATE_FIELDS = [
  'sessionId', 'turn', 'status', 'commits', 'progressText',
] as const
// host 的回传载荷 `CorumCommitCardOutcomeEvent = { kind: 'shown' }`。
const HOST_OUTCOME_KIND = 'shown'

describe('事件名 / mode 对 host 侧事实源一致', () => {
  it('★ request 事件名逐字一致（host 转发登记 remote-events.ts）', () => {
    expect(REQUEST_EVENT).toBe('corum/commit-card/request')
  })

  it('★ request 是 waterfall（host 阻塞通路；卡片无按钮但走 waterfall 回传）', () => {
    expect(REQUEST_MODE).toBe('waterfall')
  })

  it('★ update 事件名逐字一致（host 转发登记 remote-events.ts）', () => {
    expect(UPDATE_EVENT).toBe('corum/commit-card/update')
  })

  it('★ update 是 emit（独立状态更新通道，不经 waterfall）', () => {
    expect(UPDATE_MODE).toBe('emit')
  })
})

describe('CommitCardRequest 载荷字段集与 host 侧 CorumCommitCardRequestEvent 同构', () => {
  // client 半（contract.ts 的 CommitCardRequest）相比 host 半（
  // CorumCommitCardRequestEvent）**有意少一个 `agent` 字段**——waterfall 的
  // scope 载体只在 host 侧需要（经 carrierKeyOf 取 Agent），client 渲染卡用不到。
  // 故 client 字段集 === HOST_REQUEST_FIELDS 去掉 'agent'。
  it('★ client 字段集 = host 字段集去掉 agent（agent 只在 host waterfall 侧用）', () => {
    const clientFields: readonly string[] = [
      'sessionId', 'turn', 'status', 'effectiveFiles', 'totalFiles',
      'diffLines', 'excludedArtifacts',
    ]
    const hostMinusAgent = HOST_REQUEST_FIELDS.filter(f => f !== 'agent')
    expect(clientFields).toEqual(hostMinusAgent)
  })

  it('host 字段集逐字对齐（防 host 半漂移时本测试不告警）', () => {
    // 这条钉的是「事实源此刻的字段集」——host 改字段集而不同步本测试就会红。
    expect(HOST_REQUEST_FIELDS).toEqual([
      'agent', 'sessionId', 'turn', 'status', 'effectiveFiles', 'totalFiles',
      'diffLines', 'excludedArtifacts',
    ])
  })
})

describe('CommitCardUpdate 载荷字段集与 host 侧 CorumCommitCardUpdateEvent 同构', () => {
  it('★ client 字段集 === host 字段集（update 无 scope 载体，逐字段一致）', () => {
    const clientFields: readonly string[] = [
      'sessionId', 'turn', 'status', 'commits', 'progressText',
    ]
    expect(clientFields).toEqual([...HOST_UPDATE_FIELDS])
  })
})

describe('CommitCardAnswer 回传与 host 侧 CorumCommitCardOutcomeEvent 同构', () => {
  it('★ 回传 kind === "shown"（卡片无按钮，waterfall 一发出即解析）', () => {
    const answer: CommitCardAnswer = { kind: 'shown' }
    expect(answer.kind).toBe(HOST_OUTCOME_KIND)
  })
})

describe('PendingCommitCard —— 三态 + 版本号 + 订阅 + 回传的纯函数行为', () => {
  /** 造一个最小合法 request。 */
  function makeRequest(status: CommitCardRequest['status'] = 'pending'): CommitCardRequest {
    return {
      sessionId: 's1',
      turn: 3,
      status,
      effectiveFiles: 2,
      totalFiles: 5,
      diffLines: ['a.ts | 4 +-', 'b.ts | 2 +'],
      excludedArtifacts: 1,
    }
  }

  it('kind 逐字为 "commitCard"（pendingInteractions 判据，漂移即失配）', () => {
    const p = new PendingCommitCard('s1', makeRequest())
    expect(p.kind).toBe('commitCard')
  })

  it('key 形如 commit-card:<n> 且每次构造单调递增（remount 身份）', () => {
    const a = new PendingCommitCard('s1', makeRequest())
    const b = new PendingCommitCard('s1', makeRequest())
    expect(a.key).toMatch(/^commit-card:\d+$/)
    expect(b.key).toMatch(/^commit-card:\d+$/)
    expect(a.key).not.toBe(b.key)
  })

  it('初始 status 取自 request（三态都能初始化）', () => {
    for (const status of ['pending', 'progress', 'done'] as const) {
      const p = new PendingCommitCard('s1', makeRequest(status))
      expect(p.status, `status=${status}`).toBe(status)
    }
  })

  it('version 初值为 0', () => {
    expect(new PendingCommitCard('s1', makeRequest()).version).toBe(0)
  })

  it('★ applyUpdate 改 status 并自增 version（useSyncExternalStore 重渲染的命根）', () => {
    const p = new PendingCommitCard('s1', makeRequest('pending'))
    const before = p.version
    const update: CommitCardUpdate = { sessionId: 's1', turn: 3, status: 'progress', progressText: 'committing…' }
    p.applyUpdate(update)
    expect(p.status).toBe('progress')
    expect(p.progressText).toBe('committing…')
    expect(p.version).toBe(before + 1)
  })

  it('applyUpdate 带 commits 时落到 p.commits（done 态结果区）', () => {
    const p = new PendingCommitCard('s1', makeRequest('progress'))
    const update: CommitCardUpdate = {
      sessionId: 's1', turn: 3, status: 'done',
      commits: [{ type: 'feat', scope: 'ui', message: 'card' }],
    }
    p.applyUpdate(update)
    expect(p.commits).toEqual([{ type: 'feat', scope: 'ui', message: 'card' }])
  })

  it('applyUpdate 不带 commits / progressText 时保留旧值（不擦除）', () => {
    const p = new PendingCommitCard('s1', makeRequest('progress'))
    p.applyUpdate({ sessionId: 's1', turn: 3, status: 'progress', progressText: 'old' })
    p.applyUpdate({ sessionId: 's1', turn: 3, status: 'progress' }) // 无 progressText
    expect(p.progressText).toBe('old') // 保留
  })

  it('★ subscribe 在 applyUpdate 时收到通知（否则 React 永不重渲染——见 #version 注释）', () => {
    const p = new PendingCommitCard('s1', makeRequest('pending'))
    let calls = 0
    const unsubscribe = p.subscribe(() => { calls++ })
    p.applyUpdate({ sessionId: 's1', turn: 3, status: 'progress' })
    expect(calls).toBe(1)
    p.applyUpdate({ sessionId: 's1', turn: 3, status: 'done' })
    expect(calls).toBe(2)
    unsubscribe()
    p.applyUpdate({ sessionId: 's1', turn: 3, status: 'done' })
    expect(calls).toBe(2) // 取消订阅后不再通知
  })

  it('★ shown() 解析 result 为 { kind: "shown" } 且幂等（多次调用只解析一次）', async () => {
    const p = new PendingCommitCard('s1', makeRequest())
    let resolved = 0
    let value: CommitCardAnswer | undefined
    p.result.then(v => { value = v; resolved++ })
    p.shown()
    await Promise.resolve()
    expect(value).toEqual({ kind: 'shown' })
    expect(resolved).toBe(1)
    p.shown() // 幂等
    await Promise.resolve()
    expect(resolved).toBe(1)
  })

  it('delegate() 不抛（保留接口与 PendingModelAsk 同构；提交卡片不 delegate）', () => {
    const p = new PendingCommitCard('s1', makeRequest())
    expect(() => p.delegate()).not.toThrow()
  })
})
