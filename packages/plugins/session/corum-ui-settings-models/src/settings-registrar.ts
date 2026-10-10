/**
 * `ui-onboarding` settings namespace 的 **boot 注册行**（host 常驻）。
 *
 * ## 为什么需要这个入口
 *
 * `ui-onboarding`（内测声明的 `welcomeNoticeVersion` 持久化面）原本由官方
 * `ui-settings-general` 的 host 半注册，而桌面 IDE overlay 禁用了官方该行
 * （`cordis.ide.patch.yml`）——于是 IDE 模式下该 ns 无人注册，`WelcomeNotice`
 * 的 `scope.set()` 写不进去，弹窗永远报「暂时无法保存确认状态」。
 *
 * 旧修法（`packages/desktop/src/host/boot.ts` 根 ctx 上的 `setInterval` 轮询）
 * 有两个结构性缺陷，Windows 冷机上必现其一：
 *   ① **先清轮询、再试注册**——注册调用若抛一次瞬时错（settings 服务半初始化），
 *     轮询已被清除，永不重试 ⇒ 命名空间永久缺失；
 *   ② 根 ctx 回调的装配时序不满足（`ctx.inject(['settings'])` 在根上不触发，
 *     见 `@corum/corum-ide-ui` host 注释），只能靠裸 `get` 轮询。
 *
 * 本行走与 `corum-subagent-settings` / `corum-memory-settings` 同一纪律：
 * 独立 cordis 行（自己的 fiber 上下文）+ 成功才停轮询 + 重复注册视为成功
 * （minimal 模式官方行仍在，它先注册时这里走 `already registered` 分支）。
 * 行在 `cordis.patch.yml` 常驻（不进 IDE overlay），故 minimal / IDE 双模式覆盖。
 *
 * ## 轮询为什么不设超时
 *
 * 同类两行是 15s 熔断 + 服务内兜底注册；本 ns 没有第二注册点（host 侧唯一的
 * 注册者就是本行），超时放弃 = 永久缺失。冷机（尤其 Windows + Defender 全量
 * 扫描）下 settings 服务激活超过 15s 是实测形态，故长驻直到成功；成功后清除，
 * 平时每 100ms 一次 map 查询，开销可忽略。
 *
 * @module @corum/corum-ui-settings-models/settings-registrar
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WELCOME_NOTICE_SETTINGS_NAMESPACE } from './onboarding-copy.ts'

/** cordis 行名（与 package.json exports 的子路径对应）。 */
export const name = 'corum-ui-onboarding-settings'

/**
 * Onboarding 命名空间 schema —— 与官方 `ui-settings-general` host 半逐字一致
 * （`welcomeNoticeVersion` 一个必填字段；客户端以精确相等判定已确认）。
 */
const OnboardingSettingsSchema = z.object({ welcomeNoticeVersion: z.string() })

/** settings 服务上本模块用到的注册面（窄化，避免耦合官方类型面）。 */
interface OnboardingSettingsProviderFace {
  register: (ns: string, schema: unknown) => unknown
}

/** settings 服务在 boot 早期可能尚未挂载——与官方同款短轮询。 */
const POLL_INTERVAL_MS = 100

/**
 * 在 host 上下文注册 `ui-onboarding` settings namespace（幂等：重复注册视为成功）。
 *
 * @param ctx - host 行上下文。
 */
export function apply(ctx: Context): void {
  const register = (): boolean => {
    let settings: OnboardingSettingsProviderFace | undefined
    try {
      settings = ctx.get('settings') as OnboardingSettingsProviderFace | undefined
    } catch {
      return false
    }
    if (settings === undefined) return false
    try {
      settings.register(WELCOME_NOTICE_SETTINGS_NAMESPACE, OnboardingSettingsSchema)
    } catch (error) {
      // minimal 模式官方 ui-settings-general 先注册了同名空间——命名空间本身
      // 已存在，不视为失败。
      if (!String(error).includes('is already registered')) throw error
    }
    ctx.logger.info(`corum-ui-settings-models: ${WELCOME_NOTICE_SETTINGS_NAMESPACE} namespace registered (boot row)`)
    return true
  }

  // 首轮调用同样可能抛瞬时错（settings 服务半初始化——正是 Windows 冷机
  // 上旧 boot 轮询「先清后试」永久失败的形态）：吞掉转轮询，成功才停。
  try {
    if (register()) return
  } catch (error) {
    ctx.logger.warn(`corum-ui-settings-models: boot settings register failed: ${String(error)}`)
  }
  ctx.logger.info('corum-ui-settings-models: waiting for settings service to register ui-onboarding…')
  const poll = setInterval(() => {
    try {
      if (register()) clearInterval(poll)
    } catch (error) {
      ctx.logger.warn(`corum-ui-settings-models: boot settings register failed: ${String(error)}`)
    }
  }, POLL_INTERVAL_MS)
}
