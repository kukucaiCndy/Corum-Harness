/**
 * 模型级（per-model）能力字段的读写：在 provider profile 的 `models[]` 数组里
 * 定位单个模型，读/写其 contextWindow / maxTokens / input(图片输入) / 思考模式。
 *
 * 数据形态（侦察报告 §4）：
 * - deepseek（ns `llm-deepseek`）：整节即 profile，模型目录在 profile.models
 *   （DeepSeekCatalogModel：contextWindow/maxTokens/inputModalities/thinking/reasoningEffort）。
 * - pi-ai（ns `llm-pi-ai`）：profile 在 providers.<route>，模型目录 profile.models
 *   （PiAiModelProfile：contextWindow/maxTokens/input/reasoningEfforts）。
 *
 * 写通路复用 settings/mutate 的 path ops（set/unset），与 ProviderEditor 同源。
 */

import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsSchemaOperations } from './schema-operations.ts'

/** 费用配置（自建字段 `pricing`，每 M Token 单价；dsh 无此字段，纯记录）。 */
export interface ModelPricing {
  /** 输入 · 缓存命中（¥/M Token）。 */
  cacheHit?: number
  /** 输入 · 缓存未命中。 */
  cacheMiss?: number
  /** 输出。 */
  output?: number
}

/** 单个模型的可编辑能力草稿。 */
export interface ModelDraft {
  /** 模型 id（目录内唯一）。 */
  id: string
  /** 上下文窗口（token 数；undefined = 用 route 默认）。 */
  contextWindow?: number
  /** 最大输出 token 数。 */
  maxTokens?: number
  /** 是否支持图片输入（input modalities 含 image）。 */
  imageInput: boolean
  /** 思考模式档位（reasoningEffort 枚举值；undefined = 未配置/协议默认）。 */
  thinking?: string
  /** 费用配置（自建 pricing 字段）。 */
  pricing?: ModelPricing
}

/**
 * 从 `reasoningEfforts`（pi-ai 的档位集合）里取一个代表档，用于卡片/摘要显示。
 *
 * 只关心「这个模型支不支持思考」与「显示哪一档」，不参与请求派发：
 *   - `false`（pi-ai 的显式非推理模型编码）⇒ undefined；
 *   - 无对象 / 空收集 ⇒ undefined；
 *   - 只有 `off` ⇒ undefined（声明了 off 等于不支持推理，与 `readModelThinking` 一致）；
 *   - 否则取**第一个非 off 档**（`reasoningEfforts` 的键序即声明序）。
 * @param raw - 模型条目的 `reasoningEfforts` 原值。
 * @returns 代表档 id，或 undefined（不支持思考）。
 */
function reasoningLevelOfEfforts(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const levels = Object.keys(raw as Record<string, unknown>).filter(level => level !== 'off')
  return levels[0]
}

/**
 * 读 provider profile 的模型目录数组。
 * @returns 模型对象数组（可能为空）。
 */
export function readModels(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView,
  settingsPath: readonly string[],
): Record<string, unknown>[] {
  const list = schema.getPath(namespace.value, [...settingsPath, 'models'])
  if (!Array.isArray(list)) return []
  return list.filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
}

/**
 * 读单个模型的能力草稿。不存在则返回仅含 id 的空草稿。
 *
 * fork（corum）2026-11-22（issue #236 第一条）：`thinking` 的判据从「只看模型级
 * 单值字段」放宽为「模型级单值字段 → 回退 `reasoningEfforts` 档位集合」。
 *
 * 缺陷本体（可复现，见 tests/model-card-thinking.spec.ts）：pi-ai 族保存时，默认档
 * 为 off / 未选的情况下代码会 `delete next.reasoning`（见 ModelConfigView 与
 * `piAiThinkingWrite` 的归一），此时模型条目里只剩 `reasoningEfforts`（档位集合）。
 * 卡片只读单值字段 ⇒ 判成「没有思考」，可用户明明勾了 low/high/max —— 这正是
 * 「配置里设了思考档位，卡片仍显示没有思考」。
 *
 * 判定口径（与 pi-ai 键域一致）：有 ≥1 个**非 off** 档才算支持思考；只声明 `off`、
 * 或 `reasoningEfforts === false`（显式非推理模型）都不算。
 */
export function readModel(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView,
  settingsPath: readonly string[],
  modelId: string,
): ModelDraft {
  const models = readModels(schema, namespace, settingsPath)
  const raw = models.find(m => typeof m.id === 'string' && m.id === modelId)
  if (raw === undefined) return { id: modelId, imageInput: false }
  const input = raw.input ?? raw.inputModalities
  const imageInput = Array.isArray(input) && (input as unknown[]).includes('image')
  const declared = typeof raw.reasoningEffort === 'string'
    ? raw.reasoningEffort
    : typeof raw.reasoning === 'string'
      ? raw.reasoning
      : undefined
  // 回退：模型级单值字段缺席时，从已声明档位集合里取一个代表档。
  const thinking = declared ?? reasoningLevelOfEfforts(raw.reasoningEfforts)
  const pricingRaw = typeof raw.pricing === 'object' && raw.pricing !== null
    ? raw.pricing as Record<string, unknown>
    : undefined
  const pricing: ModelPricing | undefined = pricingRaw === undefined ? undefined : {
    ...(typeof pricingRaw.cacheHit === 'number' ? { cacheHit: pricingRaw.cacheHit } : {}),
    ...(typeof pricingRaw.cacheMiss === 'number' ? { cacheMiss: pricingRaw.cacheMiss } : {}),
    ...(typeof pricingRaw.output === 'number' ? { output: pricingRaw.output } : {}),
  }
  return {
    id: modelId,
    ...(typeof raw.contextWindow === 'number' ? { contextWindow: raw.contextWindow } : {}),
    ...(typeof raw.maxTokens === 'number' ? { maxTokens: raw.maxTokens } : {}),
    imageInput,
    ...(thinking === undefined ? {} : { thinking }),
    ...(pricing === undefined ? {} : { pricing }),
  }
}

/** 把 K/M 后缀的容量文本解析为 token 数（256K→256000，1M→1000000）。无法解析返回 undefined。 */
export function parseCapacity(text: string): number | undefined {
  const t = text.trim()
  if (t === '') return undefined
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(t)
  if (m === null) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return undefined
  const unit = (m[2] ?? '').toLowerCase()
  return Math.round(unit === 'k' ? n * 1000 : unit === 'm' ? n * 1000000 : n)
}

/** 把 token 数格式化为 K/M 文本（256000→256K）。 */
export function formatCapacity(value: number | undefined): string {
  if (value === undefined) return ''
  if (value >= 1000000 && value % 1000000 === 0) return `${value / 1000000}M`
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}K`
  return String(value)
}
