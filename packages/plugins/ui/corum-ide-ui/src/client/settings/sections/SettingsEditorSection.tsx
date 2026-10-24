/**
 * SettingsEditorSection — 编辑器分区（PRD v2 §4.23：**25 项 / 5 分组**）。
 *
 * ## 本分区在设计稿与代码里**原本都不存在**
 *
 * 用户裁定 `#1`：「外观页的字体是整个软件 UI 上的字体大小设置。**终端字体只对终端内**
 * 生效。另外需要增加编辑器字体大小设置。要**单独有一个编辑器的设置页面**」
 * ⇒ 新增 `editor` 分区（PRD §4.23、§3.2 第 3 项），设计稿侧同步新建
 * `设置 · 编辑器 · 深色`（5 分组 / 25 行）。
 *
 * ## 就绪度（PRD §4.23 + §10.2 分档）
 *
 * 字体三项走 fontPrefs，显示九项走 editorDisplayPrefs；diff 布局沿用已有偏好。
 * 其余十二项仍禁用并标注未上线，避免提供不能生效的控件。
 *
 * ⚠️ **E20 的读写格式是 `'1'` / `'0'`，不是 `'true'` / `'false'`**，且 `null` 视为 `true`
 * （`EditorColumn.tsx:435-441`）。写错格式会让真实编辑器**静默**翻成内联布局 ——
 * 故此处严格对齐源实现的格式。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsEditorSection
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { Switch } from '../Switch.tsx'
import { Badge } from '../Badge.tsx'
import { GlassButton, useEditorDisplayPrefs, useFontPrefs } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 编辑器（PRD §4.23）────────────────────────────────────────────── */

/**
 * diff 布局偏好的 localStorage key。
 *
 * ⚠️ 必须与 `packages/desktop/src/client/editor/EditorColumn.tsx:103` 的
 * `DIFF_SIDE_BY_SIDE_KEY` **保持一致**；跨 bundle 不能 import（红线 2），故此处重复字面量。
 */
const DIFF_SIDE_BY_SIDE_KEY = 'corum.diff.sideBySide'

/** 未上线 badge（PRD §6.1：未就绪条目一律「禁用 + 标注未生效」）。 */
const OFFLINE = <Badge label="未上线" variant="offline" />

/** 空回调：未上线控件均 `disabled`，此函数不可达，仅满足控件 props 必填。 */
const noop = () => { /* 控件已禁用，不可达 */ }

/**
 * 读 diff 布局偏好（与 `EditorColumn.tsx` 同格式：`'1'` = 并排，其余 = 内联）。
 * @returns 是否并排。
 */
function readDiffSideBySide(): boolean {
  try {
    const raw = localStorage.getItem(DIFF_SIDE_BY_SIDE_KEY)
    return raw === null ? true : raw === '1'
  } catch {
    return true
  }
}

/**
 * 编辑器设置分区。
 *
 * 字体组（E1 字族 / E2 字号 / E3 行高）已接真源（fontPrefs cordis 服务）；
 * 显示组接 editorDisplayPrefs，E20（diff 布局）走 localStorage；其余项仍禁用。
 *
 * @returns the editor settings section.
 */
