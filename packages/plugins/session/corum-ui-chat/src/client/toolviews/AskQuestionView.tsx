/**
 * fork（corum）2026-10-21：`ask_user_question` 行 —— 提问的**可读**呈现。
 *
 * 官方 `AskQuestionRow` 在参数不合规时回落到通用工具行，把整段参数字符串当摘要
 * （实测：模型写出坏键的四个并行提问 ⇒ 会话里出现一屏原始 JSON）。本视图替换该行，
 * 判据只有一条：**能读出什么就显示什么，读不出的降级成一句人话**。
 *
 * 三态：
 *   - 运行中 → 「等待回答」；
 *   - 已结束且带错误码（`ASK_ABORTED` / `ASK_CANCELLED`）→ 「提问被打断 / 已取消」；
 *   - 已结束正常 → 「已回答 x/y」。
 *
 * 参数完全不完整时：标题仍是「提问」，摘要写「参数不完整」，展开体给原始参数
 * （折叠、等宽、可滚动），**不把 JSON 顶到行摘要上**。
 *
 * @module @corum/corum-ui-chat/toolviews/AskQuestionView
 */
import { memo, useState } from 'react'
import { ChevronDown, ChevronUp, CircleHelp, ListChecks, MessageSquareText } from 'lucide-react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallBlock } from '@corum/corum-ui-conversation/client'
import { askQuestionModel, type AskQuestionModel } from './ask-question.ts'
import css from './AskQuestion.module.css'

type TFunc = PropsLocale<'chat'>['t']

/** 行状态 → (文案 key, 色档类)。 */
function stateOf(model: AskQuestionModel): { key: 'ask.running' | 'ask.blocked' | 'ask.cancelled' | 'ask.answered'; cls: string } {
  if (model.running) return { key: 'ask.running', cls: css.stateRunning }
  if (model.errorCode === 'ASK_ABORTED') return { key: 'ask.blocked', cls: css.stateBlocked }
  if (model.errorCode === 'ASK_CANCELLED') return { key: 'ask.cancelled', cls: css.stateMuted }
  return { key: 'ask.answered', cls: css.stateOk }
}

/** 摘要：有题就按「N 个问题」+ 首题题干；没有题就明说参数不完整。 */
function summaryOf(model: AskQuestionModel, t: TFunc): string {
  if (model.questions.length === 0) return t('ask.malformed')
  const first = model.questions[0]?.question ?? ''
  if (first === '') return t('ask.count', { n: model.questions.length })
  return model.questions.length === 1 ? first : `${first} …`
}

/** 单题展开体：题干 + 选项/可自由回答提示。 */
function QuestionBody({ entry, t }: { entry: AskQuestionModel['questions'][number]; t: TFunc }) {
  return (
    <li className={css.item}>
      <div className={css.itemHead}>
        {entry.header !== undefined && <span className={css.itemHeader}>{entry.header}</span>}
        {entry.multiSelect && <span className={css.itemBadge}>{t('ask.multi')}</span>}
      </div>
      <div className={css.itemQuestion}>{entry.question === '' ? t('ask.noQuestion') : entry.question}</div>
      {entry.options.length === 0
        ? <div className={css.freeHint}>{t('ask.freeText')}</div>
        : (
          <ul className={css.options}>
            {entry.options.map(option => (
              <li key={option.label} className={css.option}>
                <span className={css.optionLabel}>{option.label}</span>
                {option.description !== undefined && <span className={css.optionDesc}>{option.description}</span>}
              </li>
            ))}
          </ul>
        )}
    </li>
  )
}

/** 一行 ask_user_question。 */
export const AskQuestionView = memo(function AskQuestionView({ block, t }: ToolCallViewProps & { t: TFunc }) {
  const model = askQuestionModel(block as ToolCallBlock)
  const [expanded, setExpanded] = useState(false)
  const state = stateOf(model)
  const malformed = model.questions.length === 0

  return (
    <div className={css.card} data-corum-ask-card="" data-state={model.running ? 'running' : 'settled'}>
      <div className={css.head}>
        <span className={css.iconBox}>
          <CircleHelp size={14} strokeWidth={2} />
        </span>
        <span className={css.title}>{t('ask.title')}</span>
        <span className={`${css.state} ${state.cls}`}>{t(state.key)}</span>
        {!malformed && <span className={css.chip}>{t('ask.count', { n: model.questions.length })}</span>}
        {!model.running && !malformed && model.answered > 0 && (
          <span className={css.chip}>{t('ask.answeredCount', { answered: model.answered, total: model.total })}</span>
        )}
        <span className={css.spacer} />
        <span className={css.summary} title={summaryOf(model, t)}>{summaryOf(model, t)}</span>
        <button
          type="button"
          className={css.chevronBtn}
          aria-expanded={expanded}
          aria-label={expanded ? t('ask.collapse') : t('ask.expand')}
          title={expanded ? t('ask.collapse') : t('ask.expand')}
          onClick={() => { setExpanded(value => !value) }}
        >
          {expanded ? <ChevronUp size={13} strokeWidth={2} /> : <ChevronDown size={13} strokeWidth={2} />}
        </button>
      </div>

      {expanded && (
        <div className={css.body}>
          {malformed
            ? (
              <div className={css.malformed}>
                <div className={css.malformedHint}>
                  <MessageSquareText size={13} strokeWidth={2} />
                  <span>{t('ask.malformedDetail')}</span>
                </div>
                <pre className={css.raw}>{model.raw === '' ? t('ask.empty') : model.raw}</pre>
              </div>
            )
            : (
              <ol className={css.items}>
                {model.questions.map((entry, index) => (
                  <QuestionBody key={`${index}-${entry.header ?? ''}`} entry={entry} t={t} />
                ))}
              </ol>
            )}
          {!malformed && !model.running && (
            <div className={css.foot}>
              <ListChecks size={12} strokeWidth={2} />
              <span>{model.answered === model.total ? t('ask.allAnswered') : t('ask.unanswered')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
