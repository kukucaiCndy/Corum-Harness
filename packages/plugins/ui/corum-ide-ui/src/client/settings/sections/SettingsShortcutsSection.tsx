/**
 * SettingsShortcutsSection — 快捷键分区（PRD v2 §4.11）。
 *
 * ## 本轮（M5 · §6.1 信任修复）
 *
 * 本页原有**一个死控件**：「重置全部快捷键」按钮**无 onClick、未禁用**
 * ⇒ 点了什么都不会发生。按 PRD §6.1「禁止保留『能点但不落盘』的形态」
 * 改为 `disabled` + 「未上线」。
 *
 * 另有一处**假搜索框**：`.searchBox` 里放的是 `<span>` 占位文本而非真输入框，
 * 看起来能搜、实际不可交互。现就地**如实说明**，不假装可搜。
 *
 * ⚠️ 快捷键的**自定义 / 重绑**需要一套键盘绑定真源（本仓没有）
 * ⇒ 本页当前是**只读展示**：显示已实现的快捷键，不提供修改入口。
 * 这符合 §6.1 —— 显示事实可以，假装可改不行。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsShortcutsSection
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { KbdKey } from '../KbdKey.tsx'
import { Badge } from '../Badge.tsx'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 快捷键 ────────────────────────────────────────────────────────── */

/** 未上线 badge（PRD §6.1）。 */
const OFFLINE = <Badge label="未上线" variant="offline" />

/**
 * 快捷键分区（只读展示）。
 *
 * @returns the shortcuts settings section.
 */
export function ShortcutsSection() {
  return (
    <>
      <div className={css.searchBox}>
        <span className={css.searchPlaceholder}>搜索快捷键…</span>
      </div>
      <SettingGroup title="命令">
        <SettingRow label="打开设置"><KbdKey label="Cmd+," /></SettingRow>
        <SettingRow label="快速打开文件"><KbdKey label="Cmd+K" /></SettingRow>
        <SettingRow label="命令面板"><KbdKey label="Cmd+Shift+P" /></SettingRow>
        <SettingRow label="新建会话"><KbdKey label="Cmd+N" /></SettingRow>
        <SettingRow label="关闭弹层" divider={false}><KbdKey label="Esc" /></SettingRow>
      </SettingGroup>
      <div className={css.resetWrap}>
        <SettingRow label="自定义快捷键" badge={OFFLINE} divider={false}>
          <GlassButton variant="primary" disabled>重置全部快捷键</GlassButton>
        </SettingRow>
      </div>
    </>
  )
}
