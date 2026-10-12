/**
 * CommitCard —— turn-stopping 提交卡片（可折叠，三态状态展示，无操作按钮）。
 *
 * ## 三态
 *   - pending：头部 + diff --stat 预览 + 状态行（loader + 「AI 正在审查…」）
 *   - progress：chip「进行中」brand-primary + 4px 进度条 + 进度文本
 *   - done：avatar state-success + chip「已完成」+ 结果区列出分笔提交
 *
 * ## 可折叠（2026-10-11 用户定调）
 *
 * 用户原话：「卡片可以做成一个可折叠的形式，在提醒 LLM 提交到提交完成这个过程都收进
 * 这个卡片即可，这样视觉和信息展示会好一点」。
 * 折叠只保留**头部**（标题 + 副标题 + 状态 chip）——用户扫一眼就知道「这个 turn 在提交、
 * 到哪一步了」，不占垂直空间。展开才看 diff 摘要 / 进度条 / 提交结果。
 *
 * 默认**展开**：提交是本 turn 的活跃事件，用户通常想看它提交了什么；
 * 终态（done）后自动折叠为一行，把空间还给对话流。
 *
 * 折叠状态是**每张卡自己的**（useState），组件由 `CommitCardNode` 按 `pending.key` 挂载，
 * 故不同 turn 的卡各自独立。
 *
 * ⚠️ 卡片没有「提交/取消」按钮——提交是机制驱动的（host steer LLM 自己提交），
 * 用户不参与。折叠开关是唯一的可点元素。
 */
import { Check, ChevronDown, GitBranch, Loader } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import type { PendingCommitCard } from './contract.ts'
import css from './CommitCard.module.css'

export interface CommitCardProps {
  pending: PendingCommitCard
  /**
   * 展开态（2026-10-12 用户定调：卡片后过程收进卡片）。
   *
   * 卡片充当「提交段」容器的折叠控制器：头部点击切换此值；容器（ChatNodeSeat）
   * 用同一份状态决定过程成员（思考/工具/结论）是否渲染在卡片内部。
   * 不传时组件内部自管理（旧行为：非终态默认展开、done 自动折叠）。
   */
  open?: boolean | undefined
  /** 头部点击回调（与 `open` 配套；传了 `open` 就受控，组件不再自管状态）。 */
  onToggle?: ((open: boolean) => void) | undefined
  /**
   * 嵌进提交段容器：不画自己的外壳（玻璃底/描边/圆角由容器提供），
   * 只保留内边距与内容排布 —— 否则会出现「卡中卡」双层边框。
   */
  embedded?: boolean | undefined
}

/** 状态对应的 chip 样式。 */
function chipClass(status: PendingCommitCard['status']): string {
  switch (status) {
    case 'pending': return `${css.chip} ${css.chipWarn}`
    case 'progress': return `${css.chip} ${css.chipBrand}`
    case 'done': return `${css.chip} ${css.chipSuccess}`
    default: return css.chip
  }
}

/** 状态对应的 chip 文本。 */
function chipText(status: PendingCommitCard['status']): string {
  switch (status) {
    case 'pending': return '待提交'
    case 'progress': return '进行中'
    case 'done': return '已完成'
    default: return ''
  }
}

/** avatar 样式（pending/progress = brand-primary；done = state-success）。 */
function avatarClass(status: PendingCommitCard['status']): string {
  if (status === 'done') return `${css.avatar} ${css.avatarDone}`
  return css.avatar
}

/**
 * 一个订阅 pending 状态变化的 hook（useSyncExternalStore）。
 * 每次 pending.applyUpdate 被调用时触发重渲染。
 *
 * ⚠️ `getSnapshot` **必须返回每次更新都不同的值**：`applyUpdate` 在同一个对象上
 * 原地改状态，返回 `pending` 本身会让 `Object.is` 恒等 ⇒ React 判定无变化 ⇒
 * 永不重渲染（2026-10-11 实测：手动改活对象 status，DOM 仍是旧态）。
 * 故读 `pending.version`（每次 applyUpdate 自增的 number）。
 * 对象引用仍由 `pending` 提供（组件要从它读 commits/progressText）。
 */
function usePendingStatus(pending: PendingCommitCard): PendingCommitCard {
  useSyncExternalStore(
    pending.subscribe.bind(pending),
    () => pending.version,
  )
  return pending
}

/**
 * 提交卡片组件。
 * @param props - 待展示项。
 */
