/**
 * SettingsAppearanceSection — 外观分区（PRD v2 §4.3）。
 *
 * ## M4「双入口归一」：本页成为字体与主题的**唯一入口**
 *
 * 用户第三批裁定「**只留外观页**」⇒ 通用页（`settings.general.item` 槽）里
 * 官方 `ui-theme` 注册的两行（`appearance` / `font-size`）已从通用页移除，
 * **唯一入口 = 本页**（PRD §4.13 GE-b、§11 C2）。
 *
 * ## 四个「面」中的两个面在本页（PRD §4.3.1）
 *
 * | 面 | 条目 | 真源 | 状态 |
 * |---|---|---|---|
 * | UI | 界面字体 | ➕ 新建 | 未上线 |
 * | UI | 界面字号 | ➕ 新建（用户 `#9`） | 未上线 |
 * | 会话 | **会话正文字号** | ✅ `ui-theme.fontSize`（默认 **14**，范围 12~17） | **已接线** |
 * | — | **外观主题** | ✅ `ui-theme.preference`（`light`/`dark`/`system`，默认 `system`） | **已接线** |
 *
 * ⚠️ 终端字体在「终端」页、编辑器字体在「编辑器」页 —— **四面相互独立，不共用默认等宽**（用户 `#1`/`#9`）。
 * ⚠️ **本页原先的「代码字体」已删除**（`#1` 把它拆到编辑器页 E1 与终端页 T10）；
 * 原先「界面字号」硬编码为 `13` 是**错的**（`ui-theme.fontSize` 的默认值是 **14**），
 * 且它当时实际是「会话正文字号」的语义 —— 现按 `#9` 拆成两项，各归其位。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsAppearanceSection
 */

import { useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { Badge } from '../Badge.tsx'
import { ColorChips } from '../ColorChips.tsx'
import { CorumSettingsContext } from '../shared.tsx'
import { StartupAnimationSetting } from '../StartupAnimationSetting.tsx'
import { ACCENT_OPTIONS, DEFAULT_ACCENT_ID, getAccentId, setAccentId, subscribeAccent } from '../../appearance-accent.ts'
import { UI_FONT_BASE_DEFAULT_PX, UI_FONT_BASE_OPTIONS, getUiFontBase, setUiFontBase, subscribeUiFontBase } from '../../ui-font-scale.ts'
import { UI_DENSITY_DEFAULT_ID, UI_DENSITY_OPTIONS, getUiDensityId, setUiDensity, subscribeUiDensity } from '../../ui-density.ts'
import { UI_FONT_FAMILY_DEFAULT_ID, UI_FONT_FAMILY_OPTIONS, getUiFontFamilyId, setUiFontFamily, subscribeUiFontFamily } from '../../ui-font-family.ts'

/* ── 外观（PRD §4.3）──────────────────────────────────────────────── */

/** 官方主题插件拥有的设置 namespace（`ui-theme`）。 */
const UI_THEME_NS = 'ui-theme'

/** 主题偏好字段（`THEME_PREFERENCE_FIELD`）。 */
const PREFERENCE_FIELD = 'preference'
/** 会话正文字号字段（`FONT_SIZE_FIELD`）。 */
const FONT_SIZE_FIELD = 'fontSize'

/** 内置主题偏好（`THEME_PREFERENCES`；默认 `system`）。 */
const THEME_OPTIONS = [
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'system', label: '跟随系统' },
]

/** 会话正文字号候选（`FONT_SIZE_MIN`=12 .. `FONT_SIZE_MAX`=17，默认 14）。 */
const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 17].map(n => ({ id: String(n), label: String(n) }))

/** 未上线 badge（PRD §6.1：未就绪条目一律「禁用 + 标注未生效」）。 */
const OFFLINE = <Badge label="未上线" variant="offline" />

/** 空回调：未上线控件均 `disabled`，此函数不可达，仅满足控件 props 必填。 */
const noop = () => { /* 控件已禁用，不可达 */ }

/** `ui-theme` 的用户层形。 */
interface ThemeView {
  preference?: string
  fontSize?: number
}

/**
 * 外观分区：主题 + 字体与排版 + 应用级通用项（界面语言 / 忙碌时回车）。
 *
 * 外观主题与会话正文字号已接线 `ui-theme`；其余条目为新建真源，禁用并标注未上线。
 *
 * 2026-09-16 重组：原「通用」页拆散，应用级项（界面语言 `language`、
 * 忙碌时回车 `composer-enter`）经 `settings.general.item` 子槽 renderSlot 迁入本页
 * （官方 locale / conversation fork 注册的行，本仓不能改注册方，故在本渲染点承接）。
 *
 * @param props - renderSlot（settings.general.item 子槽渲染器，index.tsx 声明下发）。
 * @returns the appearance settings section.
 */
