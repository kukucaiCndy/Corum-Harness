/**
 * `corum-review` settings namespace 的 **boot 注册行**（host 常驻）。
 *
 * ## 为什么需要独立 registrar 行
 *
 * `CorumReviewService` 在 desktop host 里直接 `new`（不是 loader 挂的插件），
 * 故它的 `static Config` 不会被 loader 识别——settings.describe() 因此找不到
 * `corum-review` namespace。与 corum-subagent-settings / corum-memory-settings
 * 同一纪律：独立行 + Config 声明让 ns 在 boot 常驻时即进 describe。
 *
 * desktop 仍是唯一的 `CorumReviewService` 实例（它从 settings.describe() 读
 * retentionDays，不再 register）。本 registrar 只声明 Config，不持有 review 服务。
 *
 * ## rc3 迁移（2026-10-28）
 *
 * namespace 由插件 Config 声明自动产生：插件声明带 `volatile()` 字段的 Config +
 * `static Config`，`settings.describe()` 从 `configEditor.configuration()` 遍历
 * active entry 时自动发现它。**settings ns = entry id**（`corum-review`）。
 *
 * @module @corum/corum-agent/review-settings
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

/** cordis 行名（与 package.json exports 的子路径对应）。 */
export const name = 'corum-review'

/** Config 的 volatile 字段声明。 */
export interface Config {
  retentionDays: Volatile<number | undefined>
}

/** schemastery schema（volatile 字段让 SettingsForms.write() 持久化进 profile patch）。 */
export const Config = z.object({
  retentionDays: z.number().step(1).min(0).max(365)
    .default(undefined as unknown as number).volatile(),
})

/**
 * corum-review 设置的 host 常驻服务（仅声明 Config，让 ns 进 describe）。
 *
 * 继承 `Service` 挂载 `corumReviewSettings`——唯一作用是让 Config 声明进 profile
 * entry。desktop 的 `CorumReviewService` 从 `ctx.settings.describe()` 读 retentionDays
 * 并订阅变更，不再 register。
 */
export class CorumReviewSettingsService extends Service {
  static Config = Config

  constructor(ctx: Context, _config: Config) {
    super(ctx, 'corumReviewSettings')
  }
}

export default CorumReviewSettingsService
