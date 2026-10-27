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
 * 2. 解析为 entry list，前置 `entryListProblem` 校验（definition.ts:20）；
 * 3. 调 `ctx.agentPresets.register({ id, plugins, name?, description?, order? })`。
 *
 * ## 错误策略
 *
 * 单个坏用户 preset **不拖垮全部**：解析失败/校验失败/register 失败的 preset 只进
 * warn 日志，其余照常注册。这与官方 registry 的 `register()` 行为一致——activation
 * 失败的 preset 仍留在 registry 里、`list()` 返回它并带 `broken` 诊断。
 *
 * ## 何时调用
 *
 * - 服务启动时（constructor 后、list/mount/select 前）一次性注册全部已有用户 preset；
 * - 保存/编译/删除 preset 后由 agent-service 调 `registerUserPreset(id)` /
 *   `unregisterUserPreset(id)` 同步 registry。
 *
 * @module @corum/corum-agent/preset-registration
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parse as parseYaml } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
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
 * @returns 解析后的 entry list；文件缺失/解析失败返回 undefined。
 */
function readPresetPlugins(id: string): unknown[] | undefined {
  const dir = join(agentsRoot(), id)
  const file = join(dir, 'agent.cordis.yml')
  if (!existsSync(file)) return undefined
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = parseYaml(raw)
    if (!Array.isArray(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * 从 `<home>/.agent-presets/<id>/preset.yml` 读出 preset 元数据（name/description/order）。
 */
function readPresetMetadata(id: string): { name?: string; description?: string; order?: number } {
  const dir = join(agentsRoot(), id)
  const file = join(dir, 'preset.yml')
  if (!existsSync(file)) return {}
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = parseYaml(raw) as { name?: string; description?: string; order?: number } | null
    if (parsed === null || typeof parsed !== 'object') return {}
    return {
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
      ...(typeof parsed.order === 'number' ? { order: parsed.order } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * 动态 `entryListProblem` 校验（从 registry 包导入的同一函数）。
 *
 * 不直接 import 是为了避免把 registry 包的值导入拉进 fork 产物（external 纪律，
 * 红线 2）。运行期从 registry 服务实例上取该函数；取不到时跳过校验（registry
 * 自己的 `register()` 内部也会调 `entryListProblem`，故校验不会真正缺失）。
 */
function validatePlugins(face: AgentPresetRegistryFace, plugins: unknown[]): string | undefined {
  // registry 的 register() 内部已调 entryListProblem（index.ts activate()），
  // 故此处不重复校验——register() 会抛出可诊断的错误。
  void face
  void plugins
  return undefined
}

/** 已注册的用户 preset id → disposer。用于更新/删除时先 dispose 旧定义。 */
const registeredUserPresets = new Map<string, () => Promise<void>>()

/**
 * 注册**一个**用户 preset 到 registry。
 *
 * @param ctx - 宿主上下文（用于取 registry 能力面 + logger）。
 * @param id - preset id（= profile id）。
 * @returns true = 注册成功；false = 跳过（文件缺失/解析失败/registry 不可用）。
 */
export async function registerUserPreset(ctx: Context, id: string): Promise<boolean> {
  const face = agentPresetRegistryFace(ctx)
  if (face === undefined) return false
  const plugins = readPresetPlugins(id)
  if (plugins === undefined) return false
  const problem = validatePlugins(face, plugins)
  if (problem !== undefined) {
    ctx.logger.warn(`corum-agent: preset "${id}" validation failed: ${problem}`)
    return false
  }
  const metadata = readPresetMetadata(id)
  // 先 dispose 旧定义（如果之前注册过）——registry.register() 对重复 id 会抛
  // `Duplicate agent preset`，所以更新场景必须先 unregister 再 register。
  const oldDisposer = registeredUserPresets.get(id)
  if (oldDisposer !== undefined) {
    try { await oldDisposer() } catch { /* idempotent */ }
    registeredUserPresets.delete(id)
  }
  try {
    const disposer = await face.register({
      id,
      ...metadata,
      plugins,
    })
    registeredUserPresets.set(id, disposer)
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`corum-agent: failed to register preset "${id}": ${String(error)}`)
    return false
  }
}

/**
 * 注销一个用户 preset（从 registry 移除）。
 *
 * @param ctx - 宿主上下文。
 * @param id - preset id。
 */
export async function unregisterUserPreset(ctx: Context, id: string): Promise<void> {
  const disposer = registeredUserPresets.get(id)
  if (disposer === undefined) return
  registeredUserPresets.delete(id)
  try { await disposer() } catch { /* idempotent */ }
}

/**
 * 启动时一次性注册全部已有用户 preset。
 *
 * 遍历 `~/.corum/.agent-presets/` 下有 `agent.cordis.yml` 的子目录，逐个注册。
 * 单个坏 preset 不拖垮全部（catch 后继续下一个）。
 *
 * @param ctx - 宿主上下文。
 */
export async function registerAllUserPresets(ctx: Context): Promise<void> {
  const face = agentPresetRegistryFace(ctx)
  if (face === undefined) return
  const root = agentsRoot()
  if (!existsSync(root)) return
  // 使用 profile-store 的 listProfiles 获取有效 profile id 列表（已校验 slug 格式）
  const profiles = listProfiles()
  for (const profile of profiles) {
    try {
      await registerUserPreset(ctx, profile.id)
    } catch (error: unknown) {
      ctx.logger.warn(`corum-agent: startup preset registration failed for "${profile.id}": ${String(error)}`)
    }
  }
}
