/** Per-Session Chat selection store shared by the transcript and details panel. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ChatStoreState, CommitCardViewEntry, SelectionTarget, TurnProcessViewEntry } from './contract/store.ts'

type ChatActions = {
  select: (draft: ChatStoreState, target: SelectionTarget | null) => void
  setTurnProcessOpen: (
    draft: ChatStoreState,
    turn: number,
    answerStep: number,
    open: boolean,
  ) => void
  setCommitCardOpen: (draft: ChatStoreState, turn: number, open: boolean) => void
}

/**
 * Resolve the manually expanded answer for one Turn.
 * @param state - Chat store snapshot.
 * @param turn - owning Turn.
 * @returns the Turn's stored entry, when present.
 */
export function storedTurnProcessEntry(
  state: Readonly<ChatStoreState>,
  turn: number,
): Readonly<TurnProcessViewEntry> | undefined {
  return state.turnProcesses.find(entry => entry.turn === turn)
}

/**
 * 读某 turn 提交卡片的用户手动折叠选择（未干预时返回 `undefined`）。
 * @param state - Chat store snapshot。
 * @param turn - owning Turn。
 */
export function storedCommitCardEntry(
  state: Readonly<ChatStoreState>,
  turn: number,
): Readonly<CommitCardViewEntry> | undefined {
  return state.commitCards.find(entry => entry.turn === turn)
}

/**
 * Create the Chat selection store handle.
 * @returns a handle instantiated once per rendered Session scope.
 */
export function createChatStore(): EngineStoreHandle<ChatStoreState, ChatActions> {
  return defineStore({
    init: (): ChatStoreState => ({ selection: null, turnProcesses: [], commitCards: [] }),
    actions: {
      select: (draft, target: SelectionTarget | null) => { draft.selection = target },
      setTurnProcessOpen: (draft, turn, answerStep, open) => {
        const index = draft.turnProcesses.findIndex(entry => entry.turn === turn)
        if (!open) {
          if (index >= 0) draft.turnProcesses.splice(index, 1)
          return
        }
        const next = { turn, answerStep } satisfies TurnProcessViewEntry
        if (index < 0) draft.turnProcesses.push(next)
        else draft.turnProcesses[index] = next
      },
      setCommitCardOpen: (draft, turn, open) => {
        const index = draft.commitCards.findIndex(entry => entry.turn === turn)
        const next = { turn, open } satisfies CommitCardViewEntry
        if (index < 0) draft.commitCards.push(next)
        else draft.commitCards[index] = next
      },
    },
  })
}
