/**
 * `corum-subagent` settings namespace 的**声明面**（namespace + 形 + schema）。
 *
 * 为什么单独成文件（2026-09-18）：本 ns 需要**两个装配时机**共用同一份声明——
 *   ① `settings-registrar.ts`：**boot 常驻**的注册行（host 行）。本 ns 是全局配置
 *      （含「新建预设的模板值」），与「有没有 corum 会话」无关，故必须在 boot 就注册；
 *   ② `index.ts`：工具实例（按会话挂载）apply 时**读取**它、并在 registrar 缺席时兜底注册。
 *
 * 若②直接从 `index.ts` 里 import ①用的常量，tsdown 会把整个 index（含工具实现，100KB+）
 * 内联进 registrar 产物，且**模块级单例 `corumGlobalSettingsScope` 会出现两份副本**
 * （正是规范红线 1 的「跨 bundle 模块级状态被复制」形态）。故把**纯声明**抽到这里，
 * 两侧都是薄 import。
 *
 * 实测动机（bug 复现）：冷启动（不建任何 corum 会话）时 `settings/describe` 里
 * **没有** `corum-subagent`（16 个 ns 无它），于是「设置→智能体」那两个子 Agent 模型项
 * 显示为空、写入报 `settings namespace "corum-subagent" is not registered`、
 * **新建预设的模板预填读不到值**。
 */
import z from '@deepseek-ai/schemastery'

/** host settings namespace（settings.yaml 的 `corum-subagent` 段）。 */
export const CORUM_SUBAGENT_SETTINGS_NAMESPACE = 'corum-subagent'

/**
 * 全局配置形（与 preset config 逐键同名；全部可选——未设置的键由实例默认兜底）。
 *
 * ⚠️ **两类语义住在同一个 ns 里**，改键前先分清（2026-10-11 用户重新裁定）：
 *   · `maxParallelChildren`
 *     ⇒ **运行期回落档**（`config.X ?? corumGlobal().X ?? 默认`），改它会立刻影响
 *     所有未显式配该键的预设；
 *   · `defaultModel` / `defaultResearchModel`
 *     ⇒ **双重身份**：既是**新建预设的模板值**（设置页创建草稿时预填），**也是运行期
 *     兜底档**（子 Agent 路由三档：预设里配的模型 ＞ 本项 ＞ 跟随主 Agent）。详见各自字段的注释。
 *
 * 2026-09-21 裁定：隔离 / 集成相关键（`isolationMode` / `worktreeRoot` / `branchPrefix` /
 * `autoCleanup` / `denyDirectFs` / `integrateChecks` / `merger`）因机制**恒定生效**
 * （写任务恒隔离、集成恒自动、自动清理恒开、合并者恒 parent）已从本 ns **移除**
 * （死键清除）——全局设置页不再暴露它们，运行期解析也不再从这里回落。
 */
export interface CorumSubagentGlobalSettings {
  readonly maxParallelChildren?: number
  /**
   * 子 Agent（worker）模型——**双重身份**：新建预设的模板值 **+ 运行期兜底档**。
   *
   * 用户 2026-10-11 澄清：「全局未设置子 Agent 的 LLM 模型、只设置主 Agent 的 LLM
   * 模型的情况下，**即无论如何都未设置子 Agent 模型时才跟随主 Agent**」。
   *
   * 故该键有两条使用路径：
   *   · **模板**：预设编辑器创建草稿时预填（`SettingsAgentPresetsSection.emptyDraft`）；
   *   · **运行期兜底**：预设没配该角色时，子 Agent 路由落这里
   *     （见 `corumEffectiveModel = corumSessionOverride ?? config.model ?? corumGlobalRoute`）。
   *
   * ⚠️ 这**推翻了 2026-09-18 的旧裁决**（旧裁决认为它「只是模板、不参与运行期解析」，
   * 理由是怕全局改动静默影响所有未配键的预设）。新口径下那正是要的行为。
   */
  readonly defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  /**
   * 同 {@link defaultModel}，面向 research 子 Agent。
   *
   * 运行期回退链与预设侧**对称**（`compile.ts` 的 research 缺省同 worker）：
   * research 先读本键，未配则回落 {@link defaultModel}，再未配才跟随主 Agent。
   * 模板侧则**不**回落（菜单里 research 的「（同 worker）」由预设侧表达）。
   */
  readonly defaultResearchModel?: { provider: string; model: string; reasoningEffort?: string }
}

/** schemastery schema（全键可选；保持 omission 语义——设置面只写用户显式改的键）。 */
// schemastery 的 z<T> 与 default 宽化在嵌套可选键上推断冲突——schema 段单独标注
// 宽接口，运行时行为由 default(undefined) 保证 omission。
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export const CORUM_SUBAGENT_SETTINGS_SCHEMA: z<CorumSubagentGlobalSettings & {
  defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  defaultResearchModel?: { provider: string; model: string; reasoningEffort?: string }
}> = z.object({
  maxParallelChildren: z.number().step(1).min(1).default(undefined as unknown as number),
  defaultModel: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1).default(undefined as unknown as string),
  }).default(undefined as unknown as { provider: string; model: string; reasoningEffort: string }),
  defaultResearchModel: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1).default(undefined as unknown as string),
  }).default(undefined as unknown as { provider: string; model: string; reasoningEffort: string }),
})

/** SettingsScope 的消费面（读+写；跨 bundle 模块级单例）。 */
export interface CorumSubagentGlobalSettingsScope {
  get(): CorumSubagentGlobalSettings
  update(patch: object): Promise<void>
}

/** SettingsProvider 上本模块用到的能力面（窄化，避免耦合官方类型面）。 */
export interface CorumSettingsProviderFace {
  /** 读 namespace 列表（rc3 `settings.describe()`）。 */
  describe?: (options?: unknown) => readonly { ns: string; value?: unknown }[]
}

/**
 * 取（或兜底读取）`corum-subagent` 的 settings scope。
 *
 * rc3 迁移（2026-10-28）：不再调 `settings.register()`（已删除）。namespace 由
 * `settings-registrar.ts` 的 Config 声明自动提供。本函数改为从 `ctx.settings.describe()`
 * 直读——若 boot 行已挂载（正常情况），describe 里有 `corum-subagent`；若 boot 行
 * 未挂载（其他组合），describe 里没有它，返回 undefined（消费方回落默认）。
 *
 * @param settings - settings 服务面（`ctx.get('settings')`）。
 * @returns 可读的 scope；namespace 不在 describe 里时为 `undefined`。
 */
export function acquireCorumSubagentSettingsScope(
  settings: CorumSettingsProviderFace,
): CorumSubagentGlobalSettingsScope | undefined {
  const found = (() => {
    try {
      return settings.describe?.().find(d => d.ns === CORUM_SUBAGENT_SETTINGS_NAMESPACE)
    } catch {
      return undefined
    }
  })()
  if (found === undefined) return undefined
  return {
    get: () => {
      try {
        const row = settings.describe?.().find(d => d.ns === CORUM_SUBAGENT_SETTINGS_NAMESPACE)
        return (row?.value ?? {}) as CorumSubagentGlobalSettings
      } catch {
        return {}
      }
    },
    // 写路径走 `ctx.settings.update('corum-subagent', patch)`（volatile 字段持久化）。
    update: async (patch: object) => {
      // settings.update 需要 ns + patch，但本面是窄化的 CorumSettingsProviderFace。
      // 消费方应直接用 ctx.settings.update 而非经本 scope。保留以符合接口形。
      throw new Error('corum-subagent settings write via ctx.settings.update, not this scope')
    },
  }
}
