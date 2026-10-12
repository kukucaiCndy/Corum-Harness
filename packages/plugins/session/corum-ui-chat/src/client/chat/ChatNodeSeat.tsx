import { memo, useCallback, useMemo } from 'react'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationLocationDataStore, ConversationTurnDataMap } from '@corum/corum-ui-conversation/client'
import type { ChatNodeOwnerProps, ChatViewSlotProps, CommitProcessOwnerProps } from '../contract/slots.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { TURN_PROCESS_INDEPENDENT_KINDS } from '../contract/turn-process.ts'
import { storedCommitCardEntry, storedTurnProcessEntry } from '../stores.ts'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './ChatView.module.css'

interface ChatNodeSeatProps extends ChatNodeOwnerProps {
  readonly nodeKey: string
  readonly useChatNode: ChatViewSlotProps['useChatNode']
  readonly useChatNodeProcess: ChatViewSlotProps['useChatNodeProcess']
  readonly historyIncomplete: boolean
  readonly compactTranscript: boolean
  readonly useStore: ChatViewSlotProps['useStore']
  readonly actions: ChatViewSlotProps['actions']
  readonly renderSlot: ChatViewSlotProps['renderSlot']
  readonly t: ChatViewSlotProps['t']
}

type RoutedChatNodeOwner = {
  [Kind in ChatNode['kind']]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> }
}[ChatNode['kind']]

function turnDataOf(node: ChatNode | undefined): ConversationLocationDataStore<ConversationTurnDataMap> | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.data : undefined
}

function turnOf(node: ChatNode | undefined): number | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
}