export function CommitCard({ pending, open: openProp, onToggle, embedded }: CommitCardProps) {
  const p = usePendingStatus(pending)
  const { request } = p
  const status = p.status

  // 默认展开；进入终态后自动折叠（用户已看到结果，不必继续占位）。
  // `undefined` = 用户还没手动干预过 ⇒ 跟随状态自动决定；一旦用户点过，就尊重用户选择。
  // 受控模式（openProp 传入）：展开态由 chat store 持有，卡片与过程节点共享同一份。
  const [userToggled, setUserToggled] = useState<boolean | undefined>(undefined)
  const open = openProp ?? userToggled ?? status !== 'done'
  const toggle = () => {
    if (onToggle !== undefined) onToggle(!open)
    else setUserToggled(!open)
  }

  const diffLines = request.diffLines
  const remaining = Math.max(0, request.effectiveFiles - diffLines.length)

  return (
    <div className={css.shell}>
      <div className={embedded === true ? css.cardEmbedded : css.card} role="status">
        {/* 头部（可点击折叠/展开）：标题 + 副标题 + 状态 chip + chevron */}
        <button
          type="button"
          className={css.header}
          aria-expanded={open}
          aria-label={`${open ? '收起' : '展开'}提交详情`}
          onClick={toggle}
        >
          <span className={avatarClass(status)}>
            <GitBranch size={11} />
          </span>
          <span className={css.headerTx}>
            <span className={css.title}>整理改动并提交</span>
            <span className={css.subtitle}>
              本 turn 有 {request.effectiveFiles} 个文件改动 · 按逻辑主题分笔提交
            </span>
          </span>
          <span className={chipClass(status)}>
            <span className={css.chipDot} />
            {chipText(status)}
          </span>
          <ChevronDown
            size={14}
            className={`${css.chevron}${open ? ` ${css.chevronOpen}` : ''}`}
            aria-hidden="true"
          />
        </button>

        {open && (
          <div className={css.body}>
            {/* diff --stat 预览区（pending/progress 态显示） */}
            {(status === 'pending' || status === 'progress') && diffLines.length > 0 && (
              <div className={css.diffPreview}>
                {diffLines.map((line, i) => (
                  <div key={i} className={css.diffLine}>{line}</div>
                ))}
                {remaining > 0 && (
                  <div className={css.diffMore}>
                    …还有 {remaining} 个{request.excludedArtifacts > 0 ? '（产物已排除）' : ''}
                  </div>
                )}
              </div>
            )}

            {/* 状态行（pending 态） */}
            {status === 'pending' && (
              <div className={css.statusRow}>
                <span className={css.statusIcon}>
                  <Loader size={14} className="animate-spin" />
                </span>
                <span className={css.statusText}>
                  AI 正在审查 diff、按逻辑主题分笔写提交信息…
                </span>
              </div>
            )}

            {/* 进度条 + 进度文本（progress 态） */}
            {status === 'progress' && (
              <>
                <div className={css.progressTrack}>
                  <div className={css.progressFill} style={{ width: '40%' }} />
                </div>
                <div className={css.statusRow}>
                  <span className={css.statusIcon}>
                    <Loader size={14} className="animate-spin" />
                  </span>
                  <span className={css.statusText}>
                    {p.progressText || '正在提交…'}
                  </span>
                </div>
              </>
            )}

            {/* 已完成结果区（done 态） */}
            {status === 'done' && p.commits.length > 0 && (
              <div className={css.resultList}>
                {p.commits.map((commit, i) => (
                  <div key={i} className={css.resultItem}>
                    <Check size={12} className={css.resultCheck} />
                    <span>
                      {commit.type}{commit.scope !== undefined ? `(${commit.scope})` : ''}: {commit.message}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 无实时卡时的提交段头部（历史会话重载后 `PendingCommitCard` 已释放）。
 *
 * 为什么需要它：提交段容器把卡片之后的过程成员收进卡片内部，卡片头部是**唯一**
 * 的展开控制器。若卡片在重载后渲染为空，容器就既没有可点的头部、成员也不渲染
 * ⇒ 过程内容彻底不可达。故此处保留一个最小头部（标题 + 折叠开关），只负责
 * 让容器可展开；真实状态三态数据已随会话重载释放，不伪造。
 *
 * @param props - 展开态与切换回调（来自提交段容器）。
 */
export function CommitCardHeaderFallback({ open, onToggle }: {
  readonly open: boolean
  readonly onToggle: (open: boolean) => void
}) {
  return (
    <div className={css.shell}>
      <div className={css.cardEmbedded}>
        <button
          type="button"
          className={css.header}
          aria-expanded={open}
          aria-label={`${open ? '收起' : '展开'}提交详情`}
          onClick={() => { onToggle(!open) }}
        >
          <span className={`${css.avatar} ${css.avatarDone}`}>
            <GitBranch size={11} />
          </span>
          <span className={css.headerTx}>
            <span className={css.title}>整理改动并提交</span>
            <span className={css.subtitle}>本 turn 的提交过程</span>
          </span>
          <ChevronDown
            size={14}
            className={`${css.chevron}${open ? ` ${css.chevronOpen}` : ''}`}
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  )
}
