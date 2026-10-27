/**
 * fork（corum）2026-10-28：**动态用户预设注册**（0.2.1-rc.3 preset 专项 §4.5(c)）。
 *
 * rc3 的 `agent-preset-registry` 不扫描目录——preset 定义只能来自 bundle patch 的
 * `dsh-agent-preset` 行。corum 的用户自建 Agent（`~/.corum/.agent-presets/<id>/`）
 * 不在 bundle patch 里，故必须显式调 `ctx.agentPresets.register()` 把它们注册进
 * registry，否则设置页的新建 Agent 不会出现在 `ctx.agentPresets.list()` 里。
 *
 * ## 机制
 *
 * 1. 读 `~/.corum/.agent-presets/<id>/agent.cordis.yml`（由 `profile-compiler.ts`
 *    在保存/编译时落盘）；
 * 2. 解析为 entry list，前置 `entryListProblem` 校验（从 registry 包值导入）；
 * 3. 调 `ctx.agentPresets.register({ id, plugins, name?, description?, order? })`。
 *
 * ## 错误策略
 *
 * 单个坏用户 preset **不拖垮全部**：解析失败/校验失败/register 失败的 preset 只进
 * warn 日志（带 preset id 和原因），其余照常注册。这与官方 registry 的 `register()`
 * 行为一致——activation 失败的 preset 仍留在 registry 里、`list()` 返回它并带
 * `broken` 诊断。
 *
 * ## 何时调用
 *
 * - 服务启动时（constructor 后、list/mount/select 前）一次性注册全部已有用户 preset；
 * - 保存/编译/删除 preset 后由 agent-service 调 `registerUserPreset(id)` /
 *   `unregisterUserPreset(id)` 同步 registry。
 *
 * ## 服务生命周期
 *
 * `registerAllUserPresets` 返回一个 Promise（`ready`），在 registry 服务
 * inject 可用后 await 完成。agent-service 持有此 `ready` 并在所有 list/mount/
 * select/create 任务相关入口 await 同一 ready，避免重复注册前读到空列表。
 *
 * ## disposer 所有权
 *
 * disposer Map 由 {@link PresetRegistrationState} 实例持有（由 corum-agent
 * 服务实例拥有），随 `ctx.effect` dispose 清理。不用模块级可变 Map
 * （AGENTS 红线 1：跨 bundle shared state 必须是 cordis service）。
 *
 * @module @corum/corum-agent/preset-registration
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parse as parseYaml } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import { entryListProblem } from '@deepseek-ai/dsh-agent-preset-registry'
import { listProfiles } from './profile-store.ts'

/** agent-presets 的存储根（= ~/.corum/.agent-presets）。 */
function agentsRoot(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum'
  return join(resolveDshHome(configured), '.agent-presets')
}

/**
 * registry 服务上本模块用到的能力面（只登记用到的方法/字段）。
 */
export interface AgentPresetRegistryFace {
  /** 注册一个 preset 定义；返回 disposer。 */
  register: (definition: {
    readonly id: string
    readonly name?: string
    readonly description?: string
    readonly order?: number
    readonly plugins: readonly unknown[]
  }) => Promise<() => Promise<void>>
}

/**
 * 取 registry 能力面（服务未挂载 ⇒ undefined）。
 */
export function agentPresetRegistryFace(ctx: Context): AgentPresetRegistryFace | undefined {
  const service: unknown = ctx.get('agentPresets')
  if (service === undefined || service === null || typeof service !== 'object') return undefined
  const candidate = service as AgentPresetRegistryFace
  return typeof candidate.register === 'function' ? candidate : undefined
}

/**
 * 从 `<home>/.agent-presets/<id>/agent.cordis.yml` 读出一个 preset 的 plugins 数组。
 *
 * `agent.cordis.yml` 是一个 cordis entry list（`- id: ...` / `- name: ...` 行），
 * 它本身就是 registry `register()` 接受的 `plugins` 数组。
 *
 * @param id - preset id（= profile id）。
 * @param ctx - 宿主上下文（用于 warn 日志）。
 * @returns 解析后的 entry list；文件缺失返回 undefined（debug 级，不 warn），
 *   解析失败返回 undefined 且 **warn 带 preset id 和原因**。
 */
