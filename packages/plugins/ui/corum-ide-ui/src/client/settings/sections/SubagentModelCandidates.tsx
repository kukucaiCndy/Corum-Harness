/** 现有 subagent-model-selection 配置的可见入口。 */
import { useState } from 'react'
import { SettingGroup } from '../SettingGroup.tsx'
import { GlassButton, type CorumSettingsFace } from '../shared.tsx'
import css from './SubagentModelCandidates.module.css'

const NS = 'subagent-model-selection'
interface Candidate { provider: string; model: string; description?: string }
interface Selection { enabled: boolean; allowedModels: Candidate[] }
interface Catalog {
  providers: { id: string; label: string }[]
  modelsByProvider: Record<string, { id: string; label: string }[]>
}
const keyOf = (route: Candidate): string => `${route.provider}\0${route.model}`

/** 多选与能力说明一起保存，保留目录里暂时消失的已选模型。 */
export function SubagentModelCandidates({ settings, catalog }: { settings: CorumSettingsFace; catalog: Catalog }) {
  const snapshot = settings.describe.getSnapshot()
  const entry = snapshot.view?.namespaces.find(ns => ns.ns === NS)
  const current = (entry?.value ?? { enabled: false, allowedModels: [] }) as Selection
  const [draft, setDraft] = useState<Selection>()
  const [revision, setRevision] = useState<number>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const value = draft ?? current
  const writable = entry !== undefined && snapshot.view?.writable === true && !saving
  const rows = new Map<string, Candidate & { label: string }>(catalog.providers.flatMap(provider => (catalog.modelsByProvider[provider.id] ?? []).map(model => {
    const route = { provider: provider.id, model: model.id }
    return [keyOf(route), { ...route, label: `${provider.label} · ${model.label}` }] as const
  })))
  for (const route of [...current.allowedModels, ...value.allowedModels]) {
    if (!rows.has(keyOf(route))) rows.set(keyOf(route), { ...route, label: `${route.provider}/${route.model}（当前目录未提供）` })
  }
  const stage = (next: Selection): void => {
    if (draft === undefined) setRevision(entry?.revision)
    setDraft(next)
    setError(undefined)
  }
  const save = async (): Promise<void> => {
    if (!writable || draft === undefined || (value.enabled && value.allowedModels.length === 0)) return
    setSaving(true)
    setError(undefined)
    try {
      const result = await settings.mutate(NS, [
        { op: 'set', path: ['enabled'], value: value.enabled },
        { op: 'set', path: ['allowedModels'], value: value.allowedModels },
      ], revision)
      if (!result.ok) setError(result.error?.message ?? '保存失败，请重试。')
      else {
        if (result.value !== undefined) settings.describe.acceptView(result.value)
        setDraft(undefined)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  return <SettingGroup title="子 Agent 候选模型">
    <p className={css.hint}>开启后，主 Agent 可按能力说明选择下方授权模型；不指定时沿用现有默认模型。保存后仅影响新会话。</p>
    <label className={css.toggle}>
      <input type="checkbox" checked={value.enabled} disabled={!writable} onChange={event => stage({ ...value, enabled: event.target.checked })} />
      允许主 Agent 选择子 Agent 模型
    </label>
    {value.enabled && <div className={css.models}>
      {[...rows].map(([key, row]) => {
        const selected = value.allowedModels.find(route => keyOf(route) === key)
        return <div key={key} className={css.model}>
          <label className={css.toggle}>
            <input type="checkbox" checked={selected !== undefined} disabled={!writable} onChange={event => stage({
              ...value, allowedModels: event.target.checked
                ? [...value.allowedModels, { provider: row.provider, model: row.model }]
                : value.allowedModels.filter(route => keyOf(route) !== key),
            })} />
            {row.label}
          </label>
          {selected !== undefined && <input className={css.description} aria-label={`${row.provider}/${row.model} 能力说明`} placeholder="能力说明，如：长上下文、多模态、快速编程" value={selected.description ?? ''} disabled={!writable} onChange={event => stage({
            ...value, allowedModels: value.allowedModels.map(route => keyOf(route) === key ? { ...route, description: event.target.value } : route),
          })} />}
        </div>
      })}
      {rows.size === 0 && <p className={css.hint}>当前没有可选模型，请先配置模型提供方。</p>}
    </div>}
    {value.enabled && value.allowedModels.length === 0 && <p className={css.hint}>保存前请至少选择一个模型。</p>}
    {entry === undefined && <p className={css.hint}>候选模型设置尚未就绪。</p>}
    {error !== undefined && <p role="alert" className={css.hint}>{error}</p>}
    <div className={css.actions}>
      <GlassButton disabled={!writable || draft === undefined || (value.enabled && value.allowedModels.length === 0)} onClick={() => { void save() }}>保存候选模型</GlassButton>
      {draft !== undefined && <GlassButton disabled={saving} onClick={() => { setDraft(undefined); setError(undefined) }}>放弃修改</GlassButton>}
    </div>
  </SettingGroup>
}
