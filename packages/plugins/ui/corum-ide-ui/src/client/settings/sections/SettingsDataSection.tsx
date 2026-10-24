/**
 * SettingsDataSection — 数据管理分区（PRD v2 §4.8）。
 *
 * ## 本轮（M4 尾 + §6.1/§6.2 信任修复）的三件事
 *
 * 1. **删假数据（§6.2）**：原代码硬编码了两个**伪造的存储占用数值**
 *    （技能仓库与缓存，见 PRD §6.2 记录）。§6.2 明说「badge 盖不住假数据 ⇒
 *    必须直接删除」，故改为 `—` 并注明待统计能力。
 *    （设计稿侧此前已同样处置；本轮补齐**代码侧** —— 上轮只改了设计稿。）
 *    ⚠️ 此处**故意不复述那两个数值**：复述会让「grep 假数据 = 0」这条审计
 *    命中本注释自身而失去判据效力（本项目已因此踩过两次）。
 * 2. **五个死控件按 §6.1 降级**：3 个「清理」+「清除」+「重置」原本全是
 *    按钮本身没有 onClick 的空壳（点了什么都不会发生）。
 *    ⚠️ 此处**故意不写出该标签的字面形式** —— 写了会让「全仓审计裸标签」的脚本
 *    命中本注释自身（本项目已因此踩过四次同类问题）。
 *    现一律 `disabled` + 「未上线」badge。危险操作保持 danger 配色以便识别。
 * 3. **按 PRD §4.8 补齐目标条目**：存储占用三项（会话归档 / 技能仓库 / 缓存）。
 *
 * ## 「归档会话」整组已迁出（issue #121 修订版，2026-10-22）
 *
 * 原「归档会话」组（「删除归档会话」入口 + `settings.data.item` 子槽渲染的
 * 「导入会话日志」行）已整组移除，能力迁到独立 section 页
 * 「会话管理」（`SettingsSessionManagementSection`，设计稿 mdBB5）：
 * 归档会话的还原 / 导出 / 删除 / 导入全生命周期都在那一页。
 * 原 ManageDialog（Modal 形态）被用户验收否掉 ⇒ 对话框已删，入口按钮
 * （useSessionArchiveCapability 的 DeleteArchiveButton）随之退役。
 * ⚠️ 不要在本页恢复该组：那会造出第二个入口与第二份管理面。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsDataSection
 */

import type { ReactNode } from 'react'
import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { Badge } from '../Badge.tsx'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 数据管理（PRD §4.8）───────────────────────────────────────────── */

/**
 * 本分区的注入 props：Shell 在注册本 section 时把子槽渲染器传进来。
 *
 * 用**内联键类型**而非 `PropsRenderSlots<'settings.data.item'>`，与
 * `extensions` 分支的 `settings.plugins.tab` 同一写法（该键已在 corum 的
 * `SlotMap` 增强块里登记，但此处保持与既有分支一致的形态）。
 */
export interface DataSectionProps {
  /**
   * 渲染「归档会话」子槽。缺失时不渲染该槽、页面其余部分照常
   * （保持本组件可独立渲染，便于单测）。
   */
  renderSlot?: (key: 'settings.data.item', owner: Record<string, never>, opts?: { only?: string }) => ReactNode
}

/** 未上线 badge（PRD §6.1）。 */
const OFFLINE = <Badge label="未上线" variant="offline" />

/** 未上线的存储占用占位（§6.2：不显示伪造数值）。 */
const UNKNOWN_SIZE = <span className={css.sizeLabel}>—</span>

/**
 * 数据管理分区：存储占用 / 危险操作（归档会话组已迁出至「会话管理」页）。
 *
 * @returns the data settings section.
 */
export function DataSection({ renderSlot }: DataSectionProps = {}) {
  return (
    <>
      <SettingGroup title="存储占用 · 待统计能力">
        <SettingRow label="会话归档" badge={OFFLINE}>
          {UNKNOWN_SIZE}
          <GlassButton disabled>清理</GlassButton>
        </SettingRow>
        <SettingRow label="技能仓库" badge={OFFLINE}>
          {UNKNOWN_SIZE}
          <GlassButton disabled>清理</GlassButton>
        </SettingRow>
        <SettingRow label="缓存" badge={OFFLINE} divider={false}>
          {UNKNOWN_SIZE}
          <GlassButton disabled>清理</GlassButton>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="危险操作">
        <SettingRow label="清除全部缓存" desc="清空本地缓存文件，下次启动重新生成。⚠️ 尚无 reset API。" badge={OFFLINE}>
          <GlassButton variant="danger" disabled>清除</GlassButton>
        </SettingRow>
        <SettingRow label="重置全部设置" desc="恢复所有设置为默认值，不可撤销。" badge={OFFLINE} divider={false}>
          <GlassButton variant="danger" disabled>重置</GlassButton>
        </SettingRow>
      </SettingGroup>
      {/*
        「导入会话日志」行（settings.data.item 子槽，corum-session-archive 注册）
        已随「归档会话」整组迁至「会话管理」section 页（issue #121 修订版）。
        子槽声明与渲染点一并退役——本页不再渲染该槽。
      */}
      {void renderSlot}
    </>
  )
}
