/**
 * `corum-ui-onboarding-settings` settings namespace 的 **boot 注册行**（host 常驻）。
 *
 * ## rc3 迁移（2026-10-28）
 *
 * rc3 的 `SettingsForms` 不再有 `register()` 方法——namespace 由**插件 Config 声明**
 * 自动产生：插件声明一个带 `volatile()` 字段的 `Config` + `static Config`，
 * `settings.describe()` 从 `configEditor.configuration()` 遍历 active entry 时自动
 * 发现它。**settings ns = entry id**（`corum-ui-onboarding-settings`）。
 *
 * 本插件因此只做一件事：声明 Config（volatile 字段 `welcomeNoticeVersion`），
 * 让 `settings.describe()` 自动产出 `corum-ui-onboarding-settings` namespace 的 form。
 *
 * **不再轮询调用不存在的 `settings.register()`**（旧代码 catch 吞错 + 永久缺失，
 * 在 rc3 上既无效又有害）。
 *
 * ## D2 纠偏（2026-10-27）
 *
 * 删除 constructor 里的 `ctx.get('settings')?.configure?.({ auto: true })`：
 * `autoGenerate` 默认就是 true，该调用是近似 no-op。
 *
 * @module @corum/corum-ui-settings-models/settings-registrar
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { WELCOME_NOTICE_SETTINGS_NAMESPACE } from './onboarding-copy.ts'

/** cordis 行名（与 package.json exports 的子路径对应）。 */
export const name = 'corum-ui-onboarding-settings'

// ── Config 声明（rc3 volatile 字段 → settings.describe() 自动发现）──────────

/** Config 的 volatile 字段声明。 */
export interface Config {
  /** 用户最后确认的 welcome notice 版本号。 */
  welcomeNoticeVersion: Volatile<string>
}

/** schemastery schema（volatile 字段让 SettingsForms.write() 持久化进 profile patch）。 */
export const Config = z.object({
  welcomeNoticeVersion: z.string().default('').volatile(),
})

/**
 * `corum-ui-onboarding-settings` 全局设置的 host 常驻服务。
 *
 * 继承 `Service`——主要作用是让 Config 声明进 profile entry（`settings.describe()`
 * 发现）。**settings ns = entry id = `corum-ui-onboarding-settings`**（D2 纠偏：
 * 不存在 entry id → ns 映射，ns 逐字等于行 id）。
 */
export class CorumOnboardingSettingsService extends Service {
  static Config = Config

  constructor(ctx: Context, _config: Config) {
    super(ctx, 'corumOnboardingSettings')
    // D2 纠偏：不再调 `ctx.get('settings')?.configure?.({ auto: true })`——
    // autoGenerate 默认就是 true，该调用是近似 no-op。
  }
}

export default CorumOnboardingSettingsService
