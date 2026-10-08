/**
 * @corum/corum-platform — 平台事实源（corum 核心插件，**不可卸载**）。
 *
 * ## 两个事实，分开命名，不得混用（docs/PLAN-2026-10-07 §7.1 已拍板）
 *
 * | 事实 | 取值 | 谁用 | 回答什么问题 |
 * |---|---|---|---|
 * | 运行时平台 | `process.platform` | `getPlatform()` 及其全部消费者 | 「我现在**跑在哪**」 |
 * | 烘入常量 | `__CORUM_TARGET_PLATFORM__`（打包时写入） | 仅①运行时一致性断言②host 侧编译期特化瘦身③诊断 | 「这份产物**是为谁打的**」 |
 *
 * 运行期真正决定「托盘能不能建、`/bin/zsh` 存不存在、`xdg-open` 可不可用」的
 * 是**当前这台机器**，不是打包时的意图。**平台的「行为事实源」只有一个 =
 * 实际运行平台；烘入常量禁止用于选实现**（否则一致性断言退化成恒真废码）。
 *
 * ## 服务面
 *
 * `platform`（cordis 服务，host 侧，天然跨 bundle 单例 —— 红线 1）：
 *   - `getPlatform()` —— 实际运行平台（`process.platform`）。
 *   - `getBakedTargetPlatform()` —— 烘入的目标平台；本包自身构建/dev 态未烘入
 *     时返回 `undefined`（=「这份产物没有目标平台事实」，断言只对打包态生效）。
 *
 * 渲染层不经 RPC（平台是启动期就要的常量，异步拉取会迫使消费面全是异步）：
 * preload 的 `window.corumDesktop.getPlatform()` 同步返回（合法 window 挂载，
 * 红线 1 例外：写一次、只读，与 `__DSH_BOOT__` 同类）。
 *
 * ## 不可卸载
 *
 * 与 `@corum/corum-git-core` 同规：cordis.patch.yml 的 insert 段挂载 +
 * 插件管理器（packages/desktop/src/host/plugin-manager.ts 的
 * CORE_PLUGIN_PACKAGES / CORE_PLUGIN_ENTRIES）按包名过滤，不显示启停/卸载入口。
 *
 * @module corum-platform
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'

/** 打包链支持的目标平台集合（= `process.platform` 中我们出包的三个值）。 */
export type CorumPlatform = 'darwin' | 'linux' | 'win32'

/**
 * 烘入的目标平台。**两个读通道，同一事实**：
 *
 * 1. **main 进程**（Electron 壳）：打包链 tsdown `define` 把
 *    `__CORUM_TARGET_PLATFORM__` 烘成字符串字面量，main.ts 的一致性断言
 *    直读它（编译期常量，启动最早一刻就可用）；
 * 2. **host 子进程**（本服务跑的地方）：host 的 Node bundle 是**平台无关构建**
 *    （define 不烘它——同一份 host 闭包被三个平台的产物复用），改由 main.ts
 *    在 spawn host 时把烘入值透传成 `CORUM_TARGET_PLATFORM` 环境变量。
 *
 * dev 态（未烘入、无透传）返回 `undefined` =「这份产物没有目标平台事实」，
 * 一致性断言只对打包态生效。
 *
 * ⚠️ 它回答的是「这份产物是为谁打的」，**禁止用于选实现**（行为决策只跟随
 * `getPlatform()`）；拿它替代运行时平台会让一致性断言退化成恒真废码。
 */

/** 环境变量名与 main.ts 的 buildHostEnv 透传保持一致（单一事实源在打包链）。 */
const BAKED_TARGET_ENV = 'CORUM_TARGET_PLATFORM'

/**
 * 读取烘入目标平台（host 侧：main 透传的环境变量；未透传返回 `undefined`）。
 * 非白名单值（手滑写错 flag）同样按「无目标平台事实」处理——断言侧（main.ts
 * 的 typeof 守卫读法）会原样报出错误值，这里不做第二份判定逻辑。
 */
export function bakedTargetPlatform(): CorumPlatform | undefined {
  const value = process.env[BAKED_TARGET_ENV]
  return value === 'darwin' || value === 'linux' || value === 'win32' ? value : undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 平台事实源（corum 核心插件，不可卸载）：getPlatform()=实际运行平台；getBakedTargetPlatform()=烘入目标（仅断言/诊断）。 */
    platform: PlatformService
  }
}

/**
 * 平台事实源服务（corum 核心插件，不可卸载）。
 *
 * host 侧 cordis 服务：经 `@Remote` 暴露 RPC（service 名 `platform`，client 可调
 * `/api/platform/get`），也供 host 同进程直调（`ctx.platform.getPlatform()`）。
 */
export class PlatformService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'platform')
  }

  /**
   * 实际运行平台（`process.platform`）——**唯一的行为事实源**。
   * 回答「我现在跑在哪」；平台实现的选择必须跟随它。
   */
  @Remote('get')
  getPlatform(): CorumPlatform {
    return process.platform as CorumPlatform
  }

  /**
   * 烘入的目标平台 —— 仅供①运行时一致性断言②host 侧编译期特化瘦身③诊断。
   * 未烘入（dev 态）返回 `undefined`。**不得用于选实现。**
   */
  @Remote('getBakedTarget')
  getBakedTargetPlatform(): CorumPlatform | undefined {
    return bakedTargetPlatform()
  }
}

/**
 * 插件 apply（cordis 装配点）：new 出 PlatformService 挂到 host ctx。
 * cordis.patch.yml 的 insert 段挂载行使本 apply 运行（immediately）。
 * @param ctx - host cordis context。
 */
export function apply(ctx: Context): void {
  new PlatformService(ctx)
}
