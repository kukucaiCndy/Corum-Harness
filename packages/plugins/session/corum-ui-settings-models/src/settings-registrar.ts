/**
 * `ui-onboarding` settings namespace 的 **boot 注册行**（host 常驻）。
 *
 * ## rc3 迁移（2026-10-28）
 *
 * rc3 的 `SettingsForms` 不再有 `register()` 方法——namespace 由**插件 Config 声明**
 * 自动产生：插件声明一个带 `volatile()` 字段的 `Config` + `static Config`，
 * `settings.describe()` 从 `configEditor.configuration()` 遍历 active entry 时自动
 * 发现它。
 *
 * 本插件因此只做一件事：声明 Config（volatile 字段 `welcomeNoticeVersion`），
 * 让 `settings.describe()` 自动产出 `ui-onboarding` namespace 的 form。
 *
 * **不再轮询调用不存在的 `settings.register()`**（旧代码 catch 吞错 + 永久缺失，
 * 在 rc3 上既无效又有害）。
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
 * `ui-onboarding` 全局设置的 host 常驻服务。
 *
 * 继承 `Service`——主要作用是让 Config 声明进 profile entry（`settings.describe()`
 * 发现），并注册 settings presentation。namespace 名 = entry id =
 * `corum-ui-onboarding-settings`，但 **settings ns** 是 `ui-onboarding`
 * （由 cordis entry id → settings ns 的映射决定）。
 */
export class CorumOnboardingSettingsService extends Service {
  static Config = Config

  constructor(ctx: Context, _config: Config) {
    super(ctx, 'corumOnboardingSettings')
    // 注册 settings presentation（autoGenerate: true = UI 自动生成设置页）。
    // settings 服务在 boot 早期可能尚未挂载——用 ctx.get 宽化取。
    const settings = ctx.get('settings') as { configure?: (p: { auto?: boolean }) => (() => void) } | undefined
    settings?.configure?.({ auto: true })
  }
}

export default CorumOnboardingSettingsService
