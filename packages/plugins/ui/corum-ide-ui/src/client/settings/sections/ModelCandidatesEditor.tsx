/**
 * 「子 Agent 候选模型」的一行候选编辑器（issue #165；两个配置面共用）。
 *
 * 用户 2026-11-12 的交互要求：「点击添加 → 选择已配置的供应商模型 + 思考程度 →
 * 标签可给一些常用的让用户直接点」。于是每一行由三部分组成：
 *   ① **路由三列**（供应商 / 模型 / 思考程度）——由调用方经 `renderRoute` 决定控件：
 *      「智能体设置」页有模型目录（`session/modelCatalog`），传目录下拉
 *      （`ModelPairField`）；Agent 预设编辑页没有目录，用本组件的默认原始文本输入。
 *   ② **标签**：常用标签 chips（`COMMON_CANDIDATE_TAGS`，点一次加入、再点一次移除）
 *      + 自由输入框（中英文逗号分隔，规则见 `child-model-candidates.ts`）。
 *   ③ 可选**备注** + 删除按钮。
 *
 * 受控组件：只渲染传入的 `rows`，每次改动把**新的一份**交给 `onChange`——草稿状态的
 * 唯一所有者是调用方（全局组是 section 的 `useState`，预设页是编辑页的 `setDraft`），
 * 本组件不持有任何自己的状态。
 */

import type { ReactNode } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { ModelCandidateRow } from './child-model-candidates.ts'
import type { CandidateRole } from './child-model-candidates.ts'
import {
  CANDIDATE_ROLE_LABELS, COMMON_CANDIDATE_TAGS, emptyCandidateDraft, parseCandidateTags, toggleCandidateTag,
} from './child-model-candidates.ts'
import css from '../SettingsSections.module.css'

/** 一行候选的局部补丁（`undefined` 字段表示不改）。 */
export type CandidateRowPatch = Partial<ModelCandidateRow>

/** Props for the shared candidate-row editor. */
export interface ModelCandidatesEditorProps {
  /** 当前候选行（受控）。 */
  rows: readonly ModelCandidateRow[]
  /** 整份交回的新行数组（添加 / 删除 / 任一字段变更）。 */
  onChange: (rows: ModelCandidateRow[]) => void
  /** 只读（保存中 / 无写权限 / 上级自定义开关关闭）。 */
  disabled?: boolean
  /**
   * 路由三列的自定义渲染器（有模型目录的调用方传，见文件头）。
   *
   * 缺省渲染三个原始文本输入（供应商 id / 模型 id / 思考程度档位 id）——预设编辑页没有
   * 模型目录，且它编辑的是 wire 值本身。
   */
  renderRoute?: (row: ModelCandidateRow, index: number, patch: (next: CandidateRowPatch) => void) => ReactNode
  /** 路由行上方的列名（与 `renderRoute` 的列数对应）。 */
  routeHeaders?: readonly string[]
  /** 「添加候选」按钮的说明文案（缺省一句通用提示）。 */
  hint?: string
}

/** 默认（无目录）路由三列的列宽。 */
const DEFAULT_ROUTE_COLUMNS = 'minmax(90px, 1fr) minmax(90px, 1fr) minmax(110px, 1fr) auto'

/**
 * Render one row per candidate: route columns, tag chips, free tag entry, note.
 * @param props - controlled rows and the change sink.
 * @returns the candidate list with its add button.
 */
