/**
 * QuestionCard —— 提问卡片（corum 重设计，design.pen K2M4e9 提取表）。
 *
 * 渲染在输入框正上方（conversation.composer.dock），**不遮盖对话与输入框**——
 * 用户可边看清上下文边作答，正在编辑的指令不被打断（区别于官方
 * ui-user-questions 接管整个 composer 的遮盖式模态框）。
 *
 * 结构（提取表）：q-head（题型图标 + 组名 + 标题 + 收起/放弃）→ 作答区
 * （单选 radio / 多选 checkbox / 直接回答多行文本）→ q-foot（左下角翻页
 * ◀ x/n ▶ + 右侧跳过本题 + 提交）。全部走 --corum-* 与 --dsw-alias-* 变量，零硬编码。
 */
import { useMemo, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, ChevronUp, MessageCircle, PenLine, X } from 'lucide-react'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { PendingQuestion } from './contract.ts'
import css from './QuestionCard.module.css'

/** 一题的作答状态（单选 selected / 多选 multi / 自由文本 text）。 */
interface Draft {
  /** 单选：选中的 option label。 */
  single?: string | undefined
  /** 多选：选中的 option label 集合。 */
  multi: readonly string[]
  /** 自由文本 / 自定义补充。 */
  text: string
}

const EMPTY_DRAFT: Draft = { multi: [], text: '' }

/** 题型判定：有 options → 单选/多选；无 → 直接回答。 */
function kindOf(q: AskUserQuestionItem): 'single' | 'multi' | 'free' {
  const opts = q.options ?? []
  if (opts.length === 0) return 'free'
  return q.multiSelect === true ? 'multi' : 'single'
}

export interface QuestionCardProps {
  pending: PendingQuestion
}

/** 单个选项行（radio 或 checkbox，提取表：选中 #01CDFE14 + active 描边）。 */
function OptionRow({ kind, label, description, checked, onToggle }: {
  kind: 'single' | 'multi'
  label: string
  description?: string | undefined
  checked: boolean
  onToggle: () => void
}) {
  return (
    <button type="button" className={css.option} data-active={checked || undefined} onClick={onToggle}>
      {kind === 'single'
        ? <span className={css.radio} data-on={checked || undefined}>{checked && <span className={css.radioDot} />}</span>
        : <span className={css.checkbox} data-on={checked || undefined}>{checked && <Check size={12} />}</span>}
      <span className={css.optionTx}>
        <span className={css.optionLabel} data-on={checked || undefined}>{label}</span>
        {description !== undefined && <span className={css.optionDesc}>{description}</span>}
      </span>
    </button>
  )
}

