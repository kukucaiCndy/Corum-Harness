/**
 * SettingsAdvancedSection — 高级分区（PRD v2 §4.10）。
 *
 * ## 本轮（M4 尾 + §6.1 信任修复）的两件事
 *
 * 1. **AD6「轨迹视图」自「通用」页移入本页**（PRD §4.10 AD6；用户 2026-09-16：
 *    「将开启轨迹视图开关移动到高级」）。真源是**设置 ns**（`ui-chat.transcriptView`，
 *    模式 `normal` | `compact`，默认 **`compact`**），故本页**直接接线**，
 *    而不是把官方/corum 注册的行「搬」过来
 *    —— 子槽「声明即独占」，跨分区搬运在架构上不可行（见台账
 *    `lesson.slots.declaring-is-claiming-blocks-rehoming`）。
 *
 * 2. **四个死控件按 §6.1 降级**：`打开 settings.yaml` / `打开配置目录` /
 *    `复制诊断信息` / `打开日志目录` 原本是**可点但无 onClick 的空壳**
 *    （点了什么都不会发生）。PRD §6.1：「未就绪条目一律**禁用 + 标注未生效**，
 *    **禁止**保留『能点但不落盘』的形态」⇒ 现一律 `disabled` + 「未上线」badge。
 *
 *    它们各自缺什么（PRD §4.10）：
 *    - AD1 打开 settings.yaml：有官方 `settings.action` 机制，但 corum 侧未接
 *    - AD2 打开配置目录 / AD4 打开日志目录：需 host 的「文件管理器中显示」能力（未确证）
 *    - AD3 复制诊断信息：需新建「诊断信息收集」（版本 / 平台 / 插件清单）数据源
 *
 * ✅ AD5「开发者模式」**本来就是真实项**（`localStorage['corum.settings.developerMode']`，
 * 消费方 `AppFrame.tsx` / `session-bar.tsx` / `SettingsAgentPresetsSection.tsx`），保持接线不动。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsAdvancedSection
 */

import { useContext, useEffect, useState } from 'react'
import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { Switch } from '../Switch.tsx'
import { Badge } from '../Badge.tsx'
import { GlassButton } from '../shared.tsx'
import { CorumSettingsContext } from '../shared.tsx'
import { useDeveloperMode, setDeveloperMode } from '../developer-mode.ts'

/* ── 高级（PRD §4.10）──────────────────────────────────────────────── */

/** corum chat 设置 ns（轨迹视图真源；与 host 同 namespace/schema）。 */
const CHAT_NS = 'ui-chat'
/** 轨迹视图字段（`TRANSCRIPT_VIEW_FIELD`）。 */
const TRANSCRIPT_VIEW_FIELD = 'transcriptView'

/** 轨迹视图模式（`TRANSCRIPT_VIEW_MODES`；默认 `compact`）。 */
const TRANSCRIPT_OPTIONS = [
  { id: 'normal', label: '普通（完整展示）' },
  { id: 'compact', label: '紧凑（默认）' },
]

/** 未上线 badge（PRD §6.1）。 */
const OFFLINE = <Badge label="未上线" variant="offline" />

/**
 * 高级分区：配置文件 / 诊断 / 对话显示。
 *
 * @returns the advanced settings section.
 */
export function AdvancedSection() {
  const developerMode = useDeveloperMode()
  const settings = useContext(CorumSettingsContext)
  const [, force] = useState(0)
  useEffect(() => {
    if (settings === null) return undefined
    void settings.describe.ensure()
    return settings.describe.subscribe(() => { force(v => v + 1) })
  }, [settings])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 轨迹视图：settings 面未就绪时降级为「只读展示」，不阻塞本页其余部分。
  const snapshot = settings?.describe.getSnapshot()
  const ns = snapshot?.view?.namespaces.find(n => n.ns === CHAT_NS)
  const user = (ns?.user ?? {}) as { transcriptView?: string }
  const resolved = (ns?.value ?? {}) as { transcriptView?: string }
  const writable = snapshot?.view?.writable === true
  const loading = snapshot?.status === 'loading' || snapshot?.status === 'idle'
  const disabled = !writable || busy || loading
  const transcript = user.transcriptView ?? resolved.transcriptView ?? 'compact'
  const transcriptOverridden = user.transcriptView !== undefined

  /**
   * 写入轨迹视图模式。
   *
   * @param mode - `normal` 或 `compact`。
   */
  const applyTranscript = async (mode: string): Promise<void> => {
    if (settings === null) return
    setBusy(true)
    setError(null)
    try {
      const res = await settings.mutate(CHAT_NS, [{ op: 'set' as const, path: [TRANSCRIPT_VIEW_FIELD], value: mode }], ns?.revision)
      if (!res.ok) setError(res.error?.message ?? '写入失败')
      else if (res.value !== undefined) settings.describe.acceptView(res.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {error !== null && <p style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{error}</p>}
      <SettingGroup title="对话显示">
        <SettingRow
          label="轨迹视图"
          desc="对话区是否展示轨迹视图，以及是普通还是紧凑呈现。"
          badge={transcriptOverridden ? <Badge label="已修改" /> : undefined}
          divider={false}
        >
          <SelectField
            value={transcript}
            options={TRANSCRIPT_OPTIONS}
            disabled={settings === null || disabled}
            onChange={id => { void applyTranscript(id) }}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="配置文件">
        <SettingRow label="打开 settings.yaml" desc="直接编辑全局配置文件。" badge={OFFLINE}>
          <GlassButton disabled>打开</GlassButton>
        </SettingRow>
        <SettingRow label="打开配置目录" desc="在文件管理器中显示配置目录。" badge={OFFLINE} divider={false}>
          <GlassButton disabled>打开</GlassButton>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="诊断">
        <SettingRow label="复制诊断信息" desc="复制版本、平台与运行环境信息到剪贴板。" badge={OFFLINE}>
          <GlassButton disabled>复制</GlassButton>
        </SettingRow>
        <SettingRow label="打开日志目录" desc="在文件管理器中显示日志目录。" badge={OFFLINE}>
          <GlassButton disabled>打开</GlassButton>
        </SettingRow>
        <SettingRow label="开发者模式" desc="开启后 Agent 预设显示「继承自」，可编排非标准模式" divider={false}>
          <Switch checked={developerMode} onChange={v => setDeveloperMode(v)} />
        </SettingRow>
      </SettingGroup>
    </>
  )
}
