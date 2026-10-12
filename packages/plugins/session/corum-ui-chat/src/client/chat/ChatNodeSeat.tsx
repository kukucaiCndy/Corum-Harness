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
  /**
   * 本座位是提交卡片时：收进卡片内部的提交段成员 key（有序）。
   * 由 ChatNodeList 的分组规划下发；成员座位自身不收（不递归）。
   */
  readonly commitMembers?: readonly string[] | undefined
}

/** 非卡片座位的稳定空成员表（避免每次渲染新建数组破坏 memo）。 */
const EMPTY_MEMBER_KEYS: readonly string[] = []

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
  commitMembers,
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

  // ── 提交卡片 = 提交段容器（2026-10-12 用户定调）────────────────────────
  // 卡片之后的同 turn 过程（LLM 思考/工具执行/最终结论）由 ChatNodeList 归组、
  // 交给本座位**内嵌渲染**（成员不再占自己的会话流行）——这样过程真的在卡片
  // 内部（同一玻璃容器），而不是卡片下方的独立行。默认收起，展开才可见。
  // 展开态存 chat store（单一事实源），卡片头部点击经 `commitProcess.setOpen` 写回。
  // commit-card 是 corum-ui-commit-card 贡献的合并 kind，本包编译期不可见
  // （ChatNodeKind 联合里没有它），故按字符串判定而非类型收窄。
  const isCommitCard = (routedNode?.kind as string | undefined) === 'commit-card'
  const memberKeys = commitMembers ?? EMPTY_MEMBER_KEYS
  const commitGrouped = isCommitCard && memberKeys.length > 0
  const commitEntry = useStore(state => turn === undefined
    ? undefined
    : storedCommitCardEntry(state, turn))
  // 默认收起（用户原话「只有用户展开才看得到」）；用户点过头部后尊重其选择。
  const commitCardOpen = commitEntry?.open ?? false
  const setCommitOpen = useCallback((open: boolean) => {
    if (turn !== undefined) actions.setCommitCardOpen(turn, open)
  }, [actions, turn])
  // `commitProcess` 只在卡片被收进提交段容器时下发（该不变式让卡片知道
  // 自己不画外壳、由容器提供玻璃底，见 CommitProcessOwnerProps 文档）。
  const commitProcess = useMemo<CommitProcessOwnerProps | undefined>(() => (
    commitGrouped ? { open: commitCardOpen, setOpen: setCommitOpen } : undefined
  ), [commitGrouped, commitCardOpen, setCommitOpen])

  const revealProcess = useCallback(() => {
    if (processMember) setOpen(true)
    // 提交段成员的浏览器查找揭示：展开卡片（等价于用户点卡片头部）。
    if (commitGrouped) setCommitOpen(true)
  }, [processMember, setOpen, commitGrouped, setCommitOpen])
  const wrapperRef = useSearchableHidden(processHidden, revealProcess)
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
  // 传给内嵌成员座位的 props（排除自身的 commitMembers，避免递归分组）。
  const seatProps = useMemo(() => ({
    useChatNode, useChatNodeProcess, historyIncomplete, compactTranscript,
    selectedCallId, cwd, openFile, inspectCall, forkAt,
    loadImage, renderMessageImages, fileMentions, useStore, actions, renderSlot, t,
  }), [
    useChatNode, useChatNodeProcess, historyIncomplete, compactTranscript,
    selectedCallId, cwd, openFile, inspectCall, forkAt,
    loadImage, renderMessageImages, fileMentions, useStore, actions, renderSlot, t,
  ])
  if (routedNode === undefined || owner === null) return null
  const turnData = turnDataOf(routedNode)
  // Runtime dispatch owns the correlation: every Node's discriminant is the
  // keyed-slot entry passed alongside that same Node. TypeScript does not
  // distribute an object containing a union into a union of objects itself.
  const routedOwner = { ...owner, node: routedNode } as RoutedChatNodeOwner
  const rendered = renderSlot('conversation.chat.node', routedOwner, {
    entryKey: routedNode.kind,
    hookContext: turnData,
    fallback: (
      <JsonBlock
        label={t('message.unknownSurface', { type: routedNode.kind })}
        payload={routedNode.data}
        truncatedLabel={total => t('json.truncated', { total })}
      />
    ),
  })
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
      data-commit-group={commitGrouped || undefined}
      data-commit-group-open={commitGrouped ? commitCardOpen : undefined}
    >
      {commitGrouped
        ? (
          // 提交段容器：卡片头部（无自绘外壳）+ 收起/展开的过程成员，
          // 同一玻璃底 —— 过程「在卡片里」而不是卡片下方的独立行。
          <div className={css.commitGroup}>
            {rendered}
            {commitCardOpen && memberKeys.map(memberKey => (
              <div key={memberKey} className={css.commitGroupMember} data-commit-group-member={memberKey}>
                <ChatNodeSeat nodeKey={memberKey} {...seatProps} />
              </div>
            ))}
          </div>
        )
        : rendered}
    </div>
  )
})
