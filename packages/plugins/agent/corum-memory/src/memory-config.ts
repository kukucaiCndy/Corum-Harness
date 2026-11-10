/**
 * corum 记忆底座 —— **可配置面**（settings namespace `corum-memory-settings`）。
 *
 * ## 为什么单独成文件
 *
 * 本 ns 需要**两个装配时机**共用同一份声明：
 *   ① `memory-service.ts`：服务侧读取 resolved 值，把「策略」从硬编码常量改成
 *      配置回落（`config.X ?? 内置默认`）；
 *   ② `settings-registrar.ts`：host boot 常驻注册行（settings ns 不在 boot 阶段
 *      注册，冷启动时 `settings/describe` 里就没有它——见 corum-subagent 的实测）。
 *
 * 与 `corum-tool-subagent/settings-namespace.ts` 同款拆分理由：若 ② 直接从
 * `memory-service.ts` import 常量，tsdown 会把整个 service（含存储实现）内联进
 * registrar 产物，且模块级单例会出现两份副本（红线 1 的「跨 bundle 模块级状态被
 * 复制」形态）。故**纯声明**放这里，两侧都是薄 import。
 *
 * ## 字段与「真源」的对应（2026-09-21 用户裁定的三层信息架构）
 *
 * | 设置项 | 落到哪 | 谁生效 |
 * |---|---|---|
 * | `enabled` | 本 ns | MemoryService：关闭后拒绝**非用户**写入 + 检索不召回 |
 * | `defaultRetention` | 本 ns | `resolveRetentionOnWrite` 的回落档 |
 * | `readPromoteThreshold` | 本 ns | `promoteRetentionOnRead` 阈值 |
 * | `decayStrength` | 本 ns | `effectiveScoreFor` 的半衰期倍率 |
 * | `capacity` / `overflowPolicy` | 本 ns | `putFact` 落库后的容量治理 |
 * | `autoCleanExpired` | 本 ns | `putFact` 顺手清理已过期记忆 |
 * | `inject*` | 本 ns（**只存，未生效**） | 底座**尚无注入机制**（corum-agent/compile.ts
 *   `TODO(memory)` 预留位未接）⇒ UI 一律禁用 + 标「未上线」，不伪造行为 |
 *
 * ⚠️ **`inject*` 三个键是有意保留的「未生效真源」**：用户要的是「设置中心能看到
 * 注入策略」，而注入本身属底座能力缺口（另需设计）。存下来（不丢用户意图）+ UI
 * 明确标未上线，符合 PRD §6.1「未就绪条目一律禁用 + 标注未生效」。
 *
 * @module @corum/corum-memory/memory-config
 */

import z from '@deepseek-ai/schemastery'
import type { MemoryRetention } from './memory-entities.ts'

/**
 * host settings namespace（settings.yaml 的段名）。
 *
 * ⚠️ rc3 机制（2026-10-27 D2 纠偏）：settings ns = cordis entry 的 `id:` 字段。
 * `cordis.patch.yml` 行 id 是 `corum-memory-settings`（见 `settings-registrar.ts`
 * 的 `name` 同值），故 ns 必须逐字等于它。旧值 `'corum-memory'` 与行 id 不一致 ⇒
 * describe 里找不到 ⇒ 设置页读空。
 */
export const CORUM_MEMORY_SETTINGS_NAMESPACE = 'corum-memory-settings'

/** 衰减强度三档：半衰期倍率（越快 → 越偏「近的优先」）。 */
export const DECAY_STRENGTH_MULTIPLIER = {
  fast: 0.5,
  standard: 1,
  slow: 2,
} as const

/** 衰减强度档位名。 */
export type DecayStrength = keyof typeof DECAY_STRENGTH_MULTIPLIER

/** 超限策略：库超过容量上限时淘汰谁。 */
export const OVERFLOW_POLICIES = ['oldest', 'least-used', 'stop'] as const
/** 超限策略名。 */
export type OverflowPolicy = (typeof OVERFLOW_POLICIES)[number]

