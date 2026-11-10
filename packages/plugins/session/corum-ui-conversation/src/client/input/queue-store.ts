/**
 * Queue read face for the InputState.queue projection (frozen contract in
 * ../contract/input.ts): a uSES-compatible observable over one session's
 * transient inbox rows.
 *
 * rc3: `SessionSnapshot.queue` was removed; the inbox is now a projection
 * (`session.projections.faceOf('inbox')`) whose `next-turn` entries are
 * `UserMessage` values. This wraps the projection into the same observable
 * shape the InputState contract expects.
 */
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { QueuedMessage } from '../contract/input.ts'

/** Inbox projection shape (matches @deepseek-ai/dsh-agent InboxState). */
interface InboxState {
  readonly 'next-turn': readonly { readonly id: string; readonly source?: { readonly rpcId?: unknown } }[]
  readonly 'next-step': readonly { readonly id: string; readonly source?: { readonly rpcId?: unknown } }[]
}

const EMPTY_QUEUE: readonly QueuedMessage[] = Object.freeze([])

/**
 * Project a session's inbox `next-turn` rows as a bare observable
 * (subscribe/getSnapshot). The wiring layer overlays this onto InputState.queue.
 * @param session - the resident session face.
 * @returns the queue read face (snapshot reference stable while the inbox is unchanged).
 */
export function queueReadFaceOf(session: SessionFace): ObservableSnapshot<readonly QueuedMessage[]> {
  const inboxSource = session.projections.faceOf('inbox') as ObservableSnapshot<InboxState | undefined>
  return {
    getSnapshot: () => {
      const inbox = inboxSource.getSnapshot()
      return inbox?.['next-turn'] as readonly QueuedMessage[] | undefined ?? EMPTY_QUEUE
    },
    subscribe: fn => inboxSource.subscribe(fn),
  }
}