export function EditorSection() {
  const displayPrefs = useEditorDisplayPrefs()
  const display = useSyncExternalStore(
    listener => displayPrefs?.subscribe(listener) ?? (() => {}),
    () => displayPrefs?.getPrefs() ?? null,
  )
  const displayReady = display !== null
  const displayBadge = displayReady ? undefined : OFFLINE
  const [sideBySide, setSideBySide] = useState<boolean>(readDiffSideBySide)
  // 字面偏好真源（fontPrefs cordis 服务，跨 bundle 单例；context 下发）。
  const fontPrefs = useFontPrefs()
  const font = useSyncExternalStore(
    (listener) => fontPrefs?.subscribe(listener) ?? (() => {}),
    () => fontPrefs?.getPrefs() ?? null,
  )
  const fontReady = fontPrefs !== null && font !== null
  /** 字族受控输入草稿（失焦写回；null = 未编辑，跟随真源）。 */
  const [familyDraft, setFamilyDraft] = useState<string | null>(null)
  // 真源变化（外部写入）时清掉草稿，避免显示陈旧值。
  useEffect(() => { setFamilyDraft(null) }, [font?.editor.fontFamily])

  /** 写入 diff 布局偏好（格式对齐 `EditorColumn.tsx`：`'1'`/`'0'`）。 */
  const applyDiffLayout = useCallback((id: string) => {
    const next = id === 'side-by-side'
    setSideBySide(next)
    try {
      localStorage.setItem(DIFF_SIDE_BY_SIDE_KEY, next ? '1' : '0')
    } catch { /* 容量满 / 隐私模式：退回会话内记忆 */ }
  }, [])

  const editorFont = font?.editor
  /** 字号/行高候选（含当前真源值置顶）。 */
  const sizeOptions = (current: number): { id: string; label: string }[] =>
    [current, ...[10, 11, 12, 13, 14, 15, 16, 18, 20].filter(v => v !== current)]
      .map(v => ({ id: String(v), label: String(v) }))
  const lineHeightOptions = (current: number): { id: string; label: string }[] =>
    [current, ...[0, 16, 18, 20, 22, 24, 28].filter(v => v !== current)]
      .map(v => ({ id: String(v), label: v === 0 ? '0（自动）' : String(v) }))

  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>
          仅编辑器内生效；标注「未上线」的条目暂不可用。
        </span>
      </div>

      <SettingGroup title="字体">
        <SettingRow label="编辑器字体" desc="仅编辑器内生效的等宽字族（含回退栈，失焦写回；空 = 回落默认）。" badge={fontReady ? undefined : OFFLINE}>
          <input
            className={css.textInput}
            value={familyDraft ?? editorFont?.fontFamily ?? ''}
            placeholder="'JetBrains Mono', 'SFMono-Regular', Menlo, monospace"
            disabled={!fontReady}
            onChange={e => { setFamilyDraft(e.target.value) }}
            onBlur={() => {
              if (familyDraft === null) return
              const raw = familyDraft.trim()
              setFamilyDraft(null)
              if (raw !== (editorFont?.fontFamily ?? '')) fontPrefs?.setPrefs({ editor: { fontFamily: raw } })
            }}
          />
        </SettingRow>
        <SettingRow label="编辑器字号" desc="仅编辑器内的文字大小（px，实时生效）。" badge={fontReady ? undefined : OFFLINE}>
          <SelectField
            value={String(editorFont?.fontSize ?? 13)}
            options={sizeOptions(editorFont?.fontSize ?? 13)}
            onChange={id => { fontPrefs?.setPrefs({ editor: { fontSize: Number(id) } }) }}
            disabled={!fontReady}
          />
        </SettingRow>
        <SettingRow label="行高" desc="0 = 按字号自动（px，实时生效）。" badge={fontReady ? undefined : OFFLINE}>
          <SelectField
            value={String(editorFont?.lineHeight ?? 20)}
            options={lineHeightOptions(editorFont?.lineHeight ?? 20)}
            onChange={id => { fontPrefs?.setPrefs({ editor: { lineHeight: Number(id) } }) }}
            disabled={!fontReady}
          />
        </SettingRow>
        <SettingRow label="字距" badge={OFFLINE}>
          <SelectField value="0" options={[{ id: '0', label: '0' }]} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="连字" desc="编程连字（如 =&gt; 合并显示）。" badge={OFFLINE} divider={false}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="缩进与换行">
        <SettingRow label="Tab 宽度" badge={OFFLINE}>
          <SelectField value="4" options={[{ id: '4', label: '4' }]} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="用空格代替 Tab" badge={OFFLINE}>
          <Switch checked={true} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="自动检测缩进" desc="按打开的文件内容推断缩进。" badge={OFFLINE}>
          <Switch checked={true} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="自动换行" desc="关 / 按视口宽度 / 按指定列。" badge={OFFLINE}>
          <SelectField value="off" options={[{ id: 'off', label: '关' }]} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="换行宽度" desc="仅「自动换行 = 按指定列」时生效" badge={OFFLINE} divider={false}>
          <SelectField value="80" options={[{ id: '80', label: '80' }]} onChange={noop} disabled />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="显示">
        <SettingRow label="行号" desc="显示绝对行号、相对行号，或隐藏行号。" badge={displayBadge}>
          <SelectField value={display?.lineNumbers ?? 'on'} options={[{ id: 'on', label: '开' }, { id: 'off', label: '关' }, { id: 'relative', label: '相对' }]} onChange={id => displayPrefs?.setPrefs({ lineNumbers: id as 'on' | 'off' | 'relative' })} disabled={!displayReady} />
        </SettingRow>
        <SettingRow label="小地图" desc="在编辑器右侧显示代码缩略图。" badge={displayBadge}>
          <Switch checked={display?.minimap ?? true} onChange={minimap => displayPrefs?.setPrefs({ minimap })} disabled={!displayReady} />
        </SettingRow>
        <SettingRow label="空白字符" desc="控制空格与 Tab 的可视标记。" badge={displayBadge}>
          <SelectField value={display?.renderWhitespace ?? 'selection'} options={[{ id: 'none', label: '不显示' }, { id: 'selection', label: '仅选中' }, { id: 'all', label: '始终' }]} onChange={id => displayPrefs?.setPrefs({ renderWhitespace: id as 'none' | 'selection' | 'all' })} disabled={!displayReady} />
        </SettingRow>
        <SettingRow label="当前行高亮" desc="高亮光标所在行的代码区域、行号栏，或两者。" badge={displayBadge}>
          <SelectField value={display?.renderLineHighlight ?? 'line'} options={[{ id: 'none', label: '关' }, { id: 'gutter', label: '行号栏' }, { id: 'line', label: '整行' }, { id: 'all', label: '整行与行号栏' }]} onChange={id => displayPrefs?.setPrefs({ renderLineHighlight: id as 'none' | 'gutter' | 'line' | 'all' })} disabled={!displayReady} />
        </SettingRow>
        <SettingRow label="括号对着色" desc="用不同颜色区分嵌套括号。" badge={displayBadge}>
          <Switch checked={display?.bracketPairColorization ?? true} onChange={bracketPairColorization => displayPrefs?.setPrefs({ bracketPairColorization })} disabled={!displayReady} />
        </SettingRow>
        <SettingRow label="缩进导轨 / 括号导轨" desc="显示缩进层级与括号配对参考线。" badge={displayBadge}>
          <Switch checked={display?.guides ?? true} onChange={guides => displayPrefs?.setPrefs({ guides })} disabled={!displayReady} />
        </SettingRow>
        <SettingRow label="折叠控件显示" desc="始终显示，或鼠标悬停时显示。" badge={displayBadge}>
          <SelectField value={display?.showFoldingControls ?? 'always'} options={[{ id: 'always', label: '始终' }, { id: 'mouseover', label: '悬停' }]} onChange={id => displayPrefs?.setPrefs({ showFoldingControls: id as 'always' | 'mouseover' })} disabled={!displayReady} />
        </SettingRow>
        <SettingRow label="滚动越界" desc="允许滚动到文件末行下方的空白区域。" badge={displayBadge}>
          <Switch checked={display?.scrollBeyondLastLine ?? false} onChange={scrollBeyondLastLine => displayPrefs?.setPrefs({ scrollBeyondLastLine })} disabled={!displayReady} />
        </SettingRow>
        <SettingRow label="平滑滚动 / 平滑光标" desc="为滚动与光标移动启用平滑过渡。" badge={displayBadge} divider={false}>
          <Switch checked={display?.smoothMotion ?? true} onChange={smoothMotion => displayPrefs?.setPrefs({ smoothMotion })} disabled={!displayReady} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="代码对比 diff">
        <SettingRow label="diff 布局" desc="并排 / 内联。">
          <SelectField
            value={sideBySide ? 'side-by-side' : 'inline'}
            options={[{ id: 'side-by-side', label: '并排' }, { id: 'inline', label: '内联' }]}
            onChange={applyDiffLayout}
          />
        </SettingRow>
        <SettingRow label="忽略空白差异" desc="对比时忽略缩进与空白。" badge={OFFLINE}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="折叠未改动段" desc="开 / 关 + 上下文行数。" badge={OFFLINE} divider={false}>
          <Switch checked={true} onChange={noop} disabled />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="编辑体验">
        <SettingRow label="自动保存" desc="开 / 关 + 延迟。" badge={OFFLINE}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="保存时格式化" desc="开 / 关。" badge={OFFLINE}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="文件编码" desc="显示与切换。" badge={OFFLINE} divider={false}>
          <GlassButton disabled>UTF-8</GlassButton>
        </SettingRow>
      </SettingGroup>
    </>
  )
}