export function QuestionCard({ pending }: QuestionCardProps) {
  const questions = pending.questions
  const [index, setIndex] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const [drafts, setDrafts] = useState<readonly Draft[]>(() => questions.map(() => EMPTY_DRAFT))
  const [busy, setBusy] = useState(false)

  const total = questions.length
  const current = questions[index]
  const draft = drafts[index] ?? EMPTY_DRAFT

  const setDraft = (patch: Partial<Draft>): void => {
    setDrafts(prev => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)))
  }

  /** 当前题是否可提交：单选需选中或有自定义文本；多选至少一项；直接回答需非空文本。 */
  const canSubmit = useMemo(() => {
    if (current === undefined) return false
    const kind = kindOf(current)
    if (kind === 'single') return draft.single !== undefined || draft.text.trim() !== ''
    if (kind === 'multi') return draft.multi.length > 0 || draft.text.trim() !== ''
    return draft.text.trim() !== ''
  }, [current, draft])

  /** 是否全部题都已作答（决定可发送整组）。 */
  const allAnswered = useMemo(() => questions.every((q, i) => {
    const d = drafts[i] ?? EMPTY_DRAFT
    const kind = kindOf(q)
    if (kind === 'single') return d.single !== undefined || d.text.trim() !== ''
    if (kind === 'multi') return d.multi.length > 0 || d.text.trim() !== ''
    return d.text.trim() !== ''
  }), [questions, drafts])

  const submitAll = async (): Promise<void> => {
    if (busy || !allAnswered) return
    setBusy(true)
    try {
      // 答案批（AskUserQuestionAnswer 契约）：每题 { id, selected: string[], custom? }。
      // 单选 selected 一个 label；多选 selected 多个；自由文本/自定义补充进 custom。
      const answers = questions.map((q, i) => {
        const d = drafts[i] ?? EMPTY_DRAFT
        const kind = kindOf(q)
        const selected = kind === 'multi' ? [...d.multi] : (d.single === undefined ? [] : [d.single])
        const custom = d.text.trim()
        return {
          id: q.id,
          selected,
          ...(custom === '' ? {} : { custom }),
        }
      })
      await pending.answer({ answers })
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try { await pending.cancel() } finally { setBusy(false) }
  }

  if (current === undefined) return null
  const kind = kindOf(current)
  const options = current.options ?? []

  return (
    <div className={css.card} data-collapsed={collapsed || undefined}>
      {/* q-head：题型图标 + 组名/标题 + 收起/放弃 */}
      <div className={css.head}>
        <span className={css.qIcon}><MessageCircle size={17} /></span>
        <span className={css.headTx}>
          <span className={css.qGroup}>提问</span>
          <span className={css.qTitle}>{current.question}</span>
        </span>
        <button
          type="button"
          className={css.iconBtn}
          aria-label={collapsed ? '展开问题' : '收起问题'}
          onClick={() => setCollapsed(c => !c)}
        >
          <ChevronUp size={16} style={{ transform: collapsed ? 'rotate(180deg)' : undefined }} />
        </button>
        <button type="button" className={css.iconBtn} aria-label="放弃整组问题" onClick={() => { void cancel() }}>
          <X size={15} />
        </button>
      </div>

      {!collapsed && (
        <>
          {/* 作答区：单选 radio / 多选 checkbox / 直接回答多行文本 */}
          {kind !== 'free' && (
            <div className={css.options}>
              {options.map((opt) => {
                const checked = kind === 'single' ? draft.single === opt.label : draft.multi.includes(opt.label)
                return (
                  <OptionRow
                    key={opt.label}
                    kind={kind}
                    label={opt.label}
                    description={opt.description}
                    checked={checked}
                    onToggle={() => {
                      if (kind === 'single') setDraft({ single: draft.single === opt.label ? undefined : opt.label })
                      else setDraft({ multi: checked ? draft.multi.filter(l => l !== opt.label) : [...draft.multi, opt.label] })
                    }}
                  />
                )
              })}
            </div>
          )}
          <div className={css.custom} data-free={kind === 'free' || undefined}>
            <PenLine size={14} className={css.customIcon} />
            <textarea
              className={css.customInput}
              placeholder={kind === 'free' ? '输入你的回答…' : '补充说明（可选）…'}
              value={draft.text}
              rows={kind === 'free' ? 3 : 1}
              onChange={(e) => setDraft({ text: e.target.value })}
            />
          </div>

          {/* q-foot：左下角翻页 + 右侧跳过/提交 */}
          <div className={css.foot}>
            {total > 1 && (
              <div className={css.pager}>
                <button type="button" className={css.pageBtn} aria-label="上一题" disabled={index === 0} onClick={() => setIndex(i => Math.max(0, i - 1))}>
                  <ChevronLeft size={16} />
                </button>
                <span className={css.pageNum}>{index + 1} / {total}</span>
                <button type="button" className={css.pageBtn} aria-label="下一题" disabled={index === total - 1} onClick={() => setIndex(i => Math.min(total - 1, i + 1))}>
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
            <span className={css.sp} />
            <button type="button" className={css.skipBtn} disabled={busy} onClick={() => { void cancel() }}>跳过本题</button>
            <button type="button" className={css.submitBtn} disabled={busy || !allAnswered} onClick={() => { void submitAll() }}>
              {busy ? '提交中…' : '提交'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