/** 注入时机（**底座尚未实现**，仅存用户意图）。 */
export const INJECT_MODES = ['session-start', 'relevance', 'never'] as const
/** 注入时机名。 */
export type InjectMode = (typeof INJECT_MODES)[number]

/** 内置默认值（设置面未覆盖时全部回落到这里）。 */
export const MEMORY_CONFIG_DEFAULTS = {
  /** 总开关：默认开（与「底座已实现、可用」的现状一致）。 */
  enabled: true,
  /** 新事实未显式声明存续期时的回落档（= 原硬编码默认）。 */
  defaultRetention: 'temporary' as MemoryRetention,
  /** 读取升级阈值（= 原 `READ_PROMOTE_THRESHOLD`）。 */
  readPromoteThreshold: 5,
  /** 衰减强度（= 原硬编码半衰期，倍率 1）。 */
  decayStrength: 'standard' as DecayStrength,
  /** 容量上限：`null` = 不限（默认不淘汰任何记忆）。 */
  capacity: null as number | null,
  /** 超限策略。 */
  overflowPolicy: 'least-used' as OverflowPolicy,
  /** 自动清理已过期记忆。 */
  autoCleanExpired: false,
  /** 注入时机（未生效）。 */
  injectMode: 'relevance' as InjectMode,
  /** 注入条数上限（未生效）。 */
  injectLimit: 10,
  /** 注入预算字符数（未生效）。 */
  injectBudget: 4000,
} as const

/**
 * 用户层设置形（全键可选——未设置的键由 {@link MEMORY_CONFIG_DEFAULTS} 兜底，
 * 保持 omission 语义：设置面只写用户显式改的键，「恢复默认」= unset）。
 */
export interface CorumMemorySettings {
  /** 总开关：关闭后 Agent/系统不再沉淀新记忆，检索也不召回；用户手动添加仍可用。 */
  readonly enabled?: boolean
  /** 存续期默认档。 */
  readonly defaultRetention?: MemoryRetention
  /** 读取升级阈值（3 / 5 / 10）。 */
  readonly readPromoteThreshold?: number
  /** 衰减强度。 */
  readonly decayStrength?: DecayStrength
  /** 容量上限；`null` = 不限。 */
  readonly capacity?: number | null
  /** 超限策略。 */
  readonly overflowPolicy?: OverflowPolicy
  /** 自动清理已过期记忆。 */
  readonly autoCleanExpired?: boolean
  /** 注入时机（未生效）。 */
  readonly injectMode?: InjectMode
  /** 注入条数上限（未生效）。 */
  readonly injectLimit?: number
  /** 注入预算字符数（未生效）。 */
  readonly injectBudget?: number
}

/**
 * schemastery schema（全键可选；`default(undefined)` 保证 omission 语义）。
 *
 * ⚠️ `capacity` 用 `z.union([z.number(), z.const(null)])` 表达「数字或不限」——
 * schemastery 的可选数字若给 `default(undefined)`，显式写 `null`（不限）会被拒。
 */
export const CORUM_MEMORY_SETTINGS_SCHEMA: z<CorumMemorySettings> = z.object({
  enabled: z.boolean().default(undefined as unknown as boolean),
  defaultRetention: z.union([
    z.const('temporary'), z.const('short'), z.const('long'), z.const('permanent'),
  ]).default(undefined as unknown as MemoryRetention),
  readPromoteThreshold: z.number().step(1).min(1).max(100)
    .default(undefined as unknown as number),
  decayStrength: z.union([z.const('fast'), z.const('standard'), z.const('slow')])
    .default(undefined as unknown as DecayStrength),
  capacity: z.union([z.number().step(1).min(1), z.const(null)])
    .default(undefined as unknown as number | null),
  overflowPolicy: z.union([z.const('oldest'), z.const('least-used'), z.const('stop')])
    .default(undefined as unknown as OverflowPolicy),
  autoCleanExpired: z.boolean().default(undefined as unknown as boolean),
  injectMode: z.union([z.const('session-start'), z.const('relevance'), z.const('never')])
    .default(undefined as unknown as InjectMode),
  injectLimit: z.number().step(1).min(1).max(200).default(undefined as unknown as number),
  injectBudget: z.number().step(1).min(100).max(100000).default(undefined as unknown as number),
}) as z<CorumMemorySettings>

