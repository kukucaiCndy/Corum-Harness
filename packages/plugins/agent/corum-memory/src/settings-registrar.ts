/**
 * `corum-memory-settings` settings namespace 的 **boot 注册行**（host 常驻）。
 *
 * ## rc3 迁移（2026-10-28）
 *
 * rc3 的 `SettingsForms` 不再有 `register()` 方法——namespace 由**插件 Config 声明**
 * 自动产生：插件声明一个带 `volatile()` 字段的 `Config` + `static Config`，
 * `settings.describe()` 从 `configEditor.configuration()` 遍历 active entry 时自动
 * 发现它。**settings ns = entry id**（`corum-memory-settings`）。
 *
 * 本插件因此只做一件事：声明 Config（volatile 字段），让 `settings.describe()`
 * 自动产出 `corum-memory-settings` namespace 的 form。读写由 `ctx.settings.update(ns, patch)`
 * / `ctx.settings.describe()` 负责。服务侧 `acquireMemorySettingsScope` 只从
 * `describe()` 直读。
 *
 * **不再轮询调用不存在的 `settings.register()`**（旧代码 catch 吞错 + 熔断，
 * 在 rc3 上既无效又有害）。
 *
 * ## D2 纠偏（2026-10-27）
 *
 * 删除 constructor 里的 `ctx.get('settings')?.configure?.({ auto: true })`：
 * `autoGenerate` 默认就是 true（describe `?? true`），该调用是近似 no-op。
 * Config 声明本身已足够让 ns 进 describe。
 *
 * @module @corum/corum-memory/settings-registrar
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import {
  CORUM_MEMORY_SETTINGS_NAMESPACE,
  CORUM_MEMORY_SETTINGS_SCHEMA,
  type CorumMemorySettings,
  type DecayStrength,
  type OverflowPolicy,
  type InjectMode,
} from './memory-config.ts'
import type { MemoryRetention } from './memory-entities.ts'

/** cordis 行名（与 package.json exports 的子路径对应）。 */
export const name = 'corum-memory-settings'

// ── Config 声明（rc3 volatile 字段 → settings.describe() 自动发现）──────────

/** Config 的 volatile 字段声明（与 CorumMemorySettings 逐键对应）。 */
export interface Config {
  enabled: Volatile<boolean | undefined>
  defaultRetention: Volatile<MemoryRetention | undefined>
  readPromoteThreshold: Volatile<number | undefined>
  decayStrength: Volatile<DecayStrength | undefined>
  capacity: Volatile<number | null | undefined>
  overflowPolicy: Volatile<OverflowPolicy | undefined>
  autoCleanExpired: Volatile<boolean | undefined>
  injectMode: Volatile<InjectMode | undefined>
  injectLimit: Volatile<number | undefined>
  injectBudget: Volatile<number | undefined>
}

/**
 * schemastery schema（volatile 字段让 SettingsForms.write() 持久化进 profile patch）。
 *
 * 与 `CORUM_MEMORY_SETTINGS_SCHEMA` 同一份声明，但加了 `.volatile()` 标记——
 * rc3 要求 volatile 字段才能被 settings form 读写。
 */
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export const Config = z.object({
  enabled: z.boolean().default(undefined as unknown as boolean).volatile(),
  defaultRetention: z.union([
    z.const('temporary'), z.const('short'), z.const('long'), z.const('permanent'),
  ]).default(undefined as unknown as MemoryRetention).volatile(),
  readPromoteThreshold: z.number().step(1).min(1).max(100)
    .default(undefined as unknown as number).volatile(),
  decayStrength: z.union([z.const('fast'), z.const('standard'), z.const('slow')])
    .default(undefined as unknown as DecayStrength).volatile(),
  capacity: z.union([z.number().step(1).min(1), z.const(null)])
    .default(undefined as unknown as number | null).volatile(),
  overflowPolicy: z.union([z.const('oldest'), z.const('least-used'), z.const('stop')])
    .default(undefined as unknown as OverflowPolicy).volatile(),
  autoCleanExpired: z.boolean().default(undefined as unknown as boolean).volatile(),
  injectMode: z.union([z.const('session-start'), z.const('relevance'), z.const('never')])
    .default(undefined as unknown as InjectMode).volatile(),
  injectLimit: z.number().step(1).min(1).max(200).default(undefined as unknown as number).volatile(),
  injectBudget: z.number().step(1).min(100).max(100000).default(undefined as unknown as number).volatile(),
})

/**
 * corum-memory 全局设置的 host 常驻服务。
 *
 * 继承 `Service` 挂载 `corumMemorySettings`——主要作用是让 Config 声明
 * 进 profile entry（`settings.describe()` 发现），并注册 settings presentation。
 */
export class CorumMemorySettingsService extends Service {
  static Config = Config

  constructor(ctx: Context, _config: Config) {
    super(ctx, 'corumMemorySettings')
    // D2 纠偏：不再调 `ctx.get('settings')?.configure?.({ auto: true })`——
    // autoGenerate 默认就是 true（describe `?? true`），该调用是近似 no-op。
    // Config 声明本身已让 ns 进 describe。
  }
}

export default CorumMemorySettingsService
