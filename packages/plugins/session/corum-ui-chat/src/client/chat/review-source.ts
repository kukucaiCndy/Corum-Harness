// fork（corum）：Review 卡的数据源 —— **git 影子仓库版**（2026-09-11 重构）。
//
// 旧实现从会话事件流（tool/call 的 oldString/newString）反推「改动前」，有三个绕
// 不过去的缺陷：整文件覆盖（`write`）的旧内容不可知；反推要求唯一匹配、会随外部
// 改动漂移；增删行数只能自写 LCS 近似。现在全部交给 host 的 `corumReview` 影子
// git 仓库（见 packages/desktop/src/host/corum-review.ts）：
//
//   本模块只做三件事：订阅刷新信号 → 拉 `snapshot` RPC → 转成卡片要的形状。
//   撤销/查看改动前/单文件保留 也都是一次 RPC，没有任何本地重算。
//
// 保留的客户端内状态只有一个：**单文件「保留」= 「我已看过」**（用户定调
// 2026-09-11）。它纯客户端、仅本轮有效 —— 轮次变化（roundIndex 变了）就清空。

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { subagentChildSubscribe } from '../chat-runtime.ts'
import { emptyReviewChanges, type ReviewChanges } from './review-changes.ts'

/** Review 卡对外面：当前聚合 + 动作 + 单文件原文（供看 diff）。 */
export interface ReviewSource extends ObservableSnapshot<ReviewChanges> {
  recoveries: ObservableSnapshot<readonly ReviewRecovery[]>
  restoreRollback(record: ReviewRecovery): Promise<RevertAllResult>
  /** 「全部撤销」：把本轮所有改动回退到改前（含子会话归属的文件，按归属路由）。 */
  revertAll(): Promise<RevertAllResult>
  /** 「全部保留」：本轮改动就是工作区现状，不需要做什么 —— 清空「已看过」标记即可。 */
  keepAll(): void
  /** 「保留此文件」：标记为已看过（仅本轮），它随即从卡片消失。 */
  keepFile(path: string): void
  /** 「撤销此文件」：只回退这一个文件（按归属会话路由：子会话文件撤销子会话轮次）。 */
  revertFile(path: string): Promise<RevertAllResult>
  /** 取某文件「改动前」的内容，供编辑器开 diff（按归属会话路由）。 */
  fileBefore(path: string): Promise<ReconstructResult>
}

export interface ReviewRecovery { id: string; groupId?: string; sessionId: string; workspace: string; createdAt: number; paths: string[] }

/** 撤销结果（沿用旧形状，UI 不用改）。 */
export interface RevertAllResult {
  readonly ok: boolean
  readonly reverted: number
  readonly failed: number
  readonly skipped: number
  readonly message?: string
}

/** 取「改动前」内容的结果（沿用旧形状）。 */
export interface ReconstructResult {
  created?: boolean
  ok: boolean
  content: string
  /** 是否完整（git 版恒为 true：内容是精确的）。 */
  complete: boolean
  path: string
  note?: string | undefined
  message?: string | undefined
}

/**
 * 审阅快照刷新的最小间隔（ms）：事件频率远高于「人眼能看出变化」的频率，而每次刷新是父 + 每个子会话
 * 各一次 RPC ⇒ 必须节流（实测未节流时一个回合 599 次、最慢 2.7 s）。
 */
const REVIEW_REFRESH_THROTTLE_MS = 500

/** host `corumReview/snapshot` 的响应。 */
interface SnapshotValue {
  workspace: string | null
  roundIndex: number
  files: { path: string; added: number; removed: number; hash: string; status?: 'content' | 'absent' | 'unavailable' | 'missing' }[]
}

/**
 * 聚合后的单文件条目（内部投影）：归属会话（= pre-image/撤销的 RPC 路由目标）
 * 跟着文件走——子会话文件打开 diff 时用**子会话轮次**的 pre-image，否则会复现
 * 「父轮次没抓过这个文件 → unavailable 死点」（问题 2 实现要点）。
 */
interface AggregatedFile {
  path: string
  added: number
  removed: number
  hash: string
  /** 该条目来自的会话（父会话自身或某个子会话）。 */
  owner: string
  /** 子会话归属时的委托标签（卡片标注「子 Agent」用）。 */
  ownerLabel?: string
}

/** 把 RPC 信封拆开；失败返回 null 并打印原因。 */
function unwrap<T>(response: { ok: boolean; value?: T; error?: { message?: string } }): T | null {
  if (response.ok && response.value !== undefined) return response.value
  console.warn('[ui-chat] corumReview rpc failed:', response.error?.message)
  return null
}

