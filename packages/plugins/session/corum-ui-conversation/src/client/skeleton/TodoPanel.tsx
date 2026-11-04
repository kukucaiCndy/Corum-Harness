import { Fragment, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// The domain's client-namespace pure-type outlet: one import edge delivers
// the `todos` projection-key merge (single source, no consumer-side restated
// declare) and the payload type. Type-only by construction — the outlet is
// free of host value imports, so no host Context merge enters this program.
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import { IconChecklistOutline14, IconChevronDownOutline14, IconChevronUpOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from '../locales.ts'
import css from './TodoPanel.module.css'

export interface TodoPanelProps {
  /** The session's current plan (empty renders nothing) — selected by the dock adapter. */
  todos: readonly TodoItem[]
  /** The dock entry's locale seat, passed down as a plain prop. */
  t: TodoDockProps['t']
}

/**
 * 进度线的一个节点（design.pen `ZWe4x` dot-N + `sKrdG` 上下文稿）。
 *
 * 设计稿的圆点语义：一个圆点 = 一个任务项（用户确认）。三种状态对应设计 token：
 * - `completed`  → `state-success`（绿）9px 实心
 * - `in_progress`→ `state-warn`（黄）8px 实心 + 双层 halo 涟漪
 * - `pending`    → `#D9D3EE` 60% 9px 实心
 *
 * 设计稿把「已完成 → 进行中」之间的连接线画成绿色 55% 虚线（已走过的路径），
 * 「进行中 → 之后」画成 glass-border 70% 虚线（未走过的路径）。这个分界由
 * `dotIndex` 与 `activeIndex` 比较得出，见 `connectorTone`。
 */
type TodoDotTone = 'done' | 'active' | 'pending'

/** 单个任务的圆点色调（status → tone，闭合联合穷尽）。 */
function dotTone(status: TodoItem['status']): TodoDotTone {
  switch (status) {
    case 'completed': return 'done'
    case 'in_progress': return 'active'
    case 'pending': return 'pending'
    /* v8 ignore next -- closed TodoItem status union */
    default: return 'pending'
  }
}

/**
 * 连接虚线（节点 i 与 i+1 之间）的色调。
 *
 * 设计稿：绿虚线只画到当前进行中的节点为止（已完成的路径），其后一律用
 * glass-border 虚线段。首个进行中节点之前的连接线为绿，之后为中性。
 */
function connectorTone(index: number, activeIndex: number): 'done' | 'idle' {
  // 没有进行中节点时，全部已完成则整条走绿，否则按最后一个已完成节点收口。
  if (activeIndex < 0) return 'idle'
  return index < activeIndex ? 'done' : 'idle'
}

/**
 * 进度线的时间轴标记：默认折叠时只渲染这条线（无文字），与设计稿 `sKrdG`
 * 的 40px 玻璃胶囊一致。
 *
 * 排布：**扁平序列** `dot, conn, dot, conn, …`（不是「node 包着 dot+conn」）。
 * 早先的实现把 connector 放进每个 node 内、再让 node `flex:1`，会得到
 * `101,106,106,106,106,106` 这种不等宽的格子 —— 首节点没有 connector，
 * 少了一份 `min-width`，且 8px 的进行中点比 9px 的待办点窄 1px，flex 分配
 * 时每个节点的剩余空间都不一样，视觉上圆点就「没对齐」。改成扁平序列后，
 * 每个圆点两侧的间距都是同一个 connector 宽度，天然等距。
 *
 * 虚线流动动画（设计稿交互⑤）与黄点涟漪（交互⑥）都在 CSS 里
 * （见 TodoPanel.module.css）。
 */
function ProgressLine({ todos }: { todos: readonly TodoItem[] }) {
  const activeIndex = todos.findIndex(item => item.status === 'in_progress')
  // 滑动窗口（用户 2026-09-16 定调，todo.todo-panel.dense-progress-line）：
  // ① 最多 10 个圆点；② 超过 10 个时已完成的前缀被裁掉——第 1 个执行完显示 2–11、
  // 再完一个显示 3–12……**任何时刻恒显示 10 个**（不足 10 个显示实际数）。
  // 窗口起点 = max(0, activeIndex - 9)，让进行中的任务尽量在窗口内（已完成的
  // 前缀随进度逐步滚出视野）。
  const MAX_DOTS = 10
  const startIndex = todos.length <= MAX_DOTS
    ? 0
    : Math.max(0, (activeIndex === -1 ? todos.length - MAX_DOTS : Math.min(activeIndex, todos.length - MAX_DOTS)))
  const windowTodos = todos.slice(startIndex, startIndex + MAX_DOTS)
  return (
    <div className={css.line} aria-hidden="true">
      {windowTodos.map((item, windowIndex) => {
        const index = startIndex + windowIndex
        const tone = dotTone(item.status)
        return (
          <Fragment key={item.content}>
            {windowIndex > 0 && (
              <span
                className={css.connector}
                data-tone={connectorTone(index - 1, activeIndex)}
              />
            )}
            <span className={css.dot} data-tone={tone}>
              {/* 进行中：黄点自身呼吸 + 双层涟漪 halo
                  （设计稿 halo1 14px@50% / halo2 20px@25%）。 */}
              {tone === 'active' && (
                <>
                  <span className={css.haloOuter} />
                  <span className={css.haloInner} />
                </>
              )}
            </span>
          </Fragment>
        )
      })}
    </div>
  )
}

export function TodoPanel({ todos, t }: TodoPanelProps) {
  const [expanded, setExpanded] = useState(false)
  if (todos.length === 0) return null

  // hover 浮层（交互②）要展示「当下最该看的那个任务」：优先进行中，
  // 其次最后一条，兜底第一条。
  const focus = todos.find(item => item.status === 'in_progress')
    ?? todos[todos.length - 1]
    ?? todos[0]

  const done = todos.filter(item => item.status === 'completed').length
  const active = todos.filter(item => item.status === 'in_progress').length
  const pending = todos.length - done - active

  // 折叠态进度文案（用户反馈：只有圆点太单调、认不出是什么组件）。
  // 复用既有 locale key，零计数段省略 —— 与官方「1 进行中 · 5 待处理」同款读法。
  // 分隔用 en-space（U+2002）：HTML 会折叠连续 ASCII 空格，要让「·」两侧
  // 有呼吸感必须用宽空格。
  const progressText = [
    ...done > 0 ? [t('todo.progress.done', { done })] : [],
    ...active > 0 ? [t('todo.progress.active', { active })] : [],
    ...pending > 0 ? [t('todo.progress.pending', { pending })] : [],
  ].join('\u2002·\u2002')

  return (
    <section className={css.root} data-testid="todo-panel" data-expanded={expanded}>
      <button
        type="button"
        className={css.trigger}
        aria-expanded={expanded}
        aria-label={`${t('todo.summary', { total: todos.length, done, active })}；${expanded ? t('todo.collapse') : t('todo.expand')}`}
        onClick={() => { setExpanded(v => !v) }}
      >
        {/* 身份标识（图标 + 名称）：让用户一眼知道这是「任务」控件，而不是
            一串无来由的圆点。 */}
        <span className={css.lead} aria-hidden><IconChecklistOutline14 /></span>
        <span className={css.title}>{t('todo.title')}</span>
        <span className={css.progress}>{progressText}</span>
        <ProgressLine todos={todos} />
        <span className={css.chevron} data-expanded={expanded}>
          {expanded ? <IconChevronUpOutline14 size={10} /> : <IconChevronDownOutline14 size={10} />}
        </span>
      </button>
      {/* 设计稿交互②：hover 圆点浮现当前任务名称。自绘浮层（跟随 corum 玻璃主题）
          而非 title 属性 —— title 会出系统级黄框、不可主题化。显隐由 CSS 的
          .trigger:hover/.focus-visible 兄弟选择器驱动，无需 React 状态。 */}
      <div className={css.tooltip} role="tooltip">
        {focus !== undefined ? focus.content : ''}
      </div>
      {/* 展开态（交互③「点击进度线：展开为任务栏」）：列出**全部**任务项。
          早先只渲染 focus 一条，是因为把设计稿 `mugD6` 的 head 误读成了「整个
          展开态」—— 那只是展开态的标题行；进度线本身代表全部任务，展开后必须
          与进度线的圆点一一对应，否则点数和条目数对不上（用户报「有多个任务却
          只显示一个」）。 */}
      {expanded && (
        <ul className={css.list}>
          {todos.map(item => (
            <li key={item.content} className={css.item} data-tone={dotTone(item.status)}>
              <span className={css.itemGlyph} data-tone={dotTone(item.status)} aria-hidden />
              <span className={css.itemText}>{item.content}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Props for the projected todo dock. */
export type TodoDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'conversation'>

/** Renders the current todo projection, or nothing when it is absent. */
export function TodoDock({ useProjection, t }: TodoDockProps) {
  const todos = useProjection('todos')
  return <TodoPanel todos={todos ?? []} t={t} />
}

/** Registers the projected todo dock. */
export const todoDockEntry = {
  name: 'conversation-todo-dock',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('conversation.input.dock', () =>
      ctx.slots.register({ name: 'conversation.input.dock', id: 'todo', order: 0, locale: NS }, TodoDock))
  },
}
