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
 * 3. **按 PRD §4.8 补齐目标条目**：存储占用三项（会话归档 / 技能仓库 / 缓存）、
 *    归档会话两项（删除归档会话 / 导入会话日志）。
 *
 * ## ⚠️ 导入会话日志的真实位置（尚未迁入本页）
 *
 * 真源是 `corum-session-archive` 的 `ImportRow`（一个带状态机的文件导入流程，
 * 经 `requestImport()` 调主进程），**不是设置 ns**，因此**无法「接线」复用**。
 * 它当前注册在 `settings.general.item` 槽，但该槽的渲染点（通用页）已按 M4
 * 只渲染 `language` / `composer-enter` ⇒ 本页**暂时无法渲染它**。
 *
 * 所以本页此项渲染为**未上线的说明行**，并如实标注当前入口在
 * 「插件管理」的插件配置卡。真正的迁入需要**新增一个分区域子槽**
 * （`SlotMap` 接口 + 运行时注册两处改动，跨 3 个文件），风险与收益需要单独评估
 * —— 详见台账 `settings.rework.M4-tail-import-row-deferred`。
 *
 * ## 「删除归档会话」入口（issue #121，2026-10 收口）
 *
 * 该按钮原为 §6.1 的死控件。现已接线：能力在 `corum-session-archive`
 * （`sessionArchive` cordis 服务的 `openManage()`），本页只负责开门。
 * 对话框本体挂在 `shell.overlay`（与保存结果弹窗同槽不同 entry），
 * 故这里**不需要**持有它的状态。
 *
 * ⚠️ **为什么经 ctx.reflect.get 而非 inject**：与侧栏保存入口同一理由 ——
 * 存档插件是**可选**的，`inject` 声明即硬依赖（fiber 会等它装配）。
 * 缺席时按钮保持 disabled，不留死按钮（§6.1 的判据）。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsDataSection
 */

import type { ReactNode } from 'react'
import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { Badge } from '../Badge.tsx'
import { GlassButton } from '../shared.tsx'
import { DeleteArchiveButton } from './useSessionArchiveCapability.tsx'
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
 * 数据管理分区：存储占用 / 危险操作 / 归档会话（全部为未上线目标态）。
 *
 * @returns the data settings section.
 */
export function DataSection({ renderSlot }: DataSectionProps = {}) {
  return (
    <>
      <SettingGroup title="存储占用 · 待统计能力">
        <SettingRow label="会话归档" desc="待「目录大小统计」能力上线后显示真实占用" badge={OFFLINE}>
          {UNKNOWN_SIZE}
          <GlassButton disabled>清理</GlassButton>
        </SettingRow>
        <SettingRow label="技能仓库" desc="待「目录大小统计」能力上线后显示真实占用" badge={OFFLINE}>
          {UNKNOWN_SIZE}
          <GlassButton disabled>清理</GlassButton>
        </SettingRow>
        <SettingRow label="缓存" desc="待「目录大小统计」能力上线后显示真实占用" badge={OFFLINE} divider={false}>
          {UNKNOWN_SIZE}
          <GlassButton disabled>清理</GlassButton>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="危险操作">
        <SettingRow label="清除全部缓存" desc="清空本地缓存文件，下次启动重新生成。⚠️ 尚无 reset API。" badge={OFFLINE}>
          <GlassButton variant="danger" disabled>清除</GlassButton>
        </SettingRow>
        <SettingRow label="重置全部设置" desc="恢复所有设置为默认值，不可撤销。⚠️ 天然是整文件覆盖，需先定范围（PRD §9.2）。" badge={OFFLINE} divider={false}>
          <GlassButton variant="danger" disabled>重置</GlassButton>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="归档会话">
        {/*
          「删除归档会话」已接线（issue #121）：按钮打开 corum-session-archive
          的归档管理对话框（shell.overlay 上挂载，本页不持有其状态）。
          破坏性删除走输入式确认（PRD §9.1）—— 判据在对话框内。
        */}
        <SettingRow label="删除归档会话" desc="批量删除已归档的会话；破坏性操作，需输入式确认（PRD §9.1）。">
          <DeleteArchiveButton />
        </SettingRow>
        {/*
          「导入会话日志」由 corum-session-archive 经 settings.data.item 子槽注册
          （2026-09-16 自通用页迁入，PRD §4.8 DA5）。本页只负责渲染该槽 ——
          行内文案 / 控件 / 写路径全部由注册方自带。
        */}
        {renderSlot?.('settings.data.item', {})}
      </SettingGroup>
    </>
  )
}
