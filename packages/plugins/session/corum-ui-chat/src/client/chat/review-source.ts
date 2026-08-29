// fork（corum）：Review 卡的 per-session 数据源。订阅 binding.eventSource
// 的会话事件窗，把 tool/call 写操作聚合成 ReviewChanges，并暴露「全部撤销 /
// 全部保留」两个动作。「全部保留」记录一个 seq 确认水位（水位以下的写操作
// 视为已确认，不再计入）；「全部撤销」成功后同样把水位提到当前最新 seq。

import type { SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { aggregateReviewChanges, emptyReviewChanges, type ReviewChanges } from './review-changes.ts'
import { revertAllOps, type RevertAllResult } from './review-revert.ts'

/** Review 卡对外面：当前聚合 + 两个动作。 */
export interface ReviewSource extends ObservableSnapshot<ReviewChanges> {
  /** 「全部撤销」：反向 apply 本轮所有写操作；成功后推进确认水位。 */
  revertAll(): Promise<RevertAllResult>
  /** 「全部保留」：把确认水位推进到当前最新 seq，dismiss 卡片。 */
  keepAll(): void
}

/** 事件窗条目 → 只保留 'event' 类（聚合只消费 SessionEvent）。 */
function eventEntries(
  source: SessionEventSource,
): readonly { readonly event: SessionEvent }[] {
  const out: { readonly event: SessionEvent }[] = []
  for (const entry of source.getSnapshot().entries) {
    if (entry.type === 'event') out.push({ event: entry.event })
  }
  return out
}

/** 事件窗当前最大 seq（无事件时 0）。 */
function latestSeq(source: SessionEventSource): number {
  let max = 0
  for (const entry of source.getSnapshot().entries) {
    if (entry.type === 'event' && entry.event.seq > max) max = entry.event.seq
  }
  return max
}

/** 为一个会话绑定创建 Review 数据源（按 binding 缓存，见 apply.ts）。 */
export function createReviewSource(
  eventSource: SessionEventSource,
  connection: ConnectionHandle,
  /** 泳道工作区绝对路径（撤销的路径根；经 host realpath 防穿越）。 */
  cwd?: string,
): ReviewSource {
  let confirmedSeq = 0
  let current: ReviewChanges = aggregateReviewChanges(eventEntries(eventSource), confirmedSeq)
  const listeners = new Set<() => void>()

  // 事件窗每次发布都重算（追加/翻页/替换都会触发），保持卡片与会话同步。
  eventSource.subscribe(() => { recompute() })

  const recompute = (): void => {
    const next = aggregateReviewChanges(eventEntries(eventSource), confirmedSeq)
    if (next === current) return
    current = next
    for (const listener of listeners) listener()
  }

  const publishSeq = (seq: number): void => {
    confirmedSeq = Math.max(confirmedSeq, seq)
    recompute()
  }

  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    revertAll: async () => {
      const ops = current.revertOrder
      const result = await revertAllOps(connection, ops, cwd)
      // 全部成功（或无可撤）才算确认本轮；部分失败保留卡片显示剩余。
      if (result.ok) publishSeq(latestSeq(eventSource))
      return result
    },
    keepAll: () => { publishSeq(latestSeq(eventSource)) },
  }
}