/**
 * 创建 Review 数据源。
 * @param sessionId - 会话 id（host 用它索引活轮次）。
 * @param connection - RPC 句柄。
 * @param eventSource - 会话事件窗；仅用作**刷新信号**（写入会推进事件序列号）。
 */
export function createReviewSource(
  sessionId: string,
  connection: ConnectionHandle,
  eventSource: SessionEventSource,
): ReviewSource {
  let current: ReviewChanges = emptyReviewChanges()
  let roundIndex = 0
  /**
   * 单文件「已看过」标记：`path → 当时的内容 blob 哈希`。
   *
   * 记**内容哈希**而不是裸 path（C1）：文件被再改一次后哈希变了，标记自然失效、
   * 条目重新出现。只按 path 记的话，用户「保留」过一个文件之后它再被改也一直隐藏。
   * 轮次变化（roundIndex 变）时整体清空 —— 用户定调：标记仅本轮有效。
   */
  let seen = new Map<string, string>()
  const listeners = new Set<() => void>()
  let recoveries: readonly ReviewRecovery[] = []
  const recoveryListeners = new Set<() => void>()
  let inFlight = false
  let again = false
  /**
   * 当前聚合里每个文件归属的会话（pre-image/撤销的 RPC 路由表，问题 2）。
   * path → owner sessionId。refresh 每次重建；fileBefore/revertFile 按它路由到
   * 子会话轮次，避免「父轮次没抓过这个文件 → unavailable 死点」。
   */
  let owners = new Map<string, string>()
  /**
   * 本父会话已观测到的子会话（childSessionId → 委托标签）。
   * 数据源 = 'corum/subagent/child' 广播帧（host spawn 那一刻按父会话 id 发出，
   * 帧带 parentSessionId，本模块按它过滤）。帧不重放——页面刷新后新建的
   * ReviewSource 只能聚合「刷新之后 spawn 的子会话」，属已知边界（卡片生命周期
   * 内 spawn 的子 Agent 都在）。
   */
  const childSessions = new Map<string, string>()

  const call = async <T,>(method: string, args: Record<string, unknown>): Promise<T | null> => {
    try {
      const response = await connection.rpc.call('/api', method, { args }) as
        { ok: boolean; value?: T; error?: { message?: string } }
      return unwrap<T>(response)
    } catch (error) {
      console.warn(`[ui-chat] ${method} threw:`, error)
      return null
    }
  }

  const refreshRecoveries = async (): Promise<void> => {
    const value = await call<ReviewRecovery[]>('corumReview/recoveries', { sessionId })
    if (!Array.isArray(value)) return
    // 重启后子会话广播不会重放，持久化记录仍提供正确的恢复/审阅归属。
    for (const record of value) if (record.sessionId !== sessionId && !childSessions.has(record.sessionId)) childSessions.set(record.sessionId, record.sessionId)
    if (JSON.stringify(value) === JSON.stringify(recoveries)) return
    recoveries = value
    for (const listener of recoveryListeners) listener()
  }

  /** 拉一次快照并转成卡片形状（问题 2：父会话轮次 ∪ 所有子会话轮次去重并集）。 */
  const refresh = async (): Promise<void> => {
    if (inFlight) { again = true; return }
    inFlight = true
    try {
      const value = await call<SnapshotValue>('corumReview/snapshot', { sessionId })
      if (value === null) return
      // 轮次变了 → 「已看过」标记作废（用户定调：仅本轮有效）。
      if (value.roundIndex !== roundIndex) { roundIndex = value.roundIndex; seen = new Map() }
      // 子会话快照（并集口径）：每个子会话一次 snapshot RPC；失败（会话已 dispose、
      // 轮次已关）按空集降级，不阻断父侧。pre-image 归属跟文件走（owner = 子会话 id）。
      const childSnaps = await Promise.all(
        [...childSessions.entries()].map(async ([childId, label]) => ({
          childId,
          label,
          snap: await call<SnapshotValue>('corumReview/snapshot', { sessionId: childId }),
        })),
      )
      const byPath = new Map<string, AggregatedFile>()
      for (const file of value.files) {
        byPath.set(file.path, { path: file.path, added: file.added, removed: file.removed, hash: file.hash, owner: sessionId })
      }
      // 子会话条目**覆盖**同路径父侧条目：同一文件父子都碰过时，最新（子会话）的
      // 改动行数与 pre-image 更贴近用户想审的那次改动（问题 2 口径）。
      for (const { childId, label, snap } of childSnaps) {
        if (snap === null) continue
        for (const file of snap.files) {
          byPath.set(file.path, {
            path: file.path,
            added: file.added,
            removed: file.removed,
            hash: file.hash,
            owner: childId,
            ownerLabel: label,
          })
        }
      }
      owners = new Map([...byPath.values()].map(f => [f.path, f.owner]))
      const files = [...byPath.values()]
        .filter(file => seen.get(file.path) !== file.hash)
        .map(file => ({
          path: file.path,
          added: file.added,
          removed: file.removed,
          // hash 必须带出来（keepAll/keepFile 依赖它做内容级「已看过」判定），
          // 否则投影后的对象里 hash 恒为 undefined → seen 永远写不进 → 文件每次 refresh 重现。
          hash: file.hash,
          // git 版不需要逐条 op（旧实现用它做反推与统计），留空数组保持形状兼容。
          ops: [],
          // 子会话归属标注（ReviewCard 显示「子 Agent」chip 用）。
          ...file.ownerLabel === undefined ? {} : { fromSubagent: file.ownerLabel },
        }))
      const next: ReviewChanges = {
        totalAdded: files.reduce((sum, f) => sum + f.added, 0),
        totalRemoved: files.reduce((sum, f) => sum + f.removed, 0),
        files,
        revertOrder: [],
      }
      // 内容没变就不通知（避免每次事件都重渲染卡片）。
      const same = next.totalAdded === current.totalAdded
        && next.totalRemoved === current.totalRemoved
        && next.files.length === current.files.length
        && next.files.every((f, i) => f.path === current.files[i]?.path
          && f.added === current.files[i]?.added
          && f.removed === current.files[i]?.removed
          && f.hash === current.files[i]?.hash)
      if (same) return
      current = next
      for (const listener of listeners) listener()
    } finally {
      inFlight = false
      if (again) { again = false; void refresh() }
    }
  }

  // 事件窗每次发布都重拉（写入会推进 seq）。这里刻意**不做节流窗口**：写入频率
  // 受 inFlight+again 合并（并发去重 + 尾随一次），足够挡住密集写入。
  /**
   * 刷新节流（2026-09-28 实测，`docs/PENDING-ui-lag-multiround.md` §2.16）：事件在一次回合里会成百上千次
   * 到达，而每次 `refresh` 都是**重活**——父会话 1 次 + **每个子会话各 1 次** `corumReview/snapshot`
   * （子会话并发 3 个时＝4 次）。实测一个带 3 个子会话的回合打了 **599 次** snapshot（最慢 2.7 s），
   * 主机与主线程被它占满。尾沿节流把频率压到 ≤2 次/秒，且保证最后一次变更仍会被拉到（不会丢尾）。
   */
  let lastRefreshAt = 0
  let throttled: ReturnType<typeof setTimeout> | undefined
  const scheduleRefresh = (): void => {
    const wait = REVIEW_REFRESH_THROTTLE_MS - (Date.now() - lastRefreshAt)
    if (wait <= 0) {
      lastRefreshAt = Date.now()
      void refresh()
      return
    }
    if (throttled !== undefined) return
    throttled = setTimeout(() => {
      throttled = undefined
      lastRefreshAt = Date.now()
      void refresh()
    }, wait)
  }
  eventSource.subscribe(scheduleRefresh)
  // 问题 2：子 Agent spawn 帧到达即记账并补拉一次（子会话首帧可能早于任何写入，
  // 而它的改动要等终态才进影子仓库——帧驱动刷新保证卡片能及时聚合）。
  subagentChildSubscribe((frame) => {
    if (frame.parentSessionId !== sessionId) return
    if (childSessions.get(frame.childSessionId) === frame.label) return
    childSessions.set(frame.childSessionId, frame.label)
    void refresh()
    void refreshRecoveries()
  })
  void refresh()
  void refreshRecoveries()

  return {
    recoveries: { getSnapshot: () => recoveries, subscribe: listener => { recoveryListeners.add(listener); return () => { recoveryListeners.delete(listener) } } },
    restoreRollback: async record => {
      const records = recoveries.filter(item => (item.groupId ?? item.id) === (record.groupId ?? record.id))
      const results = await Promise.all(records.map(item => call<{ ok: boolean; restored: number; failed: number; message?: string }>('corumReview/restoreRollback', { sessionId: item.sessionId, recoveryId: item.id })))
      seen.clear()
      await Promise.all([refresh(), refreshRecoveries()])
      const problems = results.flatMap(result => result === null ? ['恢复请求失败'] : result.message ? [result.message] : [])
      return { ok: results.length > 0 && results.every(result => result?.ok), reverted: results.reduce((sum, result) => sum + (result?.restored ?? 0), 0),
        failed: results.reduce((sum, result, index) => sum + (result?.failed ?? records[index]?.paths.length ?? 0), 0), skipped: 0,
        ...problems.length > 0 ? { message: problems.join('; ') } : {} }
    },
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    revertAll: async () => {
      const operationId = crypto.randomUUID()
      // 问题 2：聚合口径下按**归属会话**分组撤销——父侧文件撤父轮次，子会话文件
      // 撤各自子会话中当前显示的文件。逐会话调用后汇总。
      const byOwner = new Map<string, string[]>()
      for (const file of current.files) {
        const owner = owners.get(file.path) ?? sessionId
        const list = byOwner.get(owner) ?? []
        list.push(file.path)
        byOwner.set(owner, list)
      }
      let restored = 0
      let failed = 0
      const problems: string[] = []
      await Promise.all([...byOwner.keys()].map(async (owner) => {
        const value = await call<{ ok: boolean; restored: number; failed: number; message?: string }>(
          'corumReview/rollback', { sessionId: owner, paths: byOwner.get(owner), operationId },
        )
        if (value === null) { failed += byOwner.get(owner)?.length ?? 0; problems.push('RPC 失败'); return }
        restored += value.restored
        failed += !value.ok && value.failed === 0 ? Math.max(1, (byOwner.get(owner)?.length ?? 0) - value.restored) : value.failed
        if (value.message !== undefined) problems.push(value.message)
      }))
      await refresh()
      await refreshRecoveries()
      return {
        ok: failed === 0,
        reverted: restored,
        failed,
        skipped: 0,
        ...problems.length > 0 ? { message: problems.join('; ') } : {},
      }
    },
    keepAll: () => {
      // 「全部保留」= 「这些我都看过了，收起卡片」。
      //
      // git 版下改动**本来就已经应用**（工作区现状即是保留的结果，轮次边界还会自动
      // 提交），所以这个按钮不需要对磁盘做任何事 —— 它唯一的作用就是把当前列出的文件
      // 全部标记为「已看过」。
      //
      // ⚠️ 这里曾经写成 `seen = new Set()`（清空标记），语义正好反了：刚被单独「保留」
      // 过的文件会重新冒出来、卡片也不收起 —— 与按钮字面意思相反（用户报的
      // 「点全部保留不生效」就是它）。
      // 记下「当时的内容哈希」：文件之后再变，标记自动失效。
      for (const file of current.files) { seen.set(file.path, file.hash) }
      current = emptyReviewChanges()
      for (const listener of listeners) listener()
    },
    keepFile: (path: string) => {
      const target = current.files.find(f => f.path === path)
      // 记内容哈希（C1）：该文件之后再被改动时标记自动失效。
      if (target !== undefined) seen.set(path, target.hash)
      const files = current.files.filter(f => f.path !== path)
      current = {
        totalAdded: files.reduce((sum, f) => sum + f.added, 0),
        totalRemoved: files.reduce((sum, f) => sum + f.removed, 0),
        files,
        revertOrder: [],
      }
      for (const listener of listeners) listener()
    },
    revertFile: async (path: string) => {
      // 问题 2：按归属会话路由（子会话文件撤销子会话轮次）。
      const owner = owners.get(path) ?? sessionId
      const value = await call<{ ok: boolean; restored: number; failed: number; message?: string }>(
        'corumReview/rollback', { sessionId: owner, path },
      )
      if (value === null) return { ok: false, reverted: 0, failed: 0, skipped: 0, message: 'RPC 失败' }
      await refresh()
      await refreshRecoveries()
      return {
        ok: value.ok,
        reverted: value.restored,
        failed: value.failed,
        skipped: 0,
        ...value.message === undefined ? {} : { message: value.message },
      }
    },
    fileBefore: async (path: string) => {
      // 问题 2：按归属会话路由（子会话文件用子会话轮次的 pre-image，避免复现
      // 「父轮次没抓过 → unavailable 死点」）。
      const owner = owners.get(path) ?? sessionId
      const value = await call<{ exists: boolean; content: string; created: boolean; status?: 'content' | 'absent' | 'unavailable' | 'missing' }>(
        'corumReview/fileBefore', { sessionId: owner, path },
      )
      if (value === null || !value.exists) {
        // 问题 1-④ 收口：host 现在带 status 枚举——unavailable（过大/二进制取不到）
        // 与 missing（不在本轮改动里）分开报，用户不再看到「改前为空」的假 diff。
        const message = value?.status === 'unavailable'
          ? '文件过大或非文本，没有保留改动前内容'
          : '该文件不在本轮改动里'
        return { ok: false, content: '', complete: false, path, message }
      }
      return {
        ok: true,
        content: value.content,
        complete: true,
        path,
        created: value.created || value.status === 'absent',
        // 新建文件：左侧为空是**正确**的（改前确实不存在），不该当成「重建不完整」。
        ...(value.created || value.status === 'absent') ? { note: '该文件是本轮新建的，左侧为空' } : {},
      }
    },
  }
}
