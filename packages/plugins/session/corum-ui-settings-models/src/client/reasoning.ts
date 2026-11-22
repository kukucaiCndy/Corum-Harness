/**
 * 思考模式（推理强度）档位：按**单个模型**读取，不翻译——模型返回什么档位 id
 * 就用什么 id（每个模型的档位叫法/数量都不同：deepseek 的 low/high/max、kimi
 * 的自有档、pi-ai 的 minimal/low/medium/high/xhigh/max…）。
 *
 * 数据源（侦察 §2）：
 * - profile 已配置 `reasoningEfforts: false | Partial<Record<档位id, wire拼写>>`：
 *   读它的 key 集合 = 该模型实际支持的档位（用户/之前存过的真实档）。
 * - profile 当前默认档：`reasoningEffort`（deepseek）/ `reasoning`（pi-ai）。
 * - catalog 的 per-model 档位 Remote 读不到（host-only），所以「侦测不到」时
 *   给自定义输入入口（方案 C）：下拉(侦测到) + 「自定义…」手填 wire 值。
 */

import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { SelectOption } from './controls.tsx'
import THINKING_CATALOG from './thinking-catalog.ts'

export type ThinkingFamily = 'deepseek' | 'pi-ai' | undefined

/** 侦测不到时的固定档 valuelist（用户定：off/low/medium/high/xhigh/max）。 */
const FALLBACK_LEVELS: readonly string[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 可勾选的档位上界（= pi-ai schema 的键域，见 dsh-llm-pi-ai `config.ts`：
 * `reasoningEfforts` 的**键**被 `z.union(THINKING_LEVELS)` 校验，只能是这 7 个 id；
 * 可自由填的是**值**——每档发给网关的 wire 拼写）。
 *
 * 故「用户自定义多个档位」的准确语义 = 从这 7 个 id 里勾出该模型实际支持的子集。
 * 勾选顺序按此表归一，保证落盘 dict 键序稳定（同配置重复保存不产生 diff）。
 */
export const KNOWN_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 未配置时的默认选中档（用户定：所有模型默认 high）。 */
export const DEFAULT_THINKING = 'high'

/**
 * 单模型档位 catalog 表（内联自 @earendil-works/pi-ai@0.84.3 的
 * dist/providers/data/*.json，经 getSupportedThinkingLevels 换算，429 个模型）。
 * key = `<providerRouteId>/<modelId>`，value = 该模型支持的档位 id 列表（不翻译）。
 */
const CATALOG = THINKING_CATALOG as Readonly<Record<string, readonly string[]>>

/** 按 provider route id + 模型 id 查 catalog 档位。命中返回档位列表，未命中 undefined。 */
/** provider route id → catalog 文件名（不一致的归一；catalog 文件见 thinking-catalog.ts）。 */
const ROUTE_TO_CATALOG: Readonly<Record<string, string>> = {
  'deepseek-official': 'deepseek',
  'deepseek': 'deepseek',
  'moonshotai-cn': 'moonshotai-cn',
  'moonshotai': 'moonshotai',
  'kimi-coding': 'kimi-coding',
  'zai-coding-cn': 'zai-coding-cn',
  'zai': 'zai',
}

function catalogLevels(provider: string, modelId: string): readonly string[] | undefined {
  const route = ROUTE_TO_CATALOG[provider] ?? provider
  const key = `${route}/${modelId}`
  if (CATALOG[key] !== undefined) return CATALOG[key]
  // 兜底：同模型 id 在任一 catalog 文件命中（自定义 route 复用 catalog 模型时）。
  for (const [k, v] of Object.entries(CATALOG)) {
    if (k.endsWith(`/${modelId}`)) return v
  }
  return undefined
}

/** 从 provider 的 settings namespace 推协议族（仅用于决定读哪个默认档字段）。 */
export function familyOfNamespace(settingsNs: string): ThinkingFamily {
  if (settingsNs.includes('deepseek')) return 'deepseek'
  if (settingsNs.includes('pi-ai')) return 'pi-ai'
  return undefined
}

/** 单个模型的思考档位事实。 */
export interface ModelThinking {
  /** 该模型支持的档位 id 列表（不翻译，原始 id）。空 = 侦测不到。 */
  levels: readonly string[]
  /** 当前默认档（profile 配置值；'off' = 关闭）。 */
  current: string
  /** 是否侦测到了档位（false → 给自定义输入入口）。 */
  detected: boolean
}

/**
 * 读单个模型的思考档位。
 * @param schema - settings schema 操作。
 * @param namespace - provider 所在 namespace view。
 * @param settingsPath - provider profile 路径。
 * @param modelId - 模型 id。
 * @param family - 协议族（决定默认档字段名）。
 */
export function readModelThinking(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView,
  settingsPath: readonly string[],
  modelId: string,
  family: ThinkingFamily,
  provider: string,
): ModelThinking {
  const list = schema.getPath(namespace.value, [...settingsPath, 'models'])
  const raw = Array.isArray(list)
    ? list.find((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && m.id === modelId)
    : undefined
  // 当前默认档：deepseek 用 reasoningEffort，pi-ai 用 reasoning；未配置时默认 high（用户定）。
  const thinkKey = family === 'deepseek' ? 'reasoningEffort' : 'reasoning'
  const configured = raw !== undefined && typeof raw[thinkKey] === 'string' ? raw[thinkKey] as string : undefined
  const current = configured ?? DEFAULT_THINKING
  // ① 优先：profile 显式配置的 reasoningEfforts（用户/覆盖声明的档位）。
  const efforts = raw !== undefined ? raw.reasoningEfforts : undefined
  if (efforts === false) {
    // 显式剥离思考能力：只有 off（不受默认 high 影响）。
    return { levels: ['off'], current: 'off', detected: true }
  }
  if (typeof efforts === 'object' && efforts !== null && !Array.isArray(efforts)) {
    const keys = Object.keys(efforts as Record<string, unknown>)
    if (keys.length > 0) {
      const levels = ['off', ...keys.filter(k => k !== 'off')]
      return { levels: mergeCurrent(levels, current), current, detected: true }
    }
  }
  // ② 其次：catalog 表（单模型真实档位，与 host resolveModel 同源）。
  const fromCatalog = catalogLevels(provider, modelId)
  if (fromCatalog !== undefined && fromCatalog.length > 0) {
    return { levels: mergeCurrent([...fromCatalog], current), current, detected: true }
  }
  // ③ 兜底：侦测不到 → 固定档 valuelist（off/low/medium/high/xhigh/max）+ 自定义入口。
  return {
    levels: mergeCurrent([...FALLBACK_LEVELS], current),
    current,
    detected: false,
  }
}

/** 当前档位若不在档位集合里（手写覆盖的自定义档），并入以保证可选中。 */
function mergeCurrent(levels: readonly string[], current: string): readonly string[] {
  if (current === 'off' || levels.includes(current)) return levels
  return [...levels, current]
}

/**
 * 读该模型**已声明的档位集合**（profile 的 `reasoningEfforts` 键），供「自定义档位」
 * 多选控件回显初值。
 *
 * 与 {@link readModelThinking} 的关键区别：**不做 ① ② ③ 推理、不补 `off`**。
 * 多选控件要回答的是「用户显式勾了哪几个」，而 readModelThinking 的 levels 是
 * 「可用于下拉的候选集合」——它无条件给 dict 分支补上 `off`（`['off', ...keys]`），
 * 拿它当勾选初值会把模型本来没有的 `off` 悄悄写回盘（实测 `kimi-k3` 当前
 * `reasoningEfforts` 只有 low/high/max，经它一转就会多出 off）。
 *
 * @param schema - settings schema 操作。
 * @param namespace - provider 所在 namespace view。
 * @param settingsPath - provider profile 路径。
 * @param modelId - 模型 id。
 * @returns 已声明的档位 id（按 {@link KNOWN_LEVELS} 归一序）；未声明过时返回 `undefined`
 *   （调用方据此区分「用户没表达过」与「用户表达了空集」）。
 */
export function declaredLevelsOf(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView,
  settingsPath: readonly string[],
  modelId: string,
): readonly string[] | undefined {
  const list = schema.getPath(namespace.value, [...settingsPath, 'models'])
  const raw = Array.isArray(list)
    ? list.find((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && m.id === modelId)
    : undefined
  const efforts = raw?.reasoningEfforts
  // `false` = 显式声明「非推理模型」，与「没表达过」语义不同，由调用方分别处理。
  if (efforts === false) return ['off']
  if (typeof efforts !== 'object' || efforts === null || Array.isArray(efforts)) return undefined
  const keys = Object.keys(efforts as Record<string, unknown>)
  if (keys.length === 0) return undefined
  // 归一序（与 KNOWN_LEVELS 对齐），未知键（历史手写档）按原序追加在末尾。
  const known = KNOWN_LEVELS.filter(level => keys.includes(level))
  const extra = keys.filter(key => !KNOWN_LEVELS.includes(key))
  return [...known, ...extra]
}

/** 把档位 id 列表转下拉选项（不翻译，label = id）。 */
export function thinkingOptionsOf(levels: readonly string[]): SelectOption[] {
  return levels.map(id => ({ id, label: id }))
}

/** pi-ai schema 的 reasoningEfforts dict 形态（off 可 null，其余必须非空 wire 值）。 */
export type ReasoningEfforts = Record<string, string | null>

/**
 * 由侦测到的档位集合推 `reasoningEfforts` dict（方案 A：能力集合落盘）。
 * 映射（用户定）：off → null，其余 → 档位 id 本身；用户已配置的 wire 值保留。
 * 返回 undefined = 不该写（无档位）；调用方决定写/删。
 */
export function reasoningEffortsOf(
  levels: readonly (string | boolean | undefined)[],
  existing: unknown,
): ReasoningEfforts | undefined {
  if (levels.length === 0) return undefined
  const prev: Record<string, unknown> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {}
  const dict: ReasoningEfforts = {}
  for (const rawLevel of levels) {
    // 运行时防御（2026-09-15 真实事故）：档位 id 类型上声明为 string，但**布尔 false 会被
    // JS 悄悄当成字典键 `"false"`** ⇒ 落盘成 YAML 的 `false:`（**布尔键**）⇒ pi-ai 段校验
    // 失败 ⇒ 整个 settings 段注册不上，UI 只报「namespace not registered」（不指向该键）。
    // 语义上布尔 false 就是「关闭推理」= `off`，故**归一化**而不是丢弃。
    const level = typeof rawLevel === 'string' ? rawLevel : rawLevel === false ? 'off' : undefined
    if (level === undefined || level === '') continue
    if (level === 'off') { dict.off = null; continue }
    const wire = prev[level]
    dict[level] = typeof wire === 'string' && wire !== '' ? wire : level
  }
  // pi-ai 校验：dict 必须至少有一个非 off 档（否则应写 false / 省略字段）。
  return Object.keys(dict).some(k => k !== 'off') ? dict : undefined
}

/**
 * 按 provider route id 列出 catalog 表里的全部模型 id（官方目录路由的「可用模型」，
 * discoverModels 不注册网络发现时由此提供）。
 */
export function catalogModelIdsOf(provider: string): readonly string[] {
  const route = ROUTE_TO_CATALOG[provider] ?? provider
  const prefix = `${route}/`
  const ids: string[] = []
  for (const key of Object.keys(CATALOG)) {
    if (key.startsWith(prefix)) ids.push(key.slice(prefix.length))
  }
  return ids
}

/** 落盘结果：档位集合（dict / false）+ 归一门控后的默认档。 */
export interface PiAiThinkingWrite {
  /**
   * `reasoningEfforts` 的值：
   *   - 对象 dict = 该模型的档位集合（≥1 个非 off 档）；
   *   - `false` = 显式声明「该模型不做推理」——这是 pi-ai 记录的**非推理模型**编码
   *     （`false` 会剥掉 catalog 模型自带的推理能力；而**删键**在 catalog 路由上
   *     语义是「继承内置目录的能力」，会把推理能力放回来，故二者不可互换）。
   */
  efforts: ReasoningEfforts | false
  /** 归一后的默认档（`reasoning`）；'' = 不写该键。 */
  defaultLevel: string
}

/**
 * 把「用户勾选的档位集合 + 默认档」归一成可落盘的 pi-ai 字段。
 *
 * 这是「自定义档位」功能的核心不变式所在，抽成纯函数以便单测钉住（2026-09-29
 * 用户定调：pi-ai 内置表只作预勾选**建议**，档位集合以用户勾选为准）。
 *
 * 两条不变式（每条都对应一个实测会炸的形态）：
 *   ① **键域**：只保留 {@link KNOWN_LEVELS} 内的档位——pi-ai 的 `reasoningEfforts`
 *      键被 `z.union(THINKING_LEVELS)` 校验，一个非法键会让**整个 settings 段注册
 *      失败**，UI 只报「namespace not registered」而不指向那个键（2026-09-15 事故）。
 *   ② **没有非 off 档 ⇒ 写 `false`**：pi-ai 拒绝只有 off 的 dict，而删键在 catalog
 *      路由上语义是「继承内置目录能力」（会把推理放回来），故正确编码是 `false`。
 *
 * @param levels - 用户勾选的档位 id（可含历史非法 id，会被剔除；布尔 `false` 归一为 `off`）。
 * @param defaultLevel - 用户选的默认档。
 * @returns 归一后的 `reasoningEfforts`（dict 或 `false`）与默认档。
 */
export function piAiThinkingWrite(
  levels: readonly (string | boolean | undefined)[],
  defaultLevel: string,
): PiAiThinkingWrite {
  // 先做与 reasoningEffortsOf 同源的档位归一（布尔 false 语义上是「关闭推理」= off，
  // **归一化而非丢弃**——见其内注释记录的 2026-09-15 事故），再按键域过滤。
  // 顺序要紧：先过滤会把布尔 false 直接丢掉，等于悄悄少一个档。
  const normalized = levels
    .map(raw => typeof raw === 'string' ? raw : raw === false ? 'off' : undefined)
    .filter((level): level is string => level !== undefined && level !== '')
  const selected = KNOWN_LEVELS.filter(level => normalized.includes(level))
  // wire 值 = 档位 id 本身（pi-ai 默认行为；用户不需要自定义映射）。
  const efforts = reasoningEffortsOf(selected, undefined)
  // 没有非 off 档 ⇒ 显式写 `false`（pi-ai 的「非推理模型」编码）。
  if (efforts === undefined) return { efforts: false, defaultLevel: '' }
  const defaultGated = selected.includes(defaultLevel)
    ? defaultLevel
    : selected.find(level => level !== 'off') ?? ''
  return {
    efforts,
    // 'off' 作为默认档 = 不写 `reasoning`（不指定 provider 默认档），与既有语义一致。
    defaultLevel: defaultGated === 'off' ? '' : defaultGated,
  }
}

/**
 * 把「该模型的默认档」映射成**路由级** `providers.<route>.reasoning` 的写入 op。
 *
 * 为什么必须有这一层（issue #236 第二条，2026-11-22 实机取证）：
 * 官方 `dsh-llm-pi-ai` 的 `modelInfo()` 写的是
 * `describableReasoningLevel(resolvedModel, profile.reasoning)` —— 读 **profile
 * （路由）那一层**，不是模型条目里的 `reasoning`。而 `session/modelCatalog` 的
 * `reasoning.defaultEffort` 就出自 `modelInfo()`。所以：
 *
 *   - 只写模型级 `reasoning` ⇒ 配置页能回显（`readModel` 读得到），但 catalog
 *     给不出 `defaultEffort` ⇒ 新建任务表单、Agent 预设、composer 的模型菜单
 *     全都只显示「default」，用户设的默认档哪都不生效。
 *   - 写路由级 `reasoning` ⇒ `defaultEffort` 有了，各处选择器自动显示该档位。
 *
 * 语义边界（避免过度归因）：路由级是**兜底**，不是强制。真正决定每轮请求档位的
 * 仍是会话自己的 `reasoningEffort`（pi-ai `options.reasoningEffort ?? profile.reasoning`），
 * 用户在选择器里显式换档依然优先。
 *
 * 取 `unset` 的三个理由（任一成立都不能写死一个档）：
 *   ① `defaultLevel` 为 ''（默认档是 off / 无可选档）——写任何档都等于替用户选中；
 *   ② 该档不在 `reasoningEfforts` 的键域内——pi-ai 会拒绝，且路由级字段校验更严；
 *   ③ `efforts === false`（显式「非推理模型」）——此时给路由挂档位自相矛盾。
 *
 * @param written - {@link piAiThinkingWrite} 的归一结果。
 * @param routePath - 该 provider 的 settingsPath（如 `['providers','localhost']`）。
 * @returns 一个 set 或 unset op（形状照官方 `SettingsPathOpView`）。
 */
export function routeReasoningOp(
  written: PiAiThinkingWrite,
  routePath: readonly string[],
): { op: 'set'; path: string[]; value: string } | { op: 'unset'; path: string[] } {
  const path = [...routePath, 'reasoning']
  const level = written.defaultLevel
  if (written.efforts === false || level === '') return { op: 'unset', path }
  if (!KNOWN_LEVELS.includes(level)) return { op: 'unset', path }
  return { op: 'set', path, value: level }
}