/** Subscribe, apply Turn-process visibility, and dispatch one stable Context key. */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey, useChatNode, useChatNodeProcess, historyIncomplete, compactTranscript,
  selectedCallId, cwd, openFile, inspectCall, forkAt,
  loadImage, renderMessageImages, fileMentions, useStore, actions, renderSlot, t,
}: ChatNodeSeatProps) {
  const node = useChatNode(nodeKey)
  const routedNode = node as ChatNode | undefined
  const turn = turnOf(routedNode)
  const processPresentation = useChatNodeProcess(nodeKey)
  const processSpec = processPresentation?.spec
  const storedEntry = useStore(state => processSpec === undefined
    ? undefined
    : storedTurnProcessEntry(state, processSpec.turn))
  const processEntry = processSpec !== undefined
    && processSpec.answerStep !== null
    && storedEntry?.answerStep === processSpec.answerStep
    ? storedEntry
    : undefined
  const processOpen = processEntry !== undefined
  const setOpen = useCallback((open: boolean) => {
    if (processSpec !== undefined && processSpec.answerStep !== null) {
      actions.setTurnProcessOpen(processSpec.turn, processSpec.answerStep, open)
    }
  }, [actions, processSpec])
  const processWindowReady = processSpec !== undefined
    && processPresentation !== undefined
    && compactTranscript
    && processSpec.answerAnchorSeq !== null
    && processPresentation.turn === processSpec.turn
    && processPresentation.turnClosed
    && !historyIncomplete
  const processMember = routedNode !== undefined
    && processWindowReady
    && !TURN_PROCESS_INDEPENDENT_KINDS.has(routedNode.kind)
    && routedNode.anchorSeq >= processSpec.processStartSeq
    && routedNode.anchorSeq < processSpec.answerAnchorSeq
  const processAnswer = routedNode !== undefined
    && processWindowReady
    && routedNode.kind === 'assistant-step'
    && routedNode.data.step === processSpec.answerStep
  const ownsDisclosure = routedNode?.kind === 'turn-process' || processAnswer
  // 工具调用不再折叠（2026-08-29）：foldable 恒为 false，工具调用始终展开显示
  // fork（corum）：官方 0.1.3 把 processLayout 判定搬进 ChatTurnProcessProjector，
  // corum 仍钉 foldable=false（死代码面随官方投影器内聚而缩小，P0-12 缓解）。
  const foldable = false
  const turnProcess = useMemo(() => processSpec === undefined
    ? undefined
    : {
      spec: processSpec,
      foldable,
      open: processOpen,
      setOpen,
    }, [
    foldable, processOpen, processSpec, setOpen,
  ])
  const controllerInactive = routedNode?.kind === 'turn-process'
    && !foldable
  const compactAnswer = processAnswer
    && foldable
    && processPresentation.compactAnswer
    && !processOpen
  const processHidden = controllerInactive || (foldable && processMember && !processOpen)

  // ── 提交卡片段折叠（2026-10-12 用户定调）───────────────────────────────
  // 提交卡片出现后，其 steer 锚点**之后**的同 turn 过程（思考/工具/结论）
  // 收进卡片内部：成员节点隐藏，卡片头部是唯一的展开控制器。
  // 展开态语义：用户未干预时「非终态展开（看实时提交过程）、done 后自动折叠」；
  // 用户点过卡片头部后尊重用户选择（存 chat store，跨节点共享同一份）。
  const commitAnchorSeq = processPresentation?.commitAnchorSeq
  // commit-card 是 corum-ui-commit-card 贡献的合并 kind，本包编译期不可见
  // （ChatNodeKind 联合里没有它），故用字符串比较判定而非类型收窄。
  const routedKind = routedNode?.kind as string | undefined
  const isCommitCard = routedKind === 'commit-card'
  const commitEntry = useStore(state => turn === undefined
    ? undefined
    : storedCommitCardEntry(state, turn))
  const commitSegmentActive = commitAnchorSeq !== undefined
    && processPresentation !== undefined
    && processPresentation.turnClosed
    && !historyIncomplete
  const commitCardOpen = commitEntry !== undefined
    ? commitEntry.open
    : !(processPresentation?.turnClosed ?? false)
  const commitProcessMember = routedNode !== undefined
    && commitSegmentActive
    && !isCommitCard
    && routedNode.kind !== 'turn-process'
    && routedNode.kind !== 'turn-tail'
    && routedNode.anchorSeq > commitAnchorSeq
  const commitProcessHidden = commitProcessMember && !commitCardOpen

  const setCommitOpen = useCallback((open: boolean) => {
    if (turn !== undefined) actions.setCommitCardOpen(turn, open)
  }, [actions, turn])
  const commitProcess = useMemo<CommitProcessOwnerProps | undefined>(() => (
    commitSegmentActive && isCommitCard
      ? { open: commitCardOpen, setOpen: setCommitOpen }
      : undefined
  ), [commitSegmentActive, isCommitCard, commitCardOpen, setCommitOpen])

  const hidden = processHidden || commitProcessHidden
  const revealProcess = useCallback(() => {
    if (processMember) setOpen(true)
    // 提交段成员被搜索命中时，展开提交卡片（等价于用户点卡片头部）。
    if (commitProcessMember) setCommitOpen(true)
  }, [processMember, setOpen, commitProcessMember, setCommitOpen])
  const wrapperRef = useSearchableHidden(hidden, revealProcess)
  const owner = useMemo<ChatNodeOwnerProps | null>(() => node === undefined
    ? null
    : {
      selectedCallId,
      cwd,
      openFile,
      inspectCall,
      forkAt,
      loadImage,
      renderMessageImages,
      fileMentions,
      turnProcess,
      commitProcess,
    }, [
    node, selectedCallId, cwd, openFile, inspectCall, forkAt,
    loadImage, renderMessageImages, fileMentions, turnProcess, commitProcess,
  ])
  if (routedNode === undefined || owner === null) return null
  const turnData = turnDataOf(routedNode)
  // Runtime dispatch owns the correlation: every Node's discriminant is the
  // keyed-slot entry passed alongside that same Node. TypeScript does not
  // distribute an object containing a union into a union of objects itself.
  const routedOwner = { ...owner, node: routedNode } as RoutedChatNodeOwner
  return (
    <div
      ref={wrapperRef}
      className={css.flowItem}
      data-chat-anchor-key={routedNode.key}
      data-chat-flow-key={routedNode.key}
      data-chat-flow-kind={routedNode.kind}
      data-chat-turn={turn}
      data-turn-process-member={processMember || undefined}
      data-turn-process-hidden={processHidden || undefined}
      data-turn-process-answer={compactAnswer || undefined}
      data-commit-process-member={commitProcessMember || undefined}
      data-commit-process-hidden={commitProcessHidden || undefined}
    >
      {renderSlot('conversation.chat.node', routedOwner, {
        entryKey: routedNode.kind,
        hookContext: turnData,
        fallback: (
          <JsonBlock
            label={t('message.unknownSurface', { type: routedNode.kind })}
            payload={routedNode.data}
            truncatedLabel={total => t('json.truncated', { total })}
          />
        ),
      })}
    </div>
  )
})
