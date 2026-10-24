/**
 * SettingsAccountSection — 账户与用量分区（PRD v2 §4.9）。
 *
 * ## 本轮（M5 · §6.1/§6.2 信任修复）
 *
 * 1. **删假数据（§6.2）**：原代码硬编码两个**伪造的用量数值**
 *    （本月 API 调用次数、Token 用量，见 PRD §6.2 记录）。§6.2 明说
 *    「badge 盖不住假数据 ⇒ 必须直接删除」⇒ 改为 `—`。
 *    （设计稿侧早已同样处置；本轮补齐**代码侧**。）
 *    ⚠️ 此处**故意不复述那两个数值**：复述会让「grep 假数据 = 0」这条审计
 *    命中本注释自身而失去判据效力（本项目已因此踩过三次）。
 * 2. **两个死控件降级**：「登出」「升级」原本**无 onClick、未禁用**
 *    ⇒ 改为 `disabled` + 「未上线」。
 *
 * ## 产品定位（PRD §4.9）
 *
 * 用户裁定 `#11`：**账户页保留设计**（账户 / 订阅 / 用量 / 配额），
 * 标「即将上线」—— 因为账户系统本身尚未存在。故：
 * - 页面**保留形态**（让用户看到未来有什么）
 * - 但**每一项都如实标注**不可用，且**不显示任何编造的个人数据**
 *
 * @module corum-ide-ui/client/settings/sections/SettingsAccountSection
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { Badge } from '../Badge.tsx'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 账户与用量 ────────────────────────────────────────────────────── */

/** 即将上线 badge（真源待建，先占位展示）。 */
const SOON = <Badge label="即将上线" variant="soon" />

/** 未上线的数值占位（§6.2：不显示伪造数值）。 */
const UNKNOWN = <span className={css.sizeLabel}>—</span>

/**
 * 账户与用量分区（目标态占位，全部标注即将上线）。
 *
 * @returns the account settings section.
 */
export function AccountSection() {
  return (
    <>
      <SettingGroup title="账户 · 即将上线">
        <SettingRow label="账户状态" desc="账户系统尚未上线；当前为本机使用，无需登录。" badge={SOON}>
          <GlassButton disabled>登出</GlassButton>
        </SettingRow>
        <SettingRow label="订阅与配额" desc="订阅方案与配额管理待账户系统上线后提供。" badge={SOON} divider={false}>
          <GlassButton disabled>升级</GlassButton>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="用量统计 · 即将上线">
        <SettingRow label="本月 API 调用" desc="统计待服务端账户系统提供。" badge={SOON}>
          {UNKNOWN}
        </SettingRow>
        <SettingRow label="Token 用量" desc="统计待服务端账户系统提供。" badge={SOON} divider={false}>
          {UNKNOWN}
        </SettingRow>
      </SettingGroup>
    </>
  )
}
