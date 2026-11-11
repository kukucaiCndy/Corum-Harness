/**
 * 会话流里的待审批卡（issue #172）。
 *
 * ## 为什么不再用 composer 接管
 *
 * 原实现把审批卡注册进 `conversation.composer`（`select` 命中 `pendingInteraction` 就渲染），
 * 效果是卡片以 overlay 姿态**顶掉输入框**、固定贴底；用户口径：「按设计本应该在会话流中，
 * 目前沿用了 dsh 的默认方式」。用户看不到卡片时也完全没有提示（那是 issue #181 的另一半）。
 *
 * ## 数据从哪来（不新造共享状态）
 *
 * `ctx.uiSession.sessionStatus` 是**官方**发布的会话状态快照（`Map<SessionId, SessionStatus>`，
 * 每项带 `pendingInteraction`），也是 `pendingVisibleInStatus()` 自检读的同一份真相。
 * 本卡直接订阅它、只认 `isPendingApproval()` 判出的对象：
 * · 单一事实源 —— 不维护第二份 pending 表，避免「面板读 A、自检读 B」的两套认知；
 * · 跨 bundle 安全 —— 用结构判别（`kind === 'approval'` + `answer`/`answerAlwaysAllow` 是函数）
 *   而不是 `instanceof`（后者在跨 bundle 时恒 false，正是审批卡静默不渲染的老坑）。
 *
 * @module @corum/corum-ui-approval/ApprovalStream
 */
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ApprovalPanel } from './ApprovalPanel.tsx'
import { revealApproval } from './approval-visibility.ts'
import { isPendingApproval, type ApprovalComposerProps } from './contract/slots.ts'

/** 官方 `sessionStatus` 快照里本模块用到的两个字段（只登记用到的那面）。 */
interface StatusFace {
  readonly pendingInteraction?: unknown
}

/** 订阅面（官方 `HostObservable` 的最小能力面）。 */
export interface SessionStatusFace {
  getSnapshot: () => ReadonlyMap<string, StatusFace>
  subscribe: (listener: () => void) => () => void
}

/**
 * 造一个会话流审批卡组件（绑定到给定的状态源）。
 *
 * @param status - 官方 `uiSession.sessionStatus`（`getSnapshot` + `subscribe`）。
 * @returns 渲染当前会话待审批项的组件；没有待审批时渲染 `null`。
 */
export function createApprovalStream(status: SessionStatusFace) {
  return function ApprovalStream(props: Omit<ApprovalComposerProps, 'matched'>): JSX.Element | null {
    const snapshot = useSyncExternalStore(status.subscribe, status.getSnapshot, status.getSnapshot)
    const candidate = snapshot.get(String(props.sessionId as SessionId))?.pendingInteraction
    const stream = useRef<HTMLDivElement | null>(null)
    // 结构判别（见模块头注：跨 bundle 时 `instanceof` 恒 false）。
    const pending = isPendingApproval(candidate) ? candidate : null
    useLayoutEffect(() => {
      if (pending !== null) revealApproval(stream.current?.lastElementChild)
    }, [pending])
    if (pending === null) return null
    return (
      <div ref={stream} data-approval-stream>
        <ApprovalPanel {...props} key={pending.key} matched={pending} />
      </div>
    )
  }
}