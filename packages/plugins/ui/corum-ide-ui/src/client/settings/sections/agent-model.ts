/**
 * Agent 预设的**模型投影兜底**（防御修复；2026-11 补）。
 *
 * ## 为什么单独一个模块
 *
 * `host agent-service.ts:1188` 的 `listProfilesRemote` 是 `model: p.model` 直读，
 * 而 `p` 来自 `profile-store.ts:64` 的 `JSON.parse(...) as AgentProfile` —— **无校验**。
 * 盘上任何一份缺 `model` 的 `agent.json`（装进来的模块预设实测会缺 `terminal` /
 * `memoryPolicy`，同一形态，见 agent-service.ts:1207 的注释）都会让 `profile.model`
 * 变成 `undefined`。此前名片直接读 `profile.model.model` ⇒ 设置页「Agent 预设」
 * **整页白屏**（一张坏卡连坐整页）。
 *
 * 兜底文案取 `session-bar.tsx:517` 已有的语义（`entry.model?.model ?? '未记录'`）——
 * 同一份 UI 里「模型投影缺失」只有一种说法，不新造术语。
 *
 * ⚠️ 这是**防御修复**：它保证坏数据不再炸整页，**不等于**那条实机缺陷已复现/已关闭；
 * 根因（host 侧直读未校验）仍在 host，本轮不动它。
 * @module corum-ide-ui/client/settings/sections/agent-model
 */

/** 一份主 Agent 模型路由（与 host `ProfileModel` 同形；本页只消费这三键）。 */
export interface AgentModelRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * 模型缺失时的展示文案（与 `session-bar.tsx` 的 `未记录` 一致）。
 */
export const MISSING_MODEL_LABEL = '未记录'

/**
 * 取名片的模型名（缺 `model` / 缺 `model.model` / 空串一律回落文案，**不抛**）。
 * @param model - host 投影的模型路由；可能整体缺失（盘上数据无校验）。
 * @returns 模型 id 原样返回，缺失时返回 {@link MISSING_MODEL_LABEL}。
 */
export function agentModelLabel(model: AgentModelRoute | null | undefined): string {
  const name = model?.model
  return typeof name === 'string' && name.trim() !== '' ? name : MISSING_MODEL_LABEL
}

/**
 * 取可用的模型路由（`provider` 与 `model` 都必须是**非空字符串**才算配了）。
 *
 * 编辑页回填用：缺失时返回 `undefined`，由调用方保持「未选」状态而不是伪造一个路由
 * （伪造会在用户不改下拉的情况下，保存时静默改写他的模型配置）。
 * @param model - host 投影的模型路由。
 * @returns 原路由（字段原样）或 `undefined`。
 */
export function agentModelRoute(model: AgentModelRoute | null | undefined): AgentModelRoute | undefined {
  if (model === null || model === undefined) return undefined
  if (typeof model.provider !== 'string' || model.provider.trim() === '') return undefined
  if (typeof model.model !== 'string' || model.model.trim() === '') return undefined
  return model
}
