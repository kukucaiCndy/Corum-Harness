/**
 * SettingsAgentSettingsSection — 智能体设置分区（PRD v2 §4.1）。
 *
 * ## 本分区是 M2 重构的核心
 *
 * 原有两个分区**合并**为本分区：
 * - `agent-loop`（「高级 Agent Loop」）—— 改名并扩容
 * - `subagent`（「子 Agent」）—— **并入**（用户 2026-09-16 第二批裁定：
 *   「子 Agent 并入智能体设置」）
 *
 * ⇒ 导航由 24 项收敛为 **23 项**（`nav-子 Agent` 不再单独存在）。
 *
 * ## 本轮同时移除的两个问题项
 *
 * 1. **「系统提示词前缀」（原 AS13）已删除** —— 用户裁定 `B4`
 *    「移除智能体设置的系统提示词前缀功能」+ `C1`「我的设计理念就是
 *    **以 Agent 为单位进行管控**，否则用户错误设置只符合特定场景的提示词，
 *    **会造成污染**」⇒ 全局提示词注入**不提供用户可写出口**，
 *    提示词/人格一律走 **Agent 预设**（§4.16）。⚠️ 不要恢复。
 * 2. **原「重试次数」「重试间隔」已删除** —— 这两项在 PRD §4.1 中**不存在**
 *    任何真源，属自造项；且原「最大并发数」默认值显示 `3`，
 *    与真源 `agent-loop.maxParallelToolCalls` 的默认值 **10** 不符
 *    （PRD §4.1.1：该键默认 10）—— 显示值本身就是错的。
 *
 * ## 真源（三个 settings namespace，字面量均自源码核实，非猜测）
 *
 * | 条目 | namespace | 字段 |
 * |---|---|---|
 * | AS2a 主 Agent 默认模型 | `agent-default-model` | `provider` / `model` / `reasoningEffort` |
 * | AS1 最大并行工具调用 | `agent-loop` | `maxParallelToolCalls` |
 * | AS15 默认 Agent 预设 | `agent-presets` | `default` |
 * | AS2b/AS2c/AS16~AS20 子 Agent | `corum-subagent` | 见下 |
 *
 * @module corum-ide-ui/client/settings/sections/SettingsAgentSettingsSection
 */

import { useEffect, useState } from 'react'
import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { Badge } from '../Badge.tsx'
import { useCorumRpc, useCorumSettings } from '../shared.tsx'
import { ReviewRetentionGroup, AgentStallGroup } from './general-groups.tsx'
import css from '../SettingsSections.module.css'

/* ── 智能体设置（PRD §4.1）──────────────────────────────────────────── */

/** corum 子 Agent 全局配置（三级配置第一级）。 */
const SUBAGENT_NS = 'corum-subagent'
/** 官方：单步内并行安全工具调用上限。 */
const AGENT_LOOP_NS = 'agent-loop'
/** 官方：无会话级选择时的默认模型（`AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE`）。 */
const DEFAULT_MODEL_NS = 'agent-default-model'
/** 官方：默认挂载的 Agent 预设（`SETTINGS_NAMESPACE`）。 */
const PRESETS_NS = 'agent-presets'

/** corum-subagent 全局设置的用户层形（describe 镜像的 value/user 投影）。 */
interface SubagentGlobalView {
  maxParallelChildren?: number
  defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  defaultResearchModel?: { provider: string; model: string; reasoningEffort?: string }
}

/** agent-loop 的用户层形。 */
interface AgentLoopView {
  maxParallelToolCalls?: number
}