export function ModelCandidatesEditor(props: ModelCandidatesEditorProps) {
  const { rows, onChange, disabled = false, renderRoute, routeHeaders, hint } = props
  /** 改一行（下标寻址；删除后下标会变，故每次都用当次渲染的下标）。 */
  const patchRow = (index: number, patch: CandidateRowPatch): void => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }
  const removeRow = (index: number): void => {
    onChange(rows.filter((_, i) => i !== index))
  }
  const headers = routeHeaders ?? ['供应商', '模型', '思考程度']
  const columns = renderRoute === undefined ? DEFAULT_ROUTE_COLUMNS : `minmax(150px, 1fr) auto`
  return (
    <div className={css.formCol} style={{ gap: 8 }}>
      {rows.length > 0 && (
        <div
          style={{ display: 'grid', gridTemplateColumns: columns, gap: 6, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}
        >
          {headers.map(header => <span key={header}>{header}</span>)}
          <span />
        </div>
      )}
      {rows.map((row, index) => {
        const tags = parseCandidateTags(row.tagsText)
        return (
          <div
            key={`candidate-${index}`}
            data-child-model-candidate={index}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              padding: '8px 0',
              borderTop: index === 0 ? 'none' : '1px solid var(--dsw-alias-separator-primary)',
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: columns, gap: 6, alignItems: 'center' }}>
              {renderRoute === undefined
                ? (
                  <>
                    <input
                      type="text"
                      value={row.provider}
                      placeholder="提供方 id"
                      aria-label={`提供方 — 候选 ${index + 1}`}
                      disabled={disabled}
                      onChange={event => { patchRow(index, { provider: event.target.value }) }}
                    />
                    <input
                      type="text"
                      value={row.model}
                      placeholder="模型 id"
                      aria-label={`模型 — 候选 ${index + 1}`}
                      disabled={disabled}
                      onChange={event => { patchRow(index, { model: event.target.value }) }}
                    />
                    <input
                      type="text"
                      value={row.reasoningEffort ?? ''}
                      placeholder="默认档"
                      aria-label={`思考程度 — 候选 ${index + 1}`}
                      disabled={disabled}
                      onChange={event => { patchRow(index, { reasoningEffort: event.target.value }) }}
                    />
                  </>
                )
                : renderRoute(row, index, patch => { patchRow(index, patch) })}
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
            {/* 这条候选给**哪类子 Agent** 用（用户 2026-11-12：「勾选可给哪类子 Agent 候选」）。
                两类都勾 = 不写 roles（默认），只勾一类 = 只有那类的候选表里出现。 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
              <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>可给哪类子 Agent</span>
              {(Object.keys(CANDIDATE_ROLE_LABELS) as CandidateRole[]).map(role => {
                const currentRoles: CandidateRole[] = row.roles ?? ['worker', 'research']
                const checked = currentRoles.includes(role)
                return (
                  <label
                    key={role}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: disabled ? 'default' : 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled || (checked && currentRoles.length === 1)}
                      aria-label={`${CANDIDATE_ROLE_LABELS[role]}子 Agent — 候选 ${index + 1}`}
                      data-candidate-role={role}
                      data-candidate-row={index}
                      onChange={() => {
                        // 不许两类都不勾：取消最后一类没有意义（哪类都用不上 = 该删掉这行），
                        // 故把「只剩一类时」的取消禁用掉，保留一个确定态。
                        const next = checked ? currentRoles.filter(value => value !== role) : [...currentRoles, role]
                        patchRow(index, { roles: next.length === 0 ? currentRoles : next })
                      }}
                    />
                    <span>{CANDIDATE_ROLE_LABELS[role]}</span>
                  </label>
                )
              })}
            </div>
            {/* 常用标签（点一次加入、再点一次移除）+ 自由输入。chips 的选中态由
                `tagsText` 派生 —— 单一事实源，见 child-model-candidates.ts。 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              {COMMON_CANDIDATE_TAGS.map(tag => {
                const active = tags.includes(tag)
                return (
                  <button
                    key={tag}
                    type="button"
                    data-candidate-tag={tag}
                    data-candidate-row={index}
                    aria-pressed={active}
                    aria-label={`${active ? '移除标签' : '添加标签'} ${tag} — 候选 ${index + 1}`}
                    disabled={disabled}
                    onClick={() => { patchRow(index, { tagsText: toggleCandidateTag(row.tagsText, tag) }) }}
                    style={{
                      padding: '1px 7px',
                      fontSize: 11,
                      lineHeight: 1.6,
                      borderRadius: 9,
                      cursor: disabled ? 'default' : 'pointer',
                      border: `1px solid ${active ? 'var(--dsw-alias-state-primary)' : 'var(--dsw-alias-separator-primary)'}`,
                      background: active ? 'var(--dsw-alias-state-primary)' : 'transparent',
                      color: active ? 'var(--dsw-alias-label-on-primary, #fff)' : 'var(--dsw-alias-label-secondary)',
                    }}
                  >
                    {tag}
                  </button>
                )
              })}
              <input
                type="text"
                value={row.tagsText}
                placeholder="或自定义标签，逗号分隔"
                aria-label={`能力标注 — 候选 ${index + 1}`}
                disabled={disabled}
                list={`candidate-tags-${index}`}
                style={{ flex: 1, minWidth: 140 }}
                onChange={event => { patchRow(index, { tagsText: event.target.value }) }}
              />
              <datalist id={`candidate-tags-${index}`}>
                {COMMON_CANDIDATE_TAGS.map(tag => <option key={tag} value={tag} />)}
              </datalist>
            </div>
            <input
              type="text"
              value={row.noteText}
              placeholder="给 Agent 看的备注（可选）"
              aria-label={`备注 — 候选 ${index + 1}`}
              disabled={disabled}
              onChange={event => { patchRow(index, { noteText: event.target.value }) }}
            />
          </div>
        )
      })}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          className={css.stepperBtn}
          aria-label="添加候选"
          disabled={disabled}
          onClick={() => { onChange([...rows, emptyCandidateDraft()]) }}
        >
          <Plus size={12} />
        </button>
        <span className={css.stepperHint}>
          {hint ?? '只会保存「供应商 + 模型」都选了的行；标签点选或自由输入'}
        </span>
      </div>
    </div>
  )
}