function readPresetPlugins(id: string, ctx: Context): unknown[] | undefined {
  const dir = join(agentsRoot(), id)
  const file = join(dir, 'agent.cordis.yml')
  if (!existsSync(file)) return undefined
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = parseYaml(raw)
    if (!Array.isArray(parsed)) {
      ctx.logger.warn(`corum-agent: preset "${id}" agent.cordis.yml parsed to non-array (${typeof parsed}) — skipping`)
      return undefined
    }
    return parsed
  } catch (error: unknown) {
    ctx.logger.warn(`corum-agent: preset "${id}" agent.cordis.yml parse failed: ${String(error)}`)
    return undefined
  }
}

/**
 * 从 `<home>/.agent-presets/<id>/preset.yml` 读出 preset 元数据（name/description/order）。
 *
 * @param id - preset id。
 * @param ctx - 宿主上下文（用于 warn 日志）。
 */
function readPresetMetadata(id: string, ctx: Context): { name?: string; description?: string; order?: number } {
  const dir = join(agentsRoot(), id)
  const file = join(dir, 'preset.yml')
  if (!existsSync(file)) return {}
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = parseYaml(raw) as { name?: string; description?: string; order?: number } | null
    if (parsed === null || typeof parsed !== 'object') {
      ctx.logger.warn(`corum-agent: preset "${id}" preset.yml parsed to non-object (${typeof parsed}) — using empty metadata`)
      return {}
    }
    return {
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
      ...(typeof parsed.order === 'number' ? { order: parsed.order } : {}),
    }
  } catch (error: unknown) {
    ctx.logger.warn(`corum-agent: preset "${id}" preset.yml parse failed: ${String(error)} — using empty metadata`)
    return {}
  }
}

/**
 * 动态 `entryListProblem` 校验（从 registry 包值导入的同一函数）。
 *
 * `entryListProblem` 是 registry 包的公开导出（`export { entryListProblem }`），
 * 且 `@deepseek-ai/dsh-agent-preset-registry` 已在 corum-agent 的
 * dependencies + tsdown external 列表里，故值导入不违反 external 纪律。
 * 这比 register() 内部的事后校验更早可诊断——前置校验给出明确的 preset id + 原因。
 *
 * @returns undefined = 校验通过；string = 问题描述。
 */
function validatePlugins(plugins: unknown[]): string | undefined {
  return entryListProblem(plugins)
}

/**
 * 已注册的用户 preset id → disposer 的持有者。
 *
 * 由 {@link CorumAgentService} 实例拥有（通过 `new PresetRegistrationState(ctx)`
 * 在构造器里创建），随 `ctx.effect` dispose 清理。不用模块级可变 Map
 * （AGENTS 红线 1）。HMR 重载会重建 service 实例 ⇒ 新 state，旧 disposer
 * 随旧 service 的 effect dispose 清理，不会残留。
 */
export class PresetRegistrationState {
  /** 已注册的用户 preset id → disposer。用于更新/删除时先 dispose 旧定义。 */
  private readonly disposers = new Map<string, () => Promise<void>>()
  /**
   * 启动注册的 ready Promise。在 `registerAllUserPresets` 调用时赋值，
   * 在所有 list/mount/select/create 任务相关入口 await。
   */
  private readyPromise: Promise<void> | undefined