/** agent-default-model 的形。 */
interface DefaultModelView {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** agent-presets 的形。 */
interface PresetsView {
  default?: string
}

/** 模型三元组（provider/model 两列；空 = 未设置跟随兜底）。 */
type ModelTriple = { provider: string; model: string; reasoningEffort?: string }

/** 下拉选项形（与 SelectField 的 options 对齐）。 */
interface ModelOption { id: string; label: string }

/** 某条路由（`provider/model`）的推理元数据（`session/modelCatalog` 投影）。 */
interface ReasoningMeta {
  efforts: { id: string; name: string; description?: string }[]
  defaultEffort?: string
}

/**
 * 模型目录形（provider 列表 + 按 provider 索引的模型列表 + 按路由索引的推理元数据）。
 *
 * `reasoningByRoute` 的 key 为 `${provider}/${model}`；无推理元数据的路由**没有键**
 * ⇒「思考等级」列按路由有无元数据决定是否显示（无 = 保持两列）。
 */
interface ModelCatalog {
  providers: ModelOption[]
  modelsByProvider: Record<string, ModelOption[]>
  reasoningByRoute: Record<string, ReasoningMeta>
}

/**
 * `session/modelCatalog` 的返回投影（只声明本页消费到的字段）。
 *
 * ⚠️ 这是**带推理元数据**的目录源（渲染层范例：corum-ui-conversation
 * `apply.ts` 的 `listModelCatalog`）；`corumAgent/listModels` 的投影只有
 * `{id, name}`，**不含** reasoning ⇒ 无法支撑「思考等级」列。
 */
interface SessionCatalogModel {
  id: string
  name?: string
  reasoning?: {
    efforts?: { id: string; name: string; description?: string }[]
    defaultEffort?: string
  }
}
interface SessionCatalogGroup { id: string; name?: string; models?: SessionCatalogModel[] }
interface SessionCatalogResult { groups?: SessionCatalogGroup[] }

/**
 * 模型下拉兜底目录（`session/modelCatalog` 调用失败/为空时；与 Agent 预设编辑页
 * `SettingsAgentPresetsSection.tsx` 的兜底目录一致）。
 *
 * ⚠️ 兜底目录**没有**推理元数据 ⇒ 此时「思考等级」列整体隐藏（保持两列形态）。
 */
const FALLBACK_PROVIDERS: ModelOption[] = [
  { id: 'deepseek-official', label: 'deepseek-official' },
  { id: 'pi-ai', label: 'pi-ai' },
]
const FALLBACK_MODELS: ModelOption[] = [
  { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
  { id: 'deepseek-v4', label: 'deepseek-v4' },
  { id: 'deepseek-r1', label: 'deepseek-r1' },
]

/** 「未设置」占位项：id='' 表示该档未配置（跟随兜底/主 Agent）。 */
const UNSET_OPTION: ModelOption = { id: '', label: '未设置' }

/** 已保存值不在目录中时并入临时选项（label 用原值），避免下拉显示空白。 */
function ensureOption(list: ModelOption[], id: string | undefined): ModelOption[] {
  if (id === undefined || id === '' || list.some(o => o.id === id)) return list
  return [...list, { id, label: id }]
}

/**
 * 三级配置第一级：本页全局默认 → Agent 预设可逐键覆盖 → 未覆盖回落本页。
 *
 * 用户 `#3` 裁定的覆盖链：**预设（按角色覆盖） ＞ 本页全局 ＞ 跟随主 Agent**。
 *
 * @returns the merged agent settings section.
 */
export function AgentSettingsSection() {
  const settings = useCorumSettings()
  const rpc = useCorumRpc()
  const [, force] = useState(0)
  // describe 镜像订阅（uSES 源；snapshot 变更即重渲染）。
  useEffect(() => {
    if (settings === null) return undefined
    void settings.describe.ensure()
    return settings.describe.subscribe(() => { force(v => v + 1) })
  }, [settings])

  // 模型目录（本页拉一次，三个 ModelPairField 共用；失败静默用兜底目录，页面不白屏）。
  const [catalog, setCatalog] = useState<ModelCatalog>({ providers: FALLBACK_PROVIDERS, modelsByProvider: {}, reasoningByRoute: {} })
  useEffect(() => {
    if (rpc === null) return undefined
    let cancelled = false
    void (async () => {
      try {
        // 目录源 = `session/modelCatalog`（与 composer 模型选择器同源，**带推理
        // 元数据**）。`useCorumRpc` 就是 makeCorumRpcCall(connection)，与
        // corum-ui-conversation 的 `connection.rpc.call('/api', 'session/modelCatalog',
        // { args: {} })` 是**同通道同契约**，故直接经 rpc 调，不新造 IPC。
        const r = await rpc<SessionCatalogResult>('session', 'modelCatalog', {})
        const groups = r.groups ?? []
        if (cancelled || groups.length === 0) return
        const providers: ModelOption[] = []
        const modelsByProvider: Record<string, ModelOption[]> = {}
        const reasoningByRoute: Record<string, ReasoningMeta> = {}
        for (const g of groups) {
          const label = g.name !== undefined && g.name !== '' ? g.name : g.id
          providers.push({ id: g.id, label })
          const models: ModelOption[] = []
          for (const m of g.models ?? []) {
            const mLabel = m.name !== undefined && m.name !== '' ? m.name : m.id
            models.push({ id: m.id, label: mLabel })
            if (m.reasoning === undefined) continue
            // exactOptionalPropertyTypes：可选属性不能显式传 undefined，故条件展开。
            reasoningByRoute[`${g.id}/${m.id}`] = {
              efforts: (m.reasoning.efforts ?? []).map(e => ({
                id: e.id,
                name: e.name,
                ...(e.description === undefined ? {} : { description: e.description }),
              })),
              ...(m.reasoning.defaultEffort === undefined ? {} : { defaultEffort: m.reasoning.defaultEffort }),
            }
          }
          modelsByProvider[g.id] = models
        }
        setCatalog({ providers, modelsByProvider, reasoningByRoute })
      } catch {
        // 静默：RPC 失败/为空时保留兜底目录（reasoningByRoute 为空对象 =
        // 不显示「思考等级」列），不阻断设置页。
      }
    })()
    return () => { cancelled = true }
  }, [rpc])

  // 在册 Agent 列表（corumAgent/listProfiles）——用于「默认 Agent 预设」下拉。
  // rpc === null 时跳过；失败静默留空数组，页面不白屏。
  const [agentOptions, setAgentOptions] = useState<ModelOption[]>([])
  useEffect(() => {
    if (rpc === null) return undefined
    let cancelled = false
    void (async () => {
      try {
        const r = await rpc<{ profiles: Array<{ id: string; nickname?: string; source?: string }> }>('corumAgent', 'listProfiles', {})
        if (cancelled) return
        // 官方基础模式不可作为默认预设（设置页定调：官方模式是继承模板，不可直接选中）。
        // 用 !== 'official' 而非 === 'corum'：防御未来 source 维度扩展时 corum 侧新值不被误滤。
        setAgentOptions((r.profiles ?? [])
          .filter(p => p.source !== 'official')
          .map(p => ({ id: p.id, label: p.nickname ?? p.id })))
      } catch {
        // 静默：RPC 失败时留空数组，下拉仅显示「未设置」+ 已保存值（ensureOption 补位）。
      }
    })()
    return () => { cancelled = true }
  }, [rpc])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (settings === null) return <p className={css.hintText}>settings 服务未就绪。</p>
  const snapshot = settings.describe.getSnapshot()
  const namespaces = snapshot.view?.namespaces ?? []
  const writable = snapshot.view?.writable === true
  const loading = snapshot.status === 'loading' || snapshot.status === 'idle'

  /** 取某 namespace 的镜像条目（value=合成后值，user=用户层，revision 防并发）。 */
  const entryOf = (ns: string) => namespaces.find(n => n.ns === ns)

  const subEntry = entryOf(SUBAGENT_NS)
  const subResolved = (subEntry?.value ?? {}) as SubagentGlobalView
  const subUser = (subEntry?.user ?? {}) as SubagentGlobalView

  const loopResolved = (entryOf(AGENT_LOOP_NS)?.value ?? {}) as AgentLoopView
  const loopUser = (entryOf(AGENT_LOOP_NS)?.user ?? {}) as AgentLoopView

  const modelResolved = (entryOf(DEFAULT_MODEL_NS)?.value ?? {}) as DefaultModelView
  const modelUser = (entryOf(DEFAULT_MODEL_NS)?.user ?? {}) as DefaultModelView

  const presetsUser = (entryOf(PRESETS_NS)?.user ?? {}) as PresetsView

  /**
   * 单键写入（`unset` 清除回落默认；revision 防并发覆盖）。
   *
   * @param ns - 目标 settings namespace。
   * @param field - 字段名（顶层键）。
   * @param value - 新值；`undefined` 表示清除该键。
   */
  const apply = async (ns: string, field: string, value: unknown): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const ops = value === undefined
        ? [{ op: 'unset' as const, path: [field] }]
        : [{ op: 'set' as const, path: [field], value }]
      const res = await settings.mutate(ns, ops, entryOf(ns)?.revision)
      if (!res.ok) setError(res.error?.message ?? '写入失败')
      else if (res.value !== undefined) settings.describe.acceptView(res.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 三键同时写入（模型三元组：provider + model 必须成对，reasoningEffort 可选）。
   *
   * 语义：
   * - provider/model 任一为 `undefined`（含未设置）→ **三键全 unset**（成对语义）；
   * - 两者都有 → 写 provider/model；reasoningEffort 为 `undefined` 时**unset**该键
   *   （不写显式 undefined，exactOptionalPropertyTypes 合规）。
   *
   * @param ns - 目标 settings namespace。
   * @param pk - provider 字段名。
   * @param mv - model 字段名。
   * @param v - 三元组；`undefined` = 全 unset。
   * @param rk - reasoningEffort 字段名。
   */
  const applyTriple = async (
    ns: string,
    pk: string,
    mv: string,
    v: ModelTriple | undefined,
    rk: string,
  ): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const paired = v !== undefined && v.provider !== '' && v.model !== ''
      const ops = !paired
        ? [
            { op: 'unset' as const, path: [pk] },
            { op: 'unset' as const, path: [mv] },
            { op: 'unset' as const, path: [rk] },
          ]
        : [
            { op: 'set' as const, path: [pk], value: v.provider },
            { op: 'set' as const, path: [mv], value: v.model },
            ...(v.reasoningEffort === undefined
              ? [{ op: 'unset' as const, path: [rk] }]
              : [{ op: 'set' as const, path: [rk], value: v.reasoningEffort }]),
          ]
      const res = await settings.mutate(ns, ops, entryOf(ns)?.revision)
      if (!res.ok) setError(res.error?.message ?? '写入失败')
      else if (res.value !== undefined) settings.describe.acceptView(res.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 供应商单独变更（部分写入）：只写 provider、清 model + reasoningEffort。
   *
   * 背景：schema 里 `defaultModel` 是**一个 object 字段**（provider/model/reasoningEffort
   * 是同一字段的子键），`applyTriple` 走字段级 unset 会连 provider 一起清掉，导致
   * 「选完供应商被回弹未设置」。这里直接写**字段整体**为新三元组：
   * - `p === ''` → 整字段 unset（回到未设置）；
   * - 否则写 `{ provider: p }`（无 model/effort 键 = 模型待选，host schema 允许部分对象）。
   *
   * @param ns - 目标 settings namespace。
   * @param field - 顶层字段名（defaultModel / defaultResearchModel）。
   * @param p - 供应商 id；'' = 未设置。
   */
  const applyProviderOnly = async (ns: string, field: string, p: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const ops = p === ''
        ? [{ op: 'unset' as const, path: [field] }]
        : [{ op: 'set' as const, path: [field], value: { provider: p } }]
      const res = await settings.mutate(ns, ops, entryOf(ns)?.revision)
      if (!res.ok) setError(res.error?.message ?? '写入失败')
      else if (res.value !== undefined) settings.describe.acceptView(res.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const disabled = !writable || busy || loading

  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>
          智能体的全局默认配置。**Agent 预设可逐键覆盖本页**；子 Agent 的模型路由**三档**
          （预设里配的模型 ＞ 本页的子 Agent 默认模型 ＞ 跟随主 Agent）—— 本页两个「子 Agent
          默认模型」既是**新建预设时的模板值**，也是**预设没配该角色时的运行期兜底**。
          只有连本页也没配时，子 Agent 才跟随主 Agent。提示词与人格一律走 Agent 预设 ——
          本页刻意不提供全局提示词入口。
        </span>
      </div>
      {error !== null && <p className={css.hintText} style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p>}

      <SettingGroup title="默认模型">
        <SettingRow label="主 Agent 默认模型" desc={`没有会话级选择时的默认模型（必填）。当前：${modelResolved.provider ?? '未设置'} / ${modelResolved.model ?? '未设置'}`}>
          <ModelPairField
            value={modelUser.provider !== undefined && modelUser.model !== undefined
              ? {
                  provider: modelUser.provider,
                  model: modelUser.model,
                  // exactOptionalPropertyTypes：可选属性不能显式传 undefined，故条件展开。
                  ...(modelUser.reasoningEffort === undefined ? {} : { reasoningEffort: modelUser.reasoningEffort }),
                }
              : undefined}
            catalog={catalog}
            disabled={disabled}
            onChange={v => {
              void applyTriple(DEFAULT_MODEL_NS, 'provider', 'model', v, 'reasoningEffort')
            }}
          />
        </SettingRow>
        {/* ⚠️ 2026-10-11 用户澄清（**推翻** 2026-09-18 的「始终两档」）：这一项**既是**
            新建预设的模板，**也是**运行期兜底档。旧文案（2026-09-18 版）刻意写成「只是
            模板、不是运行期兜底」，正是本轮要改掉的说法。
            新语义（三档）：预设里配的模型 ＞ 本项 ＞ 跟随主 Agent。 */}
        <SettingRow label="worker 子 Agent 默认模型" desc="新建预设时的默认值（新建的 Agent 预设会预填这个模型），同时是**运行期兜底**：预设里没配 worker 子 Agent 模型时，就用这个。留空 = 该档不存在，子 Agent 跟随主 Agent。">
          <ModelPairField
            value={subUser.defaultModel}
            catalog={catalog}
            disabled={disabled}
            onChange={v => { void apply(SUBAGENT_NS, 'defaultModel', v) }}
            onProviderChange={p => { void applyProviderOnly(SUBAGENT_NS, 'defaultModel', p) }}
            onModelChange={(p, m, effort) => {
              // provider 以镜像最新值兜底（覆盖「刚选完供应商未回读即选模型」的竞态窗口）。
              const latest = (entryOf(SUBAGENT_NS)?.user as SubagentGlobalView | undefined)?.defaultModel?.provider ?? p
              if (m === '') { void applyProviderOnly(SUBAGENT_NS, 'defaultModel', latest); return }
              void apply(SUBAGENT_NS, 'defaultModel', { provider: latest, model: m, ...(effort === '' ? {} : { reasoningEffort: effort }) })
            }}
          />
        </SettingRow>
        <SettingRow label="research 子 Agent 默认模型" desc="同上，面向只读研究子 Agent：新建预设的模板值，同时是运行期兜底。留空 = 该档不存在，落到跟随主 Agent（**不**回落到上面的 worker 项——那是预设侧的「同 worker」语义）。" divider={false}>
          <ModelPairField
            value={subUser.defaultResearchModel}
            catalog={catalog}
            disabled={disabled}
            onChange={v => { void apply(SUBAGENT_NS, 'defaultResearchModel', v) }}
            onProviderChange={p => { void applyProviderOnly(SUBAGENT_NS, 'defaultResearchModel', p) }}
            onModelChange={(p, m, effort) => {
              const latest = (entryOf(SUBAGENT_NS)?.user as SubagentGlobalView | undefined)?.defaultResearchModel?.provider ?? p
              if (m === '') { void applyProviderOnly(SUBAGENT_NS, 'defaultResearchModel', latest); return }
              void apply(SUBAGENT_NS, 'defaultResearchModel', { provider: latest, model: m, ...(effort === '' ? {} : { reasoningEffort: effort }) })
            }}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="运行">
        <SettingRow label="最大并行工具调用" desc={`单步内同时执行的安全工具数上限（真源默认 ${loopResolved.maxParallelToolCalls ?? 10}）。`}>
          <input
            className={css.textInput}
            defaultValue={loopUser.maxParallelToolCalls !== undefined ? String(loopUser.maxParallelToolCalls) : ''}
            placeholder={String(loopResolved.maxParallelToolCalls ?? 10)}
            disabled={disabled}
            onBlur={e => {
              const raw = e.target.value.trim()
              const n = Number.parseInt(raw, 10)
              void apply(AGENT_LOOP_NS, 'maxParallelToolCalls', raw === '' ? undefined : (Number.isInteger(n) && n > 0 ? n : undefined))
            }}
          />
        </SettingRow>
        <SettingRow label="并行子 Agent 上限" desc="会话级并行召唤数上限（超出拒绝新召唤）。">
          <input
            className={css.textInput}
            defaultValue={subUser.maxParallelChildren !== undefined ? String(subUser.maxParallelChildren) : ''}
            placeholder={String(subResolved.maxParallelChildren ?? 4)}
            disabled={disabled}
            onBlur={e => {
              const raw = e.target.value.trim()
              const n = Number.parseInt(raw, 10)
              void apply(SUBAGENT_NS, 'maxParallelChildren', raw === '' ? undefined : (Number.isInteger(n) && n > 0 ? n : undefined))
            }}
          />
        </SettingRow>
        <SettingRow
          label="单轮工具调用次数上限"
          desc="每轮工具调用总数上限。⚠️ 官方内核**不存在该字段**，需先在 corum 侧新增调度层。"
          badge={<Badge label="未上线" variant="offline" />}
          divider={false}
        >
          <SelectField value="none" options={[{ id: 'none', label: '未上线' }]} onChange={() => { /* 未上线，已禁用 */ }} disabled />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Agent 预设">
        <SettingRow label="默认 Agent 预设" desc="新建任务/会话默认挂载的 Agent 预设（`agent-presets.default`）。改动对**之后新建**的会话生效，已运行的会话不受影响。" divider={false}>
          <SelectField
            value={presetsUser.default ?? ''}
            options={[{ id: '', label: '未设置（机制内置默认）' }, ...ensureOption(agentOptions, presetsUser.default)]}
            onChange={id => { void apply(PRESETS_NS, 'default', id === '' ? undefined : id) }}
            disabled={disabled}
            variant="fill"
          />
        </SettingRow>
      </SettingGroup>

      {/* 自原「通用」页迁入（2026-09-16 重组：通用页拆散，Agent 语义项归智能体）。
          改动审查保留 + Agent 执行阈值——它们是 Agent 行为/留痕，不属于应用级通用。 */}
      <ReviewRetentionGroup />
      <AgentStallGroup />
    </>
  )
}

/**
 * 模型三元组字段（provider / model / 思考等级三列下拉；空 = 未设置跟随兜底）。
 *
 * ⚠️ provider 与 model 必须**成对**写入 —— `agent-default-model` 的 schema
 * 把两者都标为 `.required()`，只写一半会留下不合法的半成品。`reasoningEffort`
 * 在三个真源 schema 里都是**可选**键（`.default(undefined)`）⇒ 单独可 unset。
 *
 * 成对语义（纯受控，选择即生效，不再依赖 onBlur）：
 * - provider/model 都已选具体值 → `onChange({ provider, model[, reasoningEffort] })`；
 * - 任一选回「未设置」占位（id=''）→ `onChange(undefined)`（三键全 unset）。
 *
 * 思考等级列（**条件列**）：
 * - 仅当当前 `provider/model` 在 `catalog.reasoningByRoute` 里有推理元数据时渲染；
 *   无元数据（含 RPC 失败/兜底目录）时该列整体隐藏，保持两列。
 * - 置项为「默认档」（id=''）→ 提交**不带** reasoningEffort 键（unset，跟随模型默认档）。
 * - provider 或 model 任一变更 → 档位重置为 ''（跟随**新模型**的默认档，不保留旧档）。
 *
 * provider 变更联动刷新 model 选项（按所选 provider 取目录）；若原 model
 * 不在新 provider 的目录里则重置为「未设置」。
 *
 * @param props - value / catalog / disabled / onChange。
 * @returns the model triple select.
 */
function ModelPairField({ value, catalog, disabled, onChange, onProviderChange, onModelChange }: {
  value: ModelTriple | undefined
  /** 完整模型目录（providers + modelsByProvider + reasoningByRoute；顶层 effect 拉取，RPC 失败时为兜底目录）。 */
  catalog: ModelCatalog
  disabled: boolean
  onChange: (v: ModelTriple | undefined) => void
  /** 供应商单独变更（部分写入：写 provider、清 model/effort）；缺省退回整三元组 onChange。 */
  onProviderChange?: (providerId: string) => void
  /** 模型/档位变更（字段整体写入，providerId 显式传入，避免读派生 value 的竞态）。 */
  onModelChange?: (providerId: string, modelId: string, effort: string) => void
}) {
  // 纯受控：选中值直接来自 props（'' = 「未设置」占位），无本地镜像 state。
  const provider = value?.provider ?? ''
  const model = value?.model ?? ''
  // 推理元数据按路由（`${provider}/${model}`）取：无元数据 ⇒ 不渲染思考等级列。
  const reasoning = provider !== '' && model !== '' ? catalog.reasoningByRoute[`${provider}/${model}`] : undefined
  // 选项派生：占位（未设置）置顶；provider 目录缺该 provider 时用兜底目录补位；
  // 已保存值不在目录里时并入临时项（label 用原值），避免下拉显示空白。
  const providerOptions = ensureOption(
    catalog.providers.length > 0 ? catalog.providers : FALLBACK_PROVIDERS,
    provider,
  )
  const modelOptions = ensureOption(
    (provider !== '' && catalog.modelsByProvider[provider] !== undefined)
      ? catalog.modelsByProvider[provider]
      : FALLBACK_MODELS,
    model,
  )
  /**
   * 三元组提交：provider/model 都选了具体值才写；任一为占位则整体 unset。
   *
   * `effort === ''`（默认档）⇒ 不展开 `reasoningEffort` 键（exactOptionalPropertyTypes
   * 合规：可选属性不能显式传 undefined，unset 由写入层的条件展开负责）。
   */
  const commit = (p: string, m: string, effort: string): void => {
    onChange(
      p !== '' && m !== ''
        ? { provider: p, model: m, ...(effort === '' ? {} : { reasoningEffort: effort }) }
        : undefined,
    )
  }
  /** 档位选项：默认档置顶（label 标注落在哪个默认值），其后是目录中的各档。 */
  const effortOptions: ModelOption[] = reasoning === undefined ? [] : [
    { id: '', label: `默认档（${reasoning.defaultEffort ?? 'provider 默认'}）` },
    ...reasoning.efforts.map(e => ({ id: e.id, label: e.name })),
  ]
  return (
    <div className={`${css.selectStack} ${css.selectStackControl}`}>
      <SelectField
        value={provider}
        options={[UNSET_OPTION, ...providerOptions]}
        onChange={id => {
          if (onProviderChange !== undefined) {
            // 供应商单独变更（部分写入）：保留 provider、清 model/effort。
            // 避免 commit(id,'','') → 整三元组 unset → 供应商被回弹「未设置」。
            onProviderChange(id)
            return
          }
          // 联动：provider 变更后原 model 不在新 provider 的目录里则重置为「未设置」。
          // 档位一律重置为默认档（跟随新模型的默认档，不保留旧档）。
          const nextModels = id === '' ? undefined : catalog.modelsByProvider[id]
          const keep = nextModels !== undefined && model !== '' && nextModels.some(o => o.id === model)
          commit(id, keep ? model : '', '')
        }}
        disabled={disabled}
        variant="fill"
      />
      <SelectField
        value={model}
        options={[UNSET_OPTION, ...modelOptions]}
        // model 变更同样重置档位（新模型未必支持旧档）。
        // providerId 显式用当前值（若父层接管则用最新 provider，避免派生 value 的写入竞态）。
        onChange={id => {
          if (onModelChange !== undefined) { onModelChange(provider, id, ''); return }
          commit(provider, id, '')
        }}
        disabled={disabled}
        variant="fill"
      />
      {reasoning !== undefined && (
        <SelectField
          value={value?.reasoningEffort ?? ''}
          options={effortOptions}
          onChange={id => {
            if (onModelChange !== undefined) { onModelChange(provider, model, id); return }
            commit(provider, model, id)
          }}
          disabled={disabled}
          variant="fill"
        />
      )}
    </div>
  )
}
