/**
 * 「子 Agent 候选模型」候选集编辑器（issue #165，Agent 预设编辑页）。
 *
 * 受控组件：只渲染传入的 `mode` / `candidates`，每次改动把**新的一份**交给
 * `onChange`——草稿状态的唯一所有者仍是编辑页（与「模型与并发」其余字段一致），
 * 本组件不持有任何自己的状态。
 *
 * 两个模式的语义见 `child-model-candidates.ts` 的不变式 ①：默认「使用全局候选集」
 * 保存时**不写** `childModelCandidates` 键。
 */

import { Plus, Trash2 } from 'lucide-react'
import type {
  ChildModelCandidateDraft, ChildModelCandidatesMode,
} from './child-model-candidates.ts'
import { emptyCandidateDraft } from './child-model-candidates.ts'
import css from '../SettingsSections.module.css'

/** Props for the candidate-set editor. */
export interface ChildModelCandidatesEditorProps {
  /** 候选集来源（`global` = 用全局候选集）。 */
  mode: ChildModelCandidatesMode
  /** 本预设自定义的候选行（`mode === 'custom'` 时才渲染）。 */
  candidates: readonly ChildModelCandidateDraft[]
  /** 改来源或改候选行（整份交回）。 */
  onChange: (mode: ChildModelCandidatesMode, candidates: ChildModelCandidateDraft[]) => void
  /** 「自定义设置」关闭时整块只读（与「模型与并发」卡片其余控件一致）。 */
  disabled?: boolean
}

/** 一行候选的输入宽度（四列 + 删除按钮）。 */
const ROW_COLUMNS = 'minmax(90px, 1fr) minmax(90px, 1fr) minmax(120px, 1.4fr) minmax(120px, 1.4fr) auto'

/**
 * Render the candidate-set source choice and, when custom, its rows.
 * @param props - source mode, rows, and the change sink.
 * @returns the editor block.
 */
export function ChildModelCandidatesEditor(props: ChildModelCandidatesEditorProps) {
  const { mode, candidates, onChange, disabled = false } = props
  /** 改一行（下标寻址；删除后下标会变，故每次都用当次渲染的下标）。 */
  const editRow = (index: number, patch: Partial<ChildModelCandidateDraft>) => {
    onChange(mode, candidates.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }
  const removeRow = (index: number) => {
    onChange(mode, candidates.filter((_, i) => i !== index))
  }
  return (
    <div className={css.formCol} style={{ gap: 6 }}>
      <label className={css.fieldLabelSm}>子 Agent 候选模型（默认用全局候选集）</label>
      <div role="radiogroup" aria-label="子 Agent 候选模型来源" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: disabled ? 'default' : 'pointer' }}>
          <input
            type="radio"
            name="child-model-candidates-mode"
            value="global"
            checked={mode === 'global'}
            disabled={disabled}
            onChange={() => { onChange('global', [...candidates]) }}
          />
          使用全局候选集
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: disabled ? 'default' : 'pointer' }}>
          <input
            type="radio"
            name="child-model-candidates-mode"
            value="custom"
            checked={mode === 'custom'}
            disabled={disabled}
            onChange={() => { onChange('custom', [...candidates]) }}
          />
          本预设自定义候选集
        </label>
      </div>

      {mode === 'custom' && (
        <div className={css.formCol} style={{ gap: 6 }}>
          {candidates.length > 0 && (
            <div
              style={{ display: 'grid', gridTemplateColumns: ROW_COLUMNS, gap: 6, alignItems: 'center', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}
            >
              <span>提供方</span>
              <span>模型</span>
              <span>能力标注（逗号分隔）</span>
              <span>备注</span>
              <span />
            </div>
          )}
          {candidates.map((row, index) => (
            <div
              key={`candidate-${index}`}
              data-child-model-candidate={index}
              style={{ display: 'grid', gridTemplateColumns: ROW_COLUMNS, gap: 6, alignItems: 'center' }}
            >
              <input
                type="text"
                value={row.provider}
                placeholder="提供方 id"
                aria-label={`提供方 — 候选 ${index + 1}`}
                disabled={disabled}
                onChange={event => { editRow(index, { provider: event.target.value }) }}
              />
              <input
                type="text"
                value={row.model}
                placeholder="模型 id"
                aria-label={`模型 — 候选 ${index + 1}`}
                disabled={disabled}
                onChange={event => { editRow(index, { model: event.target.value }) }}
              />
              <input
                type="text"
                value={row.tagsText}
                placeholder="如：长上下文, 快速"
                aria-label={`能力标注 — 候选 ${index + 1}`}
                disabled={disabled}
                onChange={event => { editRow(index, { tagsText: event.target.value }) }}
              />
              <input
                type="text"
                value={row.noteText}
                placeholder="给 Agent 看的备注（可选）"
                aria-label={`备注 — 候选 ${index + 1}`}
                disabled={disabled}
                onChange={event => { editRow(index, { noteText: event.target.value }) }}
              />
              <button
                type="button"
                className={css.stepperBtn}
                aria-label={`移除候选 ${index + 1}`}
                disabled={disabled}
                onClick={() => { removeRow(index) }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className={css.stepperBtn}
              aria-label="添加候选"
              disabled={disabled}
              onClick={() => { onChange('custom', [...candidates, emptyCandidateDraft()]) }}
            >
              <Plus size={12} />
            </button>
            <span className={css.stepperHint}>
              {candidates.length === 0
                ? '还没有候选；留空等于不覆盖（运行期用全局候选集）'
                : '只有填了提供方与模型的行会被保存'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}