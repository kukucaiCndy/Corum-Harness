/**
 * 「子 Agent 候选模型」候选集编辑器（issue #165，Agent 预设编辑页）。
 *
 * 受控组件：只渲染传入的 `mode` / `candidates`，每次改动把**新的一份**交给
 * `onChange`——草稿状态的唯一所有者仍是编辑页（与「模型与并发」其余字段一致），
 * 本组件不持有任何自己的状态。
 *
 * 两个模式的语义见 `child-model-candidates.ts` 的不变式 ①：默认「使用全局候选集」
 * 保存时**不写** `childModelCandidates` 键。
 *
 * 逐行编辑器（路由三列 + 常用标签 chips + 自由标签 + 备注 + 删除）由
 * `ModelCandidatesEditor` 提供——与「智能体设置」页的全局候选集**同一个组件**；
 * 本页没有模型目录，故走它的默认原始文本输入（编辑的是 wire 值本身）。
 */

import type {
  ChildModelCandidatesMode, ModelCandidateRow,
} from './child-model-candidates.ts'
import { ModelCandidatesEditor } from './ModelCandidatesEditor.tsx'
import css from '../SettingsSections.module.css'

/** Props for the candidate-set editor. */
export interface ChildModelCandidatesEditorProps {
  /** 候选集来源（`global` = 用全局候选集）。 */
  mode: ChildModelCandidatesMode
  /** 本预设自定义的候选行（`mode === 'custom'` 时才渲染）。 */
  candidates: readonly ModelCandidateRow[]
  /** 改来源或改候选行（整份交回）。 */
  onChange: (mode: ChildModelCandidatesMode, candidates: ModelCandidateRow[]) => void
  /** 「自定义设置」关闭时整块只读（与「模型与并发」卡片其余控件一致）。 */
  disabled?: boolean
}

/**
 * Render the candidate-set source choice and, when custom, its rows.
 * @param props - source mode, rows, and the change sink.
 * @returns the editor block.
 */
export function ChildModelCandidatesEditor(props: ChildModelCandidatesEditorProps) {
  const { mode, candidates, onChange, disabled = false } = props
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
        <ModelCandidatesEditor
          rows={candidates}
          disabled={disabled}
          onChange={rows => { onChange('custom', rows) }}
          hint={candidates.length === 0
            ? '还没有候选；留空等于不覆盖（运行期用全局候选集）'
            : '只有填了提供方与模型的行会被保存'}
        />
      )}
    </div>
  )
}