/**
 * 服务侧消费的**已解析**配置（每个键都有值；由 {@link resolveMemoryConfig} 从
 * 用户层 + 内置默认合成）。
 */
export interface ResolvedMemoryConfig {
  readonly enabled: boolean
  readonly defaultRetention: MemoryRetention
  readonly readPromoteThreshold: number
  readonly decayStrength: DecayStrength
  readonly capacity: number | null
  readonly overflowPolicy: OverflowPolicy
  readonly autoCleanExpired: boolean
  readonly injectMode: InjectMode
  readonly injectLimit: number
  readonly injectBudget: number
}

/**
 * 把用户层设置（可能是空对象 / 部分键）合成完整配置。
 *
 * 纯函数：不读 settings、不落库，便于单测与「设置面改了立刻生效」的重新合成。
 *
 * @param user - 用户层设置（settings.yaml 里 `corum-memory` 段的内容）。
 * @returns 每个键都有值的配置。
 */
export function resolveMemoryConfig(user: CorumMemorySettings | undefined): ResolvedMemoryConfig {
  const d = MEMORY_CONFIG_DEFAULTS
  return {
    enabled: user?.enabled ?? d.enabled,
    defaultRetention: user?.defaultRetention ?? d.defaultRetention,
    readPromoteThreshold: user?.readPromoteThreshold ?? d.readPromoteThreshold,
    decayStrength: user?.decayStrength ?? d.decayStrength,
    capacity: user?.capacity === undefined ? d.capacity : user.capacity,
    overflowPolicy: user?.overflowPolicy ?? d.overflowPolicy,
    autoCleanExpired: user?.autoCleanExpired ?? d.autoCleanExpired,
    injectMode: user?.injectMode ?? d.injectMode,
    injectLimit: user?.injectLimit ?? d.injectLimit,
    injectBudget: user?.injectBudget ?? d.injectBudget,
  }
}

/** SettingsForms（rc3 `ctx.settings`）上本模块用到的面（窄化，避免耦合官方类型面）。
 *
 * rc3 变化：`register(ns, schema)` 已删除——命名空间通过插件 Config（cordis schema）
 * 声明，profile patch 写值。`describe()` 返回 SettingsDescriptor[]（含 ns + value）。
 * 本模块只读：从 describe() 找 ns → 取 value。 */
export interface MemorySettingsProviderFace {
  describe?: (options?: unknown) => readonly { ns: string; value?: unknown }[]
}

/** settings scope 的消费面（读 + watch）。 */
export interface MemorySettingsScope {
  get: () => CorumMemorySettings
  watch?: (listener: (next: CorumMemorySettings) => void) => (() => void) | void
}

/**
 * 取（或兜底读）`corum-memory-settings` 的 settings scope。
 *
 * rc3 变化：`settings.register()` 已删除——命名空间通过插件 Config（cordis schema）
 * 声明，profile patch 写值。本函数只读：从 `describe()` 找 ns → 取 value。
 * 未找到（ns 尚未进 profile / settings 服务未挂载）= `undefined`，调用方兜底默认值。
 *
 * @param settings - settings 服务面（`ctx.get('settings')`，rc3 = SettingsForms）。
 * @returns 可读的 scope；settings 服务不含 `describe` 或 ns 未注册时为 `undefined`。
 */
export function acquireMemorySettingsScope(
  settings: MemorySettingsProviderFace,
): MemorySettingsScope | undefined {
  try {
    const descriptors = settings.describe?.()
    if (descriptors === undefined) return undefined
    const found = descriptors.find(d => d.ns === CORUM_MEMORY_SETTINGS_NAMESPACE)
    if (found === undefined) return undefined
    return {
      get: () => {
        try {
          const current = settings.describe?.().find(d => d.ns === CORUM_MEMORY_SETTINGS_NAMESPACE)
          return (current?.value ?? {}) as CorumMemorySettings
        } catch {
          return {}
        }
      },
    }
  } catch {
    return undefined
  }
}
