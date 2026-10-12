/**
 * 提交段（commit segment）分组规划 —— 把「提交卡片 + 它之后的过程节点」认成一组。
 *
 * ## 规则（2026-10-12 用户定调）
 *
 * 提交卡片出现后，其 steer 锚点**之后**的同 turn 过程（LLM 思考/工具执行/最终结论）
 * 收进卡片内部——卡片是容器，过程是它的内容，默认收起，用户展开才可见。
 *
 * 判定与 `ChatTurnProcessProjector` 投影的 `commitAnchorSeq` 同源（不重复实现
 * 「本 turn 第一张卡片」的推导）：
 *   - 组 = 同 turn 内第一张 `commit-card` 节点 + `anchorSeq > commitAnchorSeq`
 *     且不属于 `TURN_PROCESS_INDEPENDENT_KINDS` 的后续节点；
 *   - `turn-tail` / `turn-process` / `user` / `steering` 等独立 kind 不收（它们是
 *     结构锚点或人类输入，不是「过程」）。
 *
 * 返回两张表供渲染层使用：`cardOf`（成员 → 所属卡片，渲染时跳过成员自身的流行）
 * 与 `membersOf`（卡片 → 成员，交给卡片座位内嵌渲染）。
 *
 * @module chat/commit-segment
 */
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatNodeStore } from '../contract/snapshot.ts'
import { TURN_PROCESS_INDEPENDENT_KINDS } from '../contract/turn-process.ts'

/** 提交段的分组结果（两张互补的表）。 */
export interface CommitSegmentPlan {
  /** 成员 key → 所属卡片 key：命中的 key 不再渲染自己的会话流行。 */
  readonly cardOf: ReadonlyMap<string, string>
  /** 卡片 key → 有序成员 key：由卡片座位内嵌渲染。 */
  readonly membersOf: ReadonlyMap<string, readonly string[]>
}

/** 空规划（无提交段时复用同一实例，保持 memo 依赖稳定）。 */
export const EMPTY_COMMIT_SEGMENT_PLAN: CommitSegmentPlan = {
  cardOf: new Map(),
  membersOf: new Map(),
}

/** 取节点所属 turn（turn / step 两种 location 都算）。 */
function nodeTurn(node: ChatNode | undefined): number | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
}

/** 该节点是否是提交卡片（跨包贡献的合并 kind，编译期不可见，故按字符串判定）。 */
function isCommitCard(node: ChatNode | { readonly kind: string } | undefined): boolean {
  return node?.kind === 'commit-card'
}

/**
 * 规划会话流里的提交段分组。
 *
 * @param order - 会话流的可见节点顺序（渲染顺序）。
 * @param nodes - 节点存储（同步读取 + 提交段投影来源）。
 * @returns 分组结果；没有任何提交段时返回 {@link EMPTY_COMMIT_SEGMENT_PLAN}。
 */
export function planCommitSegments(
  order: readonly string[],
  nodes: ChatNodeStore,
): CommitSegmentPlan {
  const byTurn = new Map<number, string[]>()
  for (const key of order) {
    const turn = nodeTurn(nodes.get(key) as ChatNode | undefined)
    if (turn === undefined) continue
    const bucket = byTurn.get(turn)
    if (bucket === undefined) byTurn.set(turn, [key])
    else bucket.push(key)
  }
  let cardOf: Map<string, string> | undefined
  let membersOf: Map<string, readonly string[]> | undefined
  for (const keys of byTurn.values()) {
    const cardKey = keys.find(key => isCommitCard(nodes.get(key) as ChatNode | undefined))
    if (cardKey === undefined) continue
    const anchor = nodes.process(cardKey)?.commitAnchorSeq
    if (anchor === undefined) continue
    const members = keys.filter((key) => {
      if (key === cardKey) return false
      const node = nodes.get(key) as ChatNode | undefined
      if (node === undefined || TURN_PROCESS_INDEPENDENT_KINDS.has(node.kind)) return false
      return node.anchorSeq > anchor
    })
    if (members.length === 0) continue
    cardOf ??= new Map()
    membersOf ??= new Map()
    for (const member of members) cardOf.set(member, cardKey)
    membersOf.set(cardKey, members)
  }
  return cardOf === undefined || membersOf === undefined
    ? EMPTY_COMMIT_SEGMENT_PLAN
    : { cardOf, membersOf }
}
