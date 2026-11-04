/** 当前会话流中的审批卡；同一会话可以同时展示多个待决定项。 */
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { ApprovalPanel } from './ApprovalPanel.tsx'
import { revealApproval } from './approval-visibility.ts'
import { PendingApproval, type ApprovalComposerProps } from './contract/slots.ts'

interface PendingSource {
  getSnapshot(): ReadonlyMap<string, unknown>
  subscribe(listener: () => void): () => void
}

export function createApprovalStream(source: PendingSource) {
  return function ApprovalStream(props: Omit<ApprovalComposerProps, 'matched'>) {
    const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
    const pending = [...snapshot.values()].filter((item): item is PendingApproval =>
      item instanceof PendingApproval && item.sessionId === props.sessionId)
    const stream = useRef<HTMLDivElement>(null)
    const keys = pending.map(item => item.key).join(',')
    useLayoutEffect(() => {
      if (keys !== '') revealApproval(stream.current?.lastElementChild)
    }, [keys])
    return <div ref={stream}>
      {pending.map(item => <ApprovalPanel {...props} key={item.key} matched={item} />)}
    </div>
  }
}
