/**
 * `corum-subagent-settings` settings namespace 的 **boot 注册行**（host 常驻）。
 *
 * ## rc3 迁移（2026-10-28）
 *
 * rc3 的 `SettingsForms` 不再有 `register()` 方法——namespace 由**插件 Config 声明**
 * 自动产生：插件声明一个带 `volatile()` 字段的 `Config` + `static Config`，
 * `settings.describe()` 从 `configEditor.configuration()` 遍历 active entry 时自动
 * 发现它。**settings ns = entry id**（`corum-subagent-settings`）——不存在 entry id
 * → ns 的映射，故 namespace 名与行 id 逐字相同。
 *
 * 本插件因此只做一件事：声明 Config（volatile 字段），让 `settings.describe()`
 * 自动产出 `corum-subagent-settings` namespace 的 form。读写由 `ctx.settings.update(ns, patch)`
 * / `ctx.settings.describe()` 负责。
 *
 * **不再轮询调用不存在的 `settings.register()`**（旧代码 catch 吞错 + 熔断，
 * 在 rc3 上既无效又有害）。
 *
 * ## D2 纠偏（2026-10-27）
 *
 * 删除 constructor 里的 `ctx.settings.configure({ auto: true })`：`autoGenerate`
 * 默认就是 true（describe `?? true`），该调用是近似 no-op；且裸 `ctx.settings`
 * 在 settings 服务未挂载时有 TypeError 风险。Config 声明本身已足够让 ns 进 describe。
 *
 * ## 与 apply() 内的消费如何共存
 *
 * `corum-tool-subagent/index.ts` 的 `acquireCorumSubagentSettingsScope` 旧版调
 * `settings.register()`——rc3 上该 API 已删，故改为**只从 `settings.describe()`
 * 直读**（namespace 已由本 boot 行的 Config 声明提供）。
 *
 * @module @corum/corum-tool-subagent/settings-registrar
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import {
  CORUM_SUBAGENT_SETTINGS_NAMESPACE,
  type CorumSubagentGlobalSettings,
} from './settings-namespace.ts'

/** cordis 行名（与 package.json exports 的子路径对应）。 */
export const name = 'corum-subagent-settings'

// ── Config 声明（rc3 volatile 字段 → settings.describe() 自动发现）──────────

/** Config 的 volatile 字段声明（与 CorumSubagentGlobalSettings 逐键对应）。 */
export interface Config {
  /** 运行期回落档（未显式配该键的预设回落此值）。 */
  maxParallelChildren: Volatile<number | undefined>
  /** 子 Agent（worker）模型——双重身份：模板值 + 运行期兜底档。 */
  defaultModel: Volatile<{ provider: string; model: string; reasoningEffort?: string } | undefined>
  /** research 子 Agent 模型（缺省回落 defaultModel）。 */
  defaultResearchModel: Volatile<{ provider: string; model: string; reasoningEffort?: string } | undefined>
}

/** schemastery schema（volatile 字段让 SettingsForms.write() 持久化进 profile patch）。 */
export const Config = z.object({
  maxParallelChildren: z.number().step(1).min(1).default(undefined as unknown as number).volatile(),
  defaultModel: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1).default(undefined as unknown as string),
  }).default(undefined as unknown as { provider: string; model: string; reasoningEffort: string }).volatile(),
  defaultResearchModel: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1).default(undefined as unknown as string),
  }).default(undefined as unknown as { provider: string; model: string; reasoningEffort: string }).volatile(),
})

// ── Service：提供 settings presentation + 直读面 ──────────────────────────

/**
 * corum-subagent 全局设置的 host 常驻服务。
 *
 * 继承 `Service` 挂载 `corumSubagentSettings`——主要作用是让 Config 声明
 * 进 profile entry（`settings.describe()` 发现），并提供 `current()` 直读面
 * 供 `corum-tool-subagent/index.ts` 的 `acquireCorumSubagentSettingsScope` 使用。
 */
export class CorumSubagentSettingsService extends Service {
  static Config = Config

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'corumSubagentSettings')
    // D2 纠偏：不再调 `ctx.settings.configure({ auto: true })`——autoGenerate 默认
    // 就是 true（describe `?? true`），该调用是近似 no-op；且裸 `ctx.settings`
    // 在 settings 服务未挂载时有 TypeError 风险。Config 声明本身已让 ns 进 describe。
  }

  /** 读当前 resolved 值（从 volatile getter 直取，不经过 settings.describe）。 */
  current(): CorumSubagentGlobalSettings {
    const maxParallelChildren = this.config.maxParallelChildren.get()
    const defaultModel = this.config.defaultModel.get()
    const defaultResearchModel = this.config.defaultResearchModel.get()
    return {
      ...(maxParallelChildren !== undefined ? { maxParallelChildren } : {}),
      ...(defaultModel !== undefined ? { defaultModel } : {}),
      ...(defaultResearchModel !== undefined ? { defaultResearchModel } : {}),
    }
  }
}

export default CorumSubagentSettingsService