  constructor(private readonly ctx: Context) {
    // 随 ctx dispose 清理所有 disposer（HMR 重载 / 服务销毁时）。
    ctx.effect(() => () => {
      // 收集所有 disposer 的清理 Promise，确保 context 销毁时等待完成。
      const disposePromises: Promise<void>[] = []
      for (const [id, disposer] of this.disposers) {
        const p = Promise.resolve(disposer()).catch(error => {
          this.ctx.logger.warn(`corum-agent: preset disposer failed for "${id}": ${String(error)}`)
        })
        disposePromises.push(p)
      }
      this.disposers.clear()
      // 返回 Promise.all 的 then-chain 使 effect 等待所有 disposer 完成。
      void Promise.all(disposePromises)
    }, 'corum-agent: preset registration disposers')
  }

  /** 启动注册的 ready Promise（undefined = 尚未启动注册）。 */
  get ready(): Promise<void> | undefined { return this.readyPromise }

  /**
   * 注册**一个**用户 preset 到 registry。
   *
   * @param id - preset id（= profile id）。
   * @returns true = 注册成功；false = 跳过（文件缺失/解析失败/registry 不可用）。
   */
  async registerUserPreset(id: string): Promise<boolean> {
    const face = agentPresetRegistryFace(this.ctx)
    if (face === undefined) return false
    const plugins = readPresetPlugins(id, this.ctx)
    if (plugins === undefined) return false
    const problem = validatePlugins(plugins)
    if (problem !== undefined) {
      this.ctx.logger.warn(`corum-agent: preset "${id}" validation failed: ${problem}`)
      return false
    }
    const metadata = readPresetMetadata(id, this.ctx)
    // 先 dispose 旧定义（如果之前注册过）——registry.register() 对重复 id 会抛
    // `Duplicate agent preset`，所以更新场景必须先 unregister 再 register。
    const oldDisposer = this.disposers.get(id)
    if (oldDisposer !== undefined) {
      try { await oldDisposer() } catch (error) {
        this.ctx.logger.warn(`corum-agent: disposer for old preset "${id}" failed during re-register: ${String(error)}`)
      }
      this.disposers.delete(id)
    }
    try {
      const disposer = await face.register({
        id,
        ...metadata,
        plugins,
      })
      this.disposers.set(id, disposer)
      return true
    } catch (error: unknown) {
      // register 失败：旧定义已被 dispose 移除，新定义未注册——该 preset 在 registry 里消失。
      // warn 显式说明旧定义已移除，不伪成功。
      this.ctx.logger.warn(`corum-agent: failed to register preset "${id}" (old definition was removed): ${String(error)}`)
      return false
    }
  }

  /**
   * 注销一个用户 preset（从 registry 移除）。
   *
   * @param id - preset id。
   */
  async unregisterUserPreset(id: string): Promise<void> {
    const disposer = this.disposers.get(id)
    if (disposer === undefined) return
    this.disposers.delete(id)
    try { await disposer() } catch (error) {
      this.ctx.logger.warn(`corum-agent: disposer failed during unregister of preset "${id}": ${String(error)}`)
    }
  }

  /**
   * 启动时一次性注册全部已有用户 preset。
   *
   * 遍历 `~/.corum/.agent-presets/` 下有 `agent.cordis.yml` 的子目录，逐个注册。
   * 单个坏 preset 不拖垮全部（catch 后继续下一个，warn 带 id 和原因）。
   *
   * 返回的 Promise 也赋值给 `readyPromise`，供 agent-service 的入口 await。
   */
  async registerAllUserPresets(): Promise<void> {
    const run = this.doRegisterAll()
    this.readyPromise = run
    return run
  }

  private async doRegisterAll(): Promise<void> {
    const face = agentPresetRegistryFace(this.ctx)
    if (face === undefined) return
    const root = agentsRoot()
    if (!existsSync(root)) return
    // 使用 profile-store 的 listProfiles 获取有效 profile id 列表（已校验 slug 格式）
    const profiles = listProfiles()
    for (const profile of profiles) {
      try {
        await this.registerUserPreset(profile.id)
      } catch (error: unknown) {
        this.ctx.logger.warn(`corum-agent: startup preset registration failed for "${profile.id}": ${String(error)}`)
      }
    }
  }
}