export function AppearanceSection(_props?: {
  renderTabSlot?: () => ReactNode
  renderSlot?: (key: 'settings.general.item', owner: object, opts?: { only?: string }) => ReactNode
}) {
  const renderSlot = _props?.renderSlot
  const settings = useContext(CorumSettingsContext)
  const [, force] = useState(0)
  useEffect(() => {
    if (settings === null) return undefined
    void settings.describe.ensure()
    return settings.describe.subscribe(() => { force(v => v + 1) })
  }, [settings])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 当前强调色（同 bundle 内的轻量 store；改后 Shell 会重注册 token 覆盖层）。 */
  const accent = useSyncExternalStore(subscribeAccent, getAccentId)
  /** 当前界面基准字号（px）；改后 Shell 会把乘数写到根元素。 */
  const uiFontBase = useSyncExternalStore(subscribeUiFontBase, getUiFontBase)
  /** 当前界面密度档；改后 Shell 会把密度乘数写到根元素。 */
  const uiDensity = useSyncExternalStore(subscribeUiDensity, getUiDensityId)
  /** 当前界面字族档；改后 Shell 会把完整字族栈写到根元素。 */
  const uiFontFamily = useSyncExternalStore(subscribeUiFontFamily, getUiFontFamilyId)

  if (settings === null) return <p style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>settings 服务未就绪。</p>

  const snapshot = settings.describe.getSnapshot()
  const ns = snapshot.view?.namespaces.find(n => n.ns === UI_THEME_NS)
  const user = (ns?.user ?? {}) as ThemeView
  const resolved = (ns?.value ?? {}) as ThemeView
  const writable = snapshot.view?.writable === true
  const loading = snapshot.status === 'loading' || snapshot.status === 'idle'
  const disabled = !writable || busy || loading

  // 真源默认值（`theme-settings.ts`）：preference=system，fontSize=14。
  const preference = user.preference ?? resolved.preference ?? 'system'
  const fontSize = user.fontSize ?? resolved.fontSize ?? 14
  /** 该键是否被用户覆盖过（决定「已修改」badge）。 */
  const overridden = (field: keyof ThemeView): boolean => user[field] !== undefined

  /**
   * 写入 `ui-theme` 的单键。
   *
   * @param field - `preference` 或 `fontSize`。
   * @param value - 新值。
   */
  const apply = async (field: string, value: unknown): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await settings.mutate(UI_THEME_NS, [{ op: 'set' as const, path: [field], value }], ns?.revision)
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
      <StartupAnimationSetting />
      <SettingGroup title="主题">
        <SettingRow
          label="外观主题"
          desc="浅色 / 深色 / 跟随系统。"
          badge={overridden('preference') ? <Badge label="已修改" /> : undefined}
        >
          <SelectField
            value={preference}
            options={THEME_OPTIONS}
            disabled={disabled}
            onChange={id => { void apply(PREFERENCE_FIELD, id) }}
          />
        </SettingRow>
        <SettingRow
          label="强调色"
          desc="高亮、链接与品牌元素使用的颜色（品牌 token 层）。选后立即生效，随明暗主题自动取对应取值。"
          badge={accent !== DEFAULT_ACCENT_ID ? <Badge label="已修改" /> : undefined}
        >
          <ColorChips
            chips={ACCENT_OPTIONS.map(o => ({ id: o.id, color: o.light }))}
            selectedId={accent}
            onChange={id => setAccentId(id)}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="字体与排版">
        <SettingRow
          label="界面字体"
          desc="整个软件 UI（菜单 / 列表 / 按钮 / 卡片）使用的字体。仅改界面，不影响对话正文、终端与编辑器。"
          badge={uiFontFamily !== UI_FONT_FAMILY_DEFAULT_ID ? <Badge label="已修改" /> : undefined}
        >
          <SelectField
            value={uiFontFamily}
            options={UI_FONT_FAMILY_OPTIONS.map(o => ({ id: o.id, label: o.label }))}
            onChange={id => setUiFontFamily(id)}
          />
        </SettingRow>
        <SettingRow
          label="界面字号"
          desc={`整个软件 UI 的基准字号（菜单 / 列表 / 按钮 / 卡片），默认 ${UI_FONT_BASE_DEFAULT_PX}。与会话正文字号**相互独立**。`}
          badge={uiFontBase !== UI_FONT_BASE_DEFAULT_PX ? <Badge label="已修改" /> : undefined}
        >
          <SelectField
            value={String(uiFontBase)}
            options={UI_FONT_BASE_OPTIONS.map(n => ({ id: String(n), label: String(n) }))}
            onChange={id => setUiFontBase(Number(id))}
          />
        </SettingRow>
        <SettingRow
          label="会话正文字号"
          desc="对话区正文字号（≠ 界面字号）。默认 14，范围 12–17。"
          badge={overridden('fontSize') ? <Badge label="已修改" /> : undefined}
        >
          <SelectField
            value={String(fontSize)}
            options={FONT_SIZE_OPTIONS}
            disabled={disabled}
            onChange={id => { void apply(FONT_SIZE_FIELD, Number(id)) }}
          />
        </SettingRow>
        <SettingRow
          label="界面密度"
          desc="列表与控件的间距（内边距 / 间隙）紧凑程度。只改留白，不改任何字号。"
          badge={uiDensity !== UI_DENSITY_DEFAULT_ID ? <Badge label="已修改" /> : undefined}
          divider={false}
        >
          <SelectField
            value={uiDensity}
            options={UI_DENSITY_OPTIONS.map(o => ({ id: o.id, label: o.label }))}
            onChange={id => setUiDensity(id)}
          />
        </SettingRow>
      </SettingGroup>
      {/* 应用级通用项（自原「通用」页迁入，2026-09-16 重组）：界面语言 + 忙碌时回车。
          官方 locale / conversation fork 注册进 settings.general.item 槽的行，
          本仓不能改注册方，故在本渲染点经 renderSlot 承接（only 过滤，唯一入口在本页）。 */}
      {renderSlot !== undefined && (
        <SettingGroup title="通用">
          {renderSlot('settings.general.item', {}, { only: 'language' })}
          {renderSlot('settings.general.item', {}, { only: 'composer-enter' })}
        </SettingGroup>
      )}
    </>
  )
}
