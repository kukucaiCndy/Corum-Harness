/**
 * fork（corum）2026-09-27：**在跑的 Agent 就地重挂 preset 组合**（用户需求「MCP 配置保存后
 * 实时生效，不要重启软件」的机制半边）。
 *
 * ## 为什么需要它（实测根因，2026-09-27）
 *
 * 用户会话中给指挥模式 profile 加了 MCP（`mcpServers: [pencil-mcp, chrome-devtools-9333]`），
 * 期望正在用的会话立刻拿到 `mcp__*` 工具；实测：
 *   · 新建泳道（第一轮之前）选该 profile ⇒ **有** 35 个 MCP 工具（父与子都有）；
 *   · 已开过回合的泳道 ⇒ `agentPresets.select` 抛
 *     `agent-preset/locked: session "…" has already started; its agent preset is fixed`
 *     ⇒ 父**永远**看不到新加的 MCP 行；子会话挂父的 live preset ⇒ 子也没有。
 * 于是只能重启软件（宿主重建会话时按当前 `agent.cordis.yml` 重新挂载）——这正是用户不接受的那件事。
 *
 * ## 官方机制其实已经具备"重挂"的能力（读 shipped 代码得出）
 *
 * `agent-presets` 内部：
 *   · 常驻挂载 `ensureStanding(preset)` **按组合文件指纹（`compositionStamp(preset.path)`）校验**：
 *     指纹变了就丢弃该 preset 的常驻挂载、重新 `mountPreset` ⇒ 新加的 `mcp-*` 行被挂上
 *     （旧的随之不再被引用）；
 *   · `recompose(agentCtx, id)` = 重绑 agent 的 scope parent 到最新常驻挂载 + **`emit('tools/change')`**
 *     ⇒ 工具面变化的通知是官方自己发的，**下一轮请求**即带上新工具。
 * 唯一的拦路石是 `select` 里的 `turnBoundary` 检查（`openTurnStartSeq !== null || lastTurn > 0`
 * 即锁死），而 `recompose` 本身**没有**这道检查 —— 它就是这里要调的动作。
 *
 * ## 为什么用「能力接口」而不是直接依赖实现包（红线 3）
 *
 * `recompose` 不在官方 `agentPresets` 的公开类型面上（只是实现的公开方法）。故这里按红线 3
 * 收窄成本地能力接口 + 调用点**特性检测**：拿不到该能力时**保持既有行为**（保存后下次重建才
 * 生效），绝不因此抛错 or 假装成功。
 *
 * @module @corum/corum-agent/preset-reload
 */

import type { Context } from '@deepseek-ai/cordis'
// 类型面：让 `ctx.get('agentPresets')` 解析出官方服务类型（与 child-agent.ts 同款做法）。
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

/** `agent-presets` 服务上本模块用到的能力面（只登记用到的那两个方法/字段）。 */
export interface AgentPresetReloadFace {
  /** 把 agent 的 scope 重新绑定到该 preset 的**最新组合**（细节见模块头注）。 */
  readonly recompose?: (agentCtx: Context, id: string) => Promise<unknown>
  /**
   * 常驻挂载表（官方实现里的私有字段）。
   *
   * **为什么必须碰它**（2026-09-27 实测）：官方 `ensureStanding` 在「组合指纹变了」的分支里
   * 只做 `this.standing.delete(id)` 就重挂，**从不 `dispose()` 旧 scope** ⇒ 旧的 MCP server
   * 进程留在系统里。实测证据：同一 profile 连保存两次（MCP 未变），我们自己的
   * `mcp-server-darwin-arm64 --agent corum` 由 **1 → 2**、`chrome-devtools-mcp`(9333) 由
   * **1 套 → 2 套**。用户会反复改 MCP，必须由我们销毁旧的，否则每改一次多一套进程。
   */
  readonly standing?: Map<string, Promise<{ readonly scope?: { dispose?: () => Promise<unknown> } }>>
}

/**
 * 销毁该 preset 的旧常驻挂载（若存在），避免重挂时泄漏 MCP server 进程。
 *
 * 顺序很关键：**先销毁旧的 → 再 `recompose`**。`recompose` 内部的 `ensureStanding` 发现表里
 * 已无该 id 就会重新 `mountPreset`（按新 yml 挂新行），随后把 agent 的 scope parent 重绑过去。
 * 全部步骤都是尽力而为：任何一步不可用/失败都只进 warn，绝不让「保存 profile」这个用户操作报错。
 *
 * @param face - 能力面（调用方已确认 `recompose` 可用）。
 * @param presetId - preset id（= profile id）。
 * @param warn - 告警出口。
 * @returns 是否真的销毁了一个旧常驻挂载。
 */
async function disposeStaleStanding(
  face: AgentPresetReloadFace,
  presetId: string,
  warn: (message: string) => void,
): Promise<boolean> {
  const pending = face.standing?.get(presetId)
  if (pending === undefined) return false
  face.standing?.delete(presetId)
  try {
    const mounted = await pending
    await mounted.scope?.dispose?.()
    return mounted.scope !== undefined
  } catch (error: unknown) {
    warn(`corum-agent: disposing the previous standing mount of "${presetId}" failed: ${String(error)}`)
    return false
  }
}

/**
 * 取出宿主上的重挂能力（服务未挂载 / 实现里没有 `recompose` ⇒ `undefined`）。
 * @param ctx - 任意能解析到根服务表的 cordis 上下文。
 * @returns 能力面；不可用时 `undefined`（调用方据此走「保持既有行为」分支）。
 */
export function agentPresetReloadFace(ctx: Context): AgentPresetReloadFace | undefined {
  const service: unknown = ctx.get('agentPresets')
  if (service === undefined || service === null || typeof service !== 'object') return undefined
  const candidate = service as AgentPresetReloadFace
  return typeof candidate.recompose === 'function' ? candidate : undefined
}

/**
 * 对**一个在跑的 Agent** 就地重挂它的 preset 组合（同 id：人格/工具面不变，只把组合里新加/
 * 删除的行（如 `mcp-*`）落到这个会话上）。
 *
 * 失败**不抛**：保存 profile 是用户操作，不能因为一次重挂失败而报错；失败进 `warn` 通道，
 * 会话保持原来的工具面（下次重建仍然会拿到新组合）。
 *
 * @param ctx - 宿主上下文（用于取能力面）。
 * @param agentCtx - 目标 Agent 的 scope 上下文。
 * @param presetId - 该会话当前使用的 preset id（= profile id）。
 * @param warn - 告警出口（调用方传 logger）。
 * @returns 是否真的发起了重挂（能力不可用 ⇒ false）。
 */
export async function reloadAgentPreset(
  ctx: Context,
  agentCtx: Context,
  presetId: string,
  warn: (message: string) => void,
): Promise<boolean> {
  const face = agentPresetReloadFace(ctx)
  if (face?.recompose === undefined) return false
  // 先销毁旧常驻挂载（防 MCP server 进程泄漏），再重挂到新组合。
  await disposeStaleStanding(face, presetId, warn)
  try {
    await face.recompose(agentCtx, presetId)
    return true
  } catch (error: unknown) {
    warn(`corum-agent: live preset reload failed for "${presetId}": ${String(error)}`)
    return false
  }
}
