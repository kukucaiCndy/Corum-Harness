/**
 * SettingsAgentPresetsSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { Box, Brain, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Cpu, Database, Ghost, Globe, Info, Languages, Layers, Lock, Maximize2, Minimize2, Minus, Package, Plus, Search, Server, Smile, Sparkles, Star, Trash2, Upload, X } from 'lucide-react'
import { SelectField } from '../SelectField.tsx'
import { Switch } from '../Switch.tsx'
import { ConfirmDialog } from '../ConfirmDialog.tsx'
import { GlassButton, useCorumRpc, useCorumSettings, useSectionNav } from '../shared.tsx'
import type { CorumSettingsFace } from '../shared.tsx'
import { useDeveloperMode } from '../developer-mode.ts'
import type { SkillInfo, SkillVersion, SkillBinding, ProfileSummary, McpServerSummaryWire, ModuleSource } from '../types.ts'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import css from '../SettingsSections.module.css'
import { ImportModuleWizard } from './ImportModuleWizard.tsx'
import { PublishModuleDialog } from './PublishModuleDialog.tsx'

/**
 * 「AI 润色」按钮的共享实现（设置页三处：人格 / 提示词 / 提示词放大态）。
 *
 * 为什么需要它：这三处此前是 `<button disabled title="即将上线">` 占位——违反已记录的
 * 设计红线（`.dbg/agent-presets-final-design.md` §三：「AI 润色要么做真的、要么隐藏，
 * 不留 disabled 占位」；`.dbg/agent-presets-pm-review.md` §四点名这是产品大忌：既暗示
 * 存在又宣告不可用）。宿主端润色能力（`corumAgent.polishConversation`）早已实现并被
 * composer 的 sparkle 按钮真实使用，故这里接真实现而不是删按钮。
 *
 * 与 composer 的差异：composer 带对话历史（润色提问）；设置页润色的是**Agent 定义文本**
 * （人格/提示词），无对话上下文，故 `history` 传空数组——宿主按「无历史」分支处理。
 * @param rpc - corum RPC 调用面（null 时按钮禁用）。
 * @returns 润色动作、进行中标志与最后一次错误。
 */
function usePolishSetting(rpc: CorumRpcCall | null): {
  polish: (text: string) => Promise<string | null>
  polishing: boolean
  error: string | null
} {
  const [polishing, setPolishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const polish = async (text: string): Promise<string | null> => {
    if (rpc === null || polishing || text.trim() === '') return null
    setPolishing(true)
    setError(null)
    try {
      const r = await rpc<{ polished?: string }>('corumAgent', 'polishConversation', {
        text,
        history: [],
      })
      const polished = r?.polished
      if (typeof polished !== 'string' || polished.trim() === '') {
        setError('润色未返回内容')
        return null
      }
      return polished
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setPolishing(false)
    }
  }
  return { polish, polishing, error }
}

/**
 * 「AI 翻译」按钮的共享实现（设置页提示词区，与 usePolishSetting 同型）。
 *
 * 翻译是给**预设 Agent 提示词**用的（用户 2026-09-16：「翻译是给预设 Agent 提示词用的」）
 * ——中英互译自动判向（中→英 / 英→中 / 其它→中），接宿主 `corumAgent/translatePrompt`。
 * 与润色的差异：润色走 polishConversation（可带上下文），翻译走 translatePrompt（单文本）。
 * @param rpc - corum RPC 调用面（null 时按钮禁用）。
 * @returns 翻译动作、进行中标志与最后一次错误。
 */
function useTranslateSetting(rpc: CorumRpcCall | null): {
  translate: (text: string) => Promise<string | null>
  translating: boolean
  error: string | null
} {
  const [translating, setTranslating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const translate = async (text: string): Promise<string | null> => {
    if (rpc === null || translating || text.trim() === '') return null
    setTranslating(true)
    setError(null)
    try {
      const r = await rpc<{ translated?: string }>('corumAgent', 'translatePrompt', { text })
      const translated = r?.translated
      if (typeof translated !== 'string' || translated.trim() === '') {
        setError('翻译未返回内容')
        return null
      }
      return translated
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setTranslating(false)
    }
  }
  return { translate, translating, error }
}

/* ── Agent 预设（名片式 + 筛选 + 详情编辑）────────────────────────────── */

/** ProfileSummary 投影（与 host agent-service.ts 对齐）。 */
interface AgentProfileSummary {
  id: string
  nickname?: string
  title?: string
  dimension?: string
  experience?: string
  persona?: string
  /** 人格预设（工作场景人格原型 id，或 'custom'）。 */
  personaPreset?: string
  avatar?: string
  baseMode?: string
  prompt: string
  model: { provider: string; model: string; reasoningEffort?: string }
  /**
   * 子 Agent 模型配置（三态，与 host 的 `ProfileChildModel` 对齐）：
   * 键不存在 = 不覆盖（走全局档）；`'follow-main'` = 显式跟随主 Agent；否则为具体路由。
   */
  subagentModel?: { provider: string; model: string; reasoningEffort?: string } | 'follow-main'
  /** 研究子 Agent 模型配置（同上三态；键不存在 ⇒ 回落 subagentModel）。 */
  researchModel?: { provider: string; model: string; reasoningEffort?: string } | 'follow-main'
  /** 并行开发策略（可选；fork #10 双实例行 config 的 profile 级覆盖）。 */
  parallelWork?: ParallelWorkDraft
  skills: SkillBinding[]
  mcpServers: string[]
  terminal: { mode: string }
  /** 记忆功能开关（UI 投影；持久化在 memoryPolicy.scope，'agent'=开启）。 */
  memoryEnabled?: boolean
  version: number
  trust: string
  source: 'corum' | 'official'
  /**
   * 模块来源标记（契约 §7.1 + 主 Agent 统一裁定：落盘键名 `moduleSource`，不是 `source`——后者已被占用）。
   * 存在 ⇒ 这份预设是从模块装进来的 ⇒ 卡片加「模块」徽标（用户 Q1 直接产物）。
   */
  moduleSource?: ModuleSource
}

/**
 * 并行编排策略的 UI 投影。
 *
 * 编排统一化后旧字段（isolation/worktreeRoot/branchPrefix/merger/autoCleanup/
 * denyDirectFs/integrateChecks）已作废，UI 仅保留 `maxParallelChildren`
 * （「模型与并发」卡片的子 Agent 并发数）；保留该宽类型仅为兼容 host 回读。
 */
interface ParallelWorkDraft {
  maxParallelChildren?: number
}

const AGENT_DIMENSIONS = ['研发', '产品', '设计', '市场', '自媒体', '创作', '通用'] as const

/**
 * 「通用」栏固定成员（2026-10-06 用户定调）：指挥模式 / 全能助手 / 极简助手 / Corum 开发。
 * 固定顺序、仅内置角色、仅代码层面可增（用户不设 UI 入口加通用成员）。
 * 「专用」栏 = 其余内置角色 + 用户自建预设。
 */
const GENERAL_PRESET_IDS = ['conductor-lead', 'general-assistant', 'minimal-assistant'] as const

/** 按 prompt 生成「擅长什么」摘要（取首行，去 markdown 标记）。 */
function promptToMotto(prompt: string): string {
  const first = prompt.split('\n').find(l => l.trim().length > 0) ?? ''
  return first.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim() || '—'
}

/** 推断岗位维度（profile 未显式设置时按 title/id 关键词兜底）。 */
function inferDimension(p: AgentProfileSummary): string {
  if (p.dimension !== undefined && p.dimension !== '') return p.dimension
  const text = `${p.title ?? ''} ${p.id}`.toLowerCase()
  if (/产品|pm|product/.test(text)) return '产品'
  if (/设计|design/.test(text)) return '设计'
  if (/市场|营销|market/.test(text)) return '市场'
  if (/自媒体|媒体|content/.test(text)) return '自媒体'
  if (/创作|写作|creative|writer/.test(text)) return '创作'
  return '研发'
}

/* 技能卡 icon 语义映射（设计稿 uC1P0：code-review→layers、research→search，默认 star） */
function skillIcon(name: string, size: number, className?: string) {
  const n = name.toLowerCase()
  if (/review|audit|层/.test(n)) return <Layers size={size} className={className} />
  if (/research|search|检索|调研/.test(n)) return <Search size={size} className={className} />
  return <Star size={size} className={className} />
}

/* 工具（MCP）卡 icon 语义映射（设计稿 LTUPo：filesystem→database、websearch→globe） */
function toolIcon(name: string, size: number, className?: string) {
  const n = name.toLowerCase()
  if (/file|fs|database|db|目录/.test(n)) return <Database size={size} className={className} />
  if (/web|search|http|browser|网/.test(n)) return <Globe size={size} className={className} />
  return <Server size={size} className={className} />
}

/* ── Agent 名片卡 ─────────────────────────────────────────────────────── */

function AgentCard({ profile, onClick, hideChevron }: { profile: AgentProfileSummary; onClick: () => void; hideChevron?: boolean }) {
  const dim = inferDimension(profile)
  return (
    <div className={css.agentCard} onClick={onClick} role="button">
      <div className={css.agentCardHead}>
        <div className={css.agentAvatar}>
          {profile.avatar !== undefined && profile.avatar !== ''
            ? <img className={css.agentAvatarImg} src={profile.avatar} alt="" />
            : <div className={css.agentAvatarPlaceholder} />}
        </div>
        <div className={css.agentNameCol}>
          <div className={css.agentNameRow}>
            <span className={css.agentNickname}>{profile.nickname ?? profile.id}</span>
            <span className={css.trustBadge}>{profile.trust === 'system' ? '系统' : '用户'}</span>
            {/* 模块装来的预设加「模块」徽标（host 的 ProfileSummary.moduleSource 存在时；
                用户 Q1 直接产物：模块装的与自建的同目录，没有标识就分不清）。
                样式复用 trustBadge 类，仅文案不同——保持名片视觉一致。 */}
            {profile.moduleSource !== undefined && (
              <span className={`${css.trustBadge} ${css.moduleBadge}`}>模块</span>
            )}
          </div>
          <span className={css.agentRole}>{profile.title ?? 'Agent'}</span>
        </div>
        {hideChevron !== true && <ChevronRight size={14} className={css.agentChevron} />}
      </div>
      <span className={css.agentMotto}>{promptToMotto(profile.prompt)}</span>
      {/* 经验行固定占位（设计稿 exp 行；无经验时留空占位保证名片等高） */}
      <span className={css.agentExp}>{profile.experience ?? ''}</span>
      <div className={css.agentModelRow}>
        <Cpu size={11} className={css.agentModelIcon} />
        {/* 2026-09-16 用户定调：「继承自 X」从名片移除（放进详情/编辑页看——继承自下拉
            与提示已在编辑页 :938-947）⇒ 名片底部行只留「模型名 + 维度」，简介/座右铭
            不再被「继承自 标准模式（完整编码能力）」挤压截断。 */}
        <span className={css.agentModelName}>{profile.model.model}</span>
        <span className={css.agentDimTag}>{dim}</span>
      </div>
    </div>
  )
}

/* ── 名片预览（编辑弹窗右上角）───────────────────────────────────────── */

function AgentCardPreview({ draft }: { draft: EditDraft }) {
  const pseudo: AgentProfileSummary = {
    id: draft.name || 'new-agent',
    ...(draft.nickname !== '' ? { nickname: draft.nickname } : {}),
    ...(draft.title !== '' ? { title: draft.title } : {}),
    ...(draft.dimension !== '' ? { dimension: draft.dimension } : {}),
    ...(draft.experience !== '' ? { experience: draft.experience } : {}),
    ...(draft.avatar !== '' ? { avatar: draft.avatar } : {}),
    prompt: draft.prompt,
    model: { provider: draft.provider, model: draft.model },
    skills: draft.skills,
    mcpServers: draft.mcpServers,
    terminal: { mode: draft.terminal },
    version: 1,
    trust: draft.trust,
    source: 'corum',
  }
  return (
    <div className={css.cardPreviewRow}>
      <span className={css.cardPreviewLabel}>名片预览 →</span>
      <div className={css.cardPreviewCard}>
        <AgentCard profile={pseudo} onClick={() => {}} />
      </div>
    </div>
  )
}

/* ── 官方模式只读卡 ──────────────────────────────────────────────────── */

const OFFICIAL_MODE_META: Record<string, { label: string; desc: string }> = {
  standard: { label: '标准模式', desc: '功能完整的编码 Agent，支持文件编辑 / Shell / 检索 / Skills' },
  // fork（corum）2026-10-06：补 conductor 翻译——此前缺，卡片上 conductor 显示英文 id。
  conductor: { label: '指挥模式', desc: '只编排、不亲手执行：拆解并分派给子 Agent / 团队' },
  ptc: { label: 'PTC 模式', desc: '标准模式 + Code Mode SDK 多步操作' },
  minimal: { label: '极简模式', desc: '仅持久 bash + 编辑器的双工具 Agent' },
  cordis: { label: '创造模式', desc: '用于创建自定义 Agent preset' },
}

/** 官方基础模式的只读详情（介绍 + 能力面）。数据为静态说明（模式是模板，不挂可配 skill/mcp）。 */
const OFFICIAL_MODE_DETAIL: Record<string, { label: string; intro: string; capabilities: string[] }> = {
  standard: {
    label: '标准模式',
    intro: '功能完整的编码 Agent，覆盖日常开发的大多数场景：读写文件、执行命令、检索代码、调用技能。是大多数内置角色（研发 / 产品 / 测试等）的默认基础。',
    capabilities: ['文件编辑（read / write / edit）', 'Shell 命令执行', '代码检索与检索工具', 'Skills 技能调用', 'MCP 服务器接入'],
  },
  conductor: {
    label: '指挥模式',
    intro: '只编排、不亲手执行的模式：把任务拆解并分派给子 Agent / 团队，跟踪进度并回收结果。本身不写代码、不跑命令，适合作多 Agent 团队的统筹入口。',
    capabilities: ['任务拆解与派发（orchestrate）', '子 Agent / 团队调度', '进度跟踪与结果回收', '不直接执行文件 / Shell 写操作'],
  },
  ptc: {
    label: 'PTC 模式',
    intro: '标准模式之上叠加 Code Mode SDK 的多步操作能力：面向需要跨多步、带中间状态的工具编排场景（如复杂的代码变换流水线）。',
    capabilities: ['标准模式全部能力', 'Code Mode SDK 多步操作', 'tool-presentation（ptc 模式）'],
  },
  minimal: {
    label: '极简模式',
    intro: '只保留最小写面：持久 bash + 文件系统双工具。适合受限环境或对工具面做最小化裁剪的场景。',
    capabilities: ['persona 人格', 'persistent-shell', 'filesystem（write / edit）', '无检索 / 无 Skills / 无 MCP'],
  },
  cordis: {
    label: '创造模式',
    intro: '用于创建自定义 Agent preset 的模式：引导你定义新 Agent 的人格、模型、技能与工具组合，并把它保存为可复用的预设。',
    capabilities: ['预设创建向导（preset-author）', '人格 / 提示词定义', '模型与工具面配置', '保存为自定义 Agent preset'],
  },
}

/** 官方基础模式只读详情页（2026-09-16：卡片可点击进详情，模式是模板不可编辑）。 */
function OfficialModeDetailView({ modeId, onBack }: { modeId: string; onBack: () => void }) {
  const detail = OFFICIAL_MODE_DETAIL[modeId] ?? { label: modeId, intro: '', capabilities: [] }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: '100%', height: '100%', minHeight: 0, overflowY: 'auto' }}>
      <button type="button" className={css.backRowGhost} onClick={onBack}>
        <ChevronLeft size={14} />返回 Agent 预设
      </button>
      <div className={css.formGroupTitle}>{detail.label}</div>
      <p className={css.hintText}>{detail.intro}</p>
      <div className={css.formGroupTitle}>能力面</div>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {detail.capabilities.map(c => <li key={c} className={css.hintText}>{c}</li>)}
      </ul>
      <p className={css.hintText}>官方基础模式是新建 / 编辑 Agent 时的继承模板（baseMode），不可直接选中、不可编辑。</p>
    </div>
  )
}

function OfficialModeCard({ id, onClick }: { id: string; onClick: () => void }) {
  const meta = OFFICIAL_MODE_META[id] ?? { label: id, desc: '' }
  return (
    <div className={css.officialCard} onClick={onClick} role="button">
      <div className={css.officialCardHead}>
        <Box size={13} className={css.officialCardIcon} />
        <span className={css.officialCardLabel}>{meta.label}</span>
        <span className={css.officialBadge}>官方</span>
        {/* 2026-09-16：基础模式卡**就是模式本身**，不再显示冗余的「继承自」徽标。 */}
        <ChevronRight size={14} className={css.agentChevron} />
      </div>
      <span className={css.officialCardDesc}>{meta.desc}</span>
    </div>
  )
}

/* ── 编辑表单草稿 ────────────────────────────────────────────────────── */

interface EditDraft {
  name: string
  nickname: string
  title: string
  dimension: string
  experience: string
  personaPreset: string
  /** 自定义人格名称（personaPreset === 'custom' 时填；最多 20 字）。 */
  personaCustom: string
  avatar: string
  baseMode: string
  prompt: string
  provider: string
  model: string
  /** 主 Agent 推理等级（'' = 默认档；无 reasoning 元数据的路由不渲染该列）。 */
  mainEffort: string
  /**
   * 子 Agent 模型的三态选择（与 host 的 `ProfileChildModel` 对齐）：
   *   · `'inherit'`  = 键不存在 ⇒ 不覆盖，走全局默认档（全局也没配才跟随主 Agent）；
   *   · `'follow'`   = 写 `'follow-main'` 哨兵 ⇒ **跳过**全局档，直接跟随主 Agent；
   *   · `'custom'`   = 写具体路由。
   * 旧布尔 `subEnabled` 只能表达两态，会把「不覆盖」与「显式跟随」压成一个 ⇒ 保存时
   * 静默改写用户选择（本轮修的就是这类）。
   */
  subMode: 'inherit' | 'follow' | 'custom'
  subProvider: string
  subModel: string
  /** 子 Agent 推理等级（'' = 默认档）。 */
  subEffort: string
  /** 研究子 Agent 模型（subagent_research 只读实例；三态同上）。 */
  researchMode: 'inherit' | 'follow' | 'custom'
  researchProvider: string
  researchModel: string
  /** 调查 Agent 推理等级（'' = 默认档）。 */
  researchEffort: string
  /** 自定义设置开关（设计稿 v4 card-模型与并发：关闭 = 跟随系统统一设置）。 */
  customEnabled: boolean
  /** 「模型与并发」卡片是否展开（设计稿 v4：默认折叠）。 */
  modelCardExpanded: boolean
  /** 子 Agent 并发数（自定义设置开启时生效；空 = 跟随系统默认）。 */
  maxParallel: string
  terminal: 'sandbox' | 'host'
  /** 记忆功能开关（设计稿 GHBvv「记忆功能」switch；持久化在 memoryPolicy.scope）。 */
  memoryEnabled: boolean
  skills: SkillBinding[]
  mcpServers: string[]
  trust: 'system' | 'user'
}

/**
 * 新建预设的**初始草稿**。
 *
 * ⚠️ 2026-10-11 用户澄清的语义（**推翻** 2026-09-18 的「始终两档」）：
 * 「全局未设置子 Agent 的 LLM 模型、只设置主 Agent 的 LLM 模型的情况下，
 * **即无论如何都未设置子 Agent 模型时才跟随主 Agent**」。
 *
 * ⇒ 设置→智能体 页那两个「worker / research 子 Agent 默认模型」**既是**新建预设时的
 * 预填模板（本函数的作用），**也是**运行期兜底档（运行期三档：预设里配的模型 ＞
 * 全局的 defaultModel/defaultResearchModel ＞ 跟随主 Agent，见 `corum-tool-subagent`
 * 的 `corumEffectiveModel = corumSessionOverride ?? config.model ?? corumGlobalRoute`）。
 *
 * 两者并存不矛盾：新建时把全局值**预填进草稿**（用户看得见、可改），若用户清空（不配）
 * 则保存后该预设没配子模型，运行期就落到全局那档；只有全局也没配时才跟随主 Agent。
 *
 * @param template - 全局模板值（`corum-subagent` 的 defaultModel/defaultResearchModel）；
 *   缺省时保持内置兜底值（全局也没配 ⇒ 预设也不配子模型 ⇒ 运行期也落到「跟随主 Agent」）。
 * @returns 新建预设用的草稿。
 */
function emptyDraft(template?: { sub?: { provider: string; model: string } | undefined; research?: { provider: string; model: string } | undefined }): EditDraft {
  const sub = template?.sub
  const research = template?.research
  return {
    name: '', nickname: '', title: '', dimension: '研发', experience: '',
    personaPreset: DEFAULT_PERSONA_PRESET, personaCustom: '', avatar: '',
    baseMode: 'standard', prompt: '', provider: 'deepseek-official', model: 'deepseek-v4-flash',
    // 推理等级一律以「默认档」起步（跟随新模型的默认档，不预填旧档）。
    mainEffort: '',
    // 模板命中 ⇒ 预填具体路由并**打开**该项（让用户看得见「这个预设用了全局模板的模型」）；
    // 模板缺省 ⇒ 'inherit' = 菜单里的「不覆盖」项：运行期走全局那档，
    // 全局也没配才跟随主 Agent（三档语义，2026-10-11）。
    subMode: sub !== undefined ? 'custom' : 'inherit',
    subProvider: sub?.provider ?? 'deepseek-official',
    subModel: sub?.model ?? 'deepseek-v4-flash',
    subEffort: '',
    researchMode: research !== undefined ? 'custom' : 'inherit',
    researchProvider: research?.provider ?? 'deepseek-official',
    researchModel: research?.model ?? 'deepseek-v4-flash',
    researchEffort: '',
    customEnabled: sub !== undefined || research !== undefined, modelCardExpanded: sub !== undefined || research !== undefined, maxParallel: '',
    terminal: 'sandbox', memoryEnabled: false, skills: [], mcpServers: [], trust: 'user',
  }
}

function draftFromProfile(p: AgentProfileSummary): EditDraft {
  return {
    name: p.id,
    nickname: p.nickname ?? '',
    title: p.title ?? '',
    dimension: p.dimension ?? inferDimension(p),
    experience: p.experience ?? '',
    // 人格预设回填：无预设时按 legacy persona 文本兜底判为「自定义」，避免丢失旧数据。
    personaPreset: p.personaPreset ?? (p.persona !== undefined && p.persona !== '' ? 'custom' : DEFAULT_PERSONA_PRESET),
    // ⚠️ 2026-10-11：原先这里同时写 `personaCustom` 与一个 `persona` 副本，那个副本永不被
    // 输入框更新（只有保存会读 personaCustom）⇒ 预览读到陈旧值。现只保留权威字段。
    personaCustom: p.personaPreset === 'custom' ? (p.persona ?? '') : '',
    avatar: p.avatar ?? '',
    baseMode: p.baseMode ?? 'standard',
    prompt: p.prompt,
    provider: p.model.provider,
    model: p.model.model,
    mainEffort: p.model.reasoningEffort ?? '',
    // 子 Agent 模型回填（三态）：哨兵 → 'follow'；具体路由 → 'custom'；键不存在 → 'inherit'。
    // ⚠️ 必须分辨哨兵与路由：`p.subagentModel?.provider` 在哨兵上会取到 undefined
    // （字符串没有 provider），若不先判类型就会把「显式跟随」回填成「不覆盖」⇒
    // 用户一保存就静默改写了自己的选择。
    subMode: childModelModeOf(p.subagentModel),
    subProvider: childModelRouteOf(p.subagentModel)?.provider ?? 'deepseek-official',
    subModel: childModelRouteOf(p.subagentModel)?.model ?? 'deepseek-v4-flash',
    subEffort: childModelRouteOf(p.subagentModel)?.reasoningEffort ?? '',
    researchMode: childModelModeOf(p.researchModel),
    researchProvider: childModelRouteOf(p.researchModel)?.provider ?? 'deepseek-official',
    researchModel: childModelRouteOf(p.researchModel)?.model ?? 'deepseek-v4-flash',
    researchEffort: childModelRouteOf(p.researchModel)?.reasoningEffort ?? '',
    // 自定义设置：任一覆盖项已配（子/研究模型或并发上限）即视为开启，并默认展开卡片。
    // `'inherit'` 不算「已配」（它就是"不覆盖"），`'follow'`/`'custom'` 都算。
    customEnabled: p.subagentModel !== undefined || p.researchModel !== undefined
      || p.parallelWork?.maxParallelChildren !== undefined,
    modelCardExpanded: p.subagentModel !== undefined || p.researchModel !== undefined
      || p.parallelWork?.maxParallelChildren !== undefined,
    maxParallel: p.parallelWork?.maxParallelChildren !== undefined ? String(p.parallelWork.maxParallelChildren) : '',
    terminal: (p.terminal.mode === 'host' ? 'host' : 'sandbox') as 'sandbox' | 'host',
    memoryEnabled: p.memoryEnabled === true,
    skills: p.skills,
    mcpServers: p.mcpServers,
    trust: (p.trust === 'system' ? 'system' : 'user') as 'system' | 'user',
  }
}

/**
 * 「模型与并发」卡片 → parallelWork 载荷。
 *
 * 设计稿 v4：自定义设置**关闭**时不覆盖系统统一设置（返回空对象，不写键）；
 * 开启时只写「子 Agent 并发数」（模型走 subagentModel/researchModel 顶层字段，
 * 旧的 isolation/merger/integrateChecks 已随编排统一化作废）。
 */
function buildParallelWork(draft: EditDraft): { parallelWork?: ParallelWorkDraft } {
  if (!draft.customEnabled) return {}
  const maxParallel = Number.parseInt(draft.maxParallel, 10)
  if (draft.maxParallel.trim() === '' || !Number.isInteger(maxParallel) || maxParallel <= 0) return {}
  return { parallelWork: { maxParallelChildren: maxParallel } }
}

/** 自定义人格名称的字数上限（设计稿 DA4gi row-custom：5 / 20）。 */
const PERSONA_CUSTOM_MAX = 20

/* ── 虚位以待占位卡（每行不足 3 张时补齐）───────────────────────────── */

function PlaceholderCard() {
  return (
    // 占位卡与同行名片等高（flex 行 stretch），不写死高度。
    <div className={css.agentAddCard}>
      <Ghost size={16} style={{ color: 'var(--dsw-alias-label-dimmed)' }} />
      <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-dimmed)' }}>虚位以待</span>
    </div>
  )
}

/* ── 主 section（home / edit 两级 view）───────────────────────────────── */

type PresetsView =
  | { kind: 'home' }
  | { kind: 'edit'; profile: AgentProfileSummary | 'new' }
  | { kind: 'official-detail'; modeId: string }

/**
 * 从「设置→智能体」的全局配置取**新建预设的模板值**。
 *
 * 用户 2026-10-11 澄清的语义落点（**推翻** 2026-09-18 的「始终两档」）：全局页那两项
 * （`corum-subagent` 的 defaultModel / defaultResearchModel）**既是**新建预设的预填模板
 * （本函数），**也是**运行期的兜底档（三档：预设里配的模型 ＞ 全局这两项 ＞ 跟随主 Agent，
 * 见 corum-tool-subagent 的 `corumEffectiveModel = corumSessionOverride ?? config.model
 * ?? corumGlobalRoute`）。
 *
 * 本函数只管**模板那一半**：新建时读一次、预填进草稿，让用户看得见并可就地改。
 * 保存后该预设若没配子模型（用户清空了），运行期自然落到全局那档——这是**要的行为**，
 * 不是「改了全局却回头影响已建预设」的意外。
 *
 * @param settings - settings 面；未提供（服务未就绪）时返回空模板 ⇒ 新建预设不配子模型。
 * @returns `{sub, research}` 两个可选模板值；缺省项表示「没有模板，不预填」。
 */
function newPresetTemplate(settings: CorumSettingsFace | null): {
  sub?: { provider: string; model: string } | undefined
  research?: { provider: string; model: string } | undefined
} {
  if (settings === null) return {}
  const namespaces = settings.describe.getSnapshot().view?.namespaces ?? []
  const entry = namespaces.find(n => n.ns === 'corum-subagent')
  // 读**用户层**（user）：模板是用户显式配的值；value 是合成后值（含默认），
  // 拿它当模板会把「未配置」也当成模板。
  const user = (entry?.user ?? {}) as {
    defaultModel?: { provider?: string; model?: string }
    defaultResearchModel?: { provider?: string; model?: string }
  }
  const pick = (m: { provider?: string; model?: string } | undefined): { provider: string; model: string } | undefined =>
    m?.provider !== undefined && m?.model !== undefined && m.provider !== '' && m.model !== ''
      ? { provider: m.provider, model: m.model }
      : undefined
  const sub = pick(user.defaultModel)
  return {
    ...sub === undefined ? {} : { sub },
    // research 未单独配时**不**回落到 sub：菜单里 research 的「（同 worker）」
    // 由 corum 侧的 `researchModel ?? subagentModel` 表达，模板层不重复这条语义。
    ...(() => { const r = pick(user.defaultResearchModel); return r === undefined ? {} : { research: r } })(),
  }
}

export function AgentPresetsSection() {
  const rpc = useCorumRpc()
  // 全局模板（设置→智能体 的 worker/research 子 Agent 默认模型）——2026-09-18 用户澄清：
  // 它们**不是运行期的第三档**，而是**新建预设时的预填值**（见 emptyDraft 的说明）。
  const settings = useCorumSettings()
  const [view, setView] = useState<PresetsView>({ kind: 'home' })
  const [profiles, setProfiles] = useState<AgentProfileSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dimFilter, setDimFilter] = useState<string>('全部')
  const [search, setSearch] = useState('')
  // 导入向导开关（设计稿 P1 入口按钮 → 5 步模态 ImportModuleWizard）。
  const [importOpen, setImportOpen] = useState(false)

  // describe 镜像订阅：模板值可能在设置页被改，订阅后回来新建才能拿到最新值。
  useEffect(() => {
    if (settings === null) return undefined
    void settings.describe.ensure()
    return settings.describe.subscribe(() => { /* 下次渲染读最新快照 */ })
  }, [settings])

  const reload = async () => {
    if (!rpc) return
    try {
      const r = await rpc<{ profiles: AgentProfileSummary[] }>('corumAgent', 'listProfiles', {})
      setProfiles(r.profiles)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { void reload() }, [rpc])

  if (!rpc) return <p className={css.hintText}>Agent 服务未就绪。</p>

  if (view.kind === 'edit') {
    return (
      <EditPresetView
        key={view.profile === 'new' ? '__new__' : view.profile.id}
        profile={view.profile === 'new' ? undefined : view.profile}
        rpc={rpc}
        template={newPresetTemplate(settings)}
        onBack={() => setView({ kind: 'home' })}
        onSaved={() => { setView({ kind: 'home' }); void reload() }}
      />
    )
  }

  if (view.kind === 'official-detail') {
    return <OfficialModeDetailView modeId={view.modeId} onBack={() => setView({ kind: 'home' })} />
  }

  const corumProfiles = (profiles ?? []).filter(p => p.source === 'corum')
  const officialProfiles = (profiles ?? []).filter(p => p.source === 'official')

  const filtered = corumProfiles.filter(p => {
    if (dimFilter !== '全部' && inferDimension(p) !== dimFilter) return false
    if (search !== '') {
      const q = search.toLowerCase()
      const hay = `${p.nickname ?? ''} ${p.id} ${p.title ?? ''} ${promptToMotto(p.prompt)}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  // fork（corum）2026-10-06 用户定调：预设分「通用」「专用」两栏。
  // 通用 = 固定 4 个内置角色（指挥模式/全能助手/极简助手/Corum 开发），固定顺序、
  // 仅内置、仅代码层面可增；专用 = 其余全部内置角色 + 用户自建预设。
  // 「官方基础模式」组在下方独立，不进这两栏。
  const generalIds = GENERAL_PRESET_IDS.filter(id => filtered.some(p => p.id === id))
  const generalProfiles = generalIds.map(id => filtered.find(p => p.id === id)!)
  const specialProfiles = filtered.filter(p => !GENERAL_PRESET_IDS.includes(p.id as typeof GENERAL_PRESET_IDS[number]))

  /** 按 3 列切行；不足 3 张的行在渲染层用 PlaceholderCard 补齐。 */
  const toRows = (list: AgentProfileSummary[]): AgentProfileSummary[][] => {
    const rows: AgentProfileSummary[][] = []
    for (let i = 0; i < list.length; i += 3) rows.push(list.slice(i, i + 3))
    return rows
  }

  /** 渲染一组名片（组标题 + 3 列网格 + 虚位补齐）。 */
  const renderGroup = (title: string, list: AgentProfileSummary[], showIfEmpty: boolean) => {
    if (list.length === 0 && !showIfEmpty) return null
    return (
      <div className={css.agentPresetGroup} key={title}>
        <span className={css.agentPresetGroupTitle}>{title}</span>
        <div className={css.agentCardGrid}>
          {toRows(list).map((row, ri) => (
            <div key={ri} className={css.agentGridRow}>
              {row.map(p => (
                <AgentCard key={p.id} profile={p} onClick={() => setView({ kind: 'edit', profile: p })} />
              ))}
              {row.length < 3 && Array.from({ length: 3 - row.length }, (_, i) => (
                <PlaceholderCard key={`ph-${i}`} />
              ))}
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>预设决定 Agent 的模型、技能与工具组合。点击名片进入 Agent 设置。</span>
        <div className={css.topActions}>
          {/* 导入 Agent 预设（设计稿 P1：次按钮，深色底+描边+立方体图标，
              与「+ 新建预设」同排、右对齐；次按钮在左、主按钮在右）。
              打开 5 步导入向导（ImportModuleWizard）。 */}
          <GlassButton onClick={() => setImportOpen(true)}>
            <Package size={13} className={css.btnIconLeft} />导入 Agent 预设
          </GlassButton>
          <GlassButton variant="primary" onClick={() => setView({ kind: 'edit', profile: 'new' })}>+ 新建预设</GlassButton>
        </div>
      </div>

      <div className={css.agentFilterRow}>
        {(['全部', ...AGENT_DIMENSIONS] as const).map(d => (
          <button
            key={d}
            type="button"
            className={`${css.agentDimPill}${dimFilter === d ? ' ' + css.agentDimPillActive : ''}`}
            onClick={() => setDimFilter(d)}
          >{d}</button>
        ))}
        <div className={css.agentSearchBox}>
          <Search size={13} className={css.agentSearchIcon} />
          <input
            className={css.agentSearchInput}
            placeholder="搜索 Agent…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {error !== null && <p className={css.hintText}>加载失败:{error}</p>}
      {profiles === null && error === null && <p className={css.hintText}>加载中…</p>}
      {profiles !== null && filtered.length === 0 && (
        <p className={css.hintText}>{corumProfiles.length === 0 ? '暂无 Agent 预设，点击右上角「新建预设」创建。' : '没有匹配的 Agent。'}</p>
      )}

      {renderGroup('通用', generalProfiles, false)}
      {renderGroup('专用', specialProfiles, false)}

      {officialProfiles.length > 0 && (
        <div className={css.officialGroup}>
          {/* 2026-09-12 用户定调：这 5 个官方模式不再是可直接选中的 Agent，只作
              新建/编辑 Agent 时的继承模板（baseMode）——所以标题点明「继承模板」。
              2026-09-16：渲染**全部**（原先 slice(0,2)/slice(2,4) 硬编码四卡，
              第 5 个 cordis/创造模式被截断丢失）；卡片可点击进只读详情。 */}
          <span className={css.officialGroupTitle}>官方基础模式（继承模板，不可直接选中）</span>
          <div className={css.officialGrid}>
            {officialProfiles.map(p => (
              <OfficialModeCard key={p.id} id={p.id} onClick={() => setView({ kind: 'official-detail', modeId: p.id })} />
            ))}
          </div>
        </div>
      )}

      {/* 导入向导（createPortal + 模态，照 SkillBindDialog 写法；由列表页入口打开） */}
      {importOpen && rpc !== null && (
        <ImportModuleWizard
          rpc={rpc}
          onClose={() => setImportOpen(false)}
          onInstalled={() => { setImportOpen(false); void reload() }}
        />
      )}
    </>
  )
}

/* ── 编辑/新建 Agent 预设二级页（左右分栏，按设计稿 GHBvv 落码）────────── */

/** 基础模式中文描述（继承自下拉 + 名片 inheritTag 共用）。 */
const BASE_MODE_LABELS: Record<string, string> = {
  standard: '标准模式（完整编码能力）',
  conductor: '指挥模式（只编排不亲手执行）',
  ptc: '多步操作模式',
  minimal: '极简双工具模式',
  cordis: '创造模式',
}

const BASE_MODE_OPTIONS = [
  { id: 'standard', label: BASE_MODE_LABELS.standard },
  { id: 'conductor', label: BASE_MODE_LABELS.conductor },
  { id: 'ptc', label: BASE_MODE_LABELS.ptc },
  // fork（corum）2026-09-29（用户裁决）：minimal 保持官方原汁原味，自建预设不再允许
  // 继承此模式 ⇒ 下拉不提供 minimal 选项（只内置「极简模式」(minimal-assistant) 用它）。
  { id: 'cordis', label: BASE_MODE_LABELS.cordis },
]

/** 取基础模式中文描述（未知名称回退原 id）。 */
function baseModeLabel(id: string): string {
  return BASE_MODE_LABELS[id] ?? id
}

const TERMINAL_OPTIONS = [
  { id: 'sandbox', label: 'sandbox' },
  { id: 'host', label: 'host' },
]

const DIMENSION_OPTIONS = AGENT_DIMENSIONS.map(d => ({ id: d, label: d }))

/**
 * 人格预设下拉（设计稿 DA4gi menu：6 个内置人格 + 「自定义」）。
 *
 * id 必须与 host `PersonaPreset` 联合类型一致（profile.ts），
 * 中文标签对应 compile.ts `PERSONA_PRESET_PROMPTS` 的语义。
 */
const PERSONA_PRESET_OPTIONS = [
  { id: 'efficient-executor', label: '务实高效' },
  { id: 'steady-coach', label: '简洁直接' },
  { id: 'rigorous-architect', label: '严谨细致' },
  { id: 'innovative-explorer', label: '创新探索' },
  { id: 'custom', label: '自定义' },
]
const DEFAULT_PERSONA_PRESET = 'efficient-executor'

/**
 * 取人格预设中文标签（未知 id 回退原值）。
 *
 * 导出给 `ImportModuleWizard` 复用：模块预览要显示「人格 · 务实高效」，
 * 而那 5 个标签的**唯一事实源**在这里（第二份表必然漂移）。
 */
export function personaPresetLabel(id: string): string {
  return PERSONA_PRESET_OPTIONS.find(o => o.id === id)?.label ?? id
}

/** 模型下拉兜底目录（corumAgent/listModels 不可用时；与设计稿文案一致）。 */
const FALLBACK_PROVIDERS = [
  { id: 'deepseek-official', label: 'deepseek-official' },
  { id: 'pi-ai', label: 'pi-ai' },
]
const FALLBACK_MODELS = [
  { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
  { id: 'deepseek-v4', label: 'deepseek-v4' },
  { id: 'deepseek-r1', label: 'deepseek-r1' },
]

/**
 * 子 Agent 模型「**不覆盖**」的占位项（设计稿 iUSeO 原写「（同主 Agent）」）。
 *
 * ⚠️ 2026-10-11 改措辞：旧文案「（同主 Agent）」在**两档**语义下成立，但用户当日把
 * 运行期改成**三档**（预设里配的模型 ＞ 全局的子 Agent 默认模型 ＞ 跟随主 Agent）——
 * 此时「不配」的实际含义是「**不覆盖，交给后两档**」，只有全局也没配时才跟随主 Agent。
 * 直接写「同主 Agent」会与事实不符（全局配了子模型时，子 Agent 跟的是全局那个）。
 */
const SAME_AS_MAIN = { id: '', label: '（不覆盖：全局 → 主 Agent）' }

/**
 * 子 Agent 模型「**显式跟随主 Agent**」的选项（第三态）。
 *
 * 与 {@link SAME_AS_MAIN} 的区别是实质性的，**不能合并**：
 *   · 不覆盖 ⇒ 运行期走全局 `corum-subagent` 默认档，全局也没配才跟随主 Agent；
 *   · 本项   ⇒ **跳过**全局档，直接跟随主 Agent。
 * 在 2026-10-11 的三档语义之前这两者恰好等价，所以旧 UI 只有一个「不覆盖」项；
 * 现在必须分开——否则用户永远无法「无视全局默认、就要跟主 Agent」。
 *
 * id 用与 host `FOLLOW_MAIN` 相同的字面量 `'follow-main'`：它是**协议值**，
 * 保存时会原样写进 `agent.json` 的 `subagentModel`/`researchModel`。
 */
const FOLLOW_MAIN_OPTION = { id: 'follow-main', label: '（显式跟随主 Agent）' }

/** 子 Agent 模型的三态（与 EditDraft 的 `subMode`/`researchMode` 同集）。 */
type ChildModelMode = 'inherit' | 'follow' | 'custom'

/**
 * 判定 host 侧某个子 Agent 模型字段的三态。
 *
 * 必须在取字段前**先判类型**：哨兵 `'follow-main'` 是字符串，对它读 `.provider`
 * 会得到 undefined（不报错），从而把「显式跟随」静默回填成「不覆盖」。
 * @param value - `agent.json` 里的 `subagentModel`/`researchModel`。
 * @returns 三态之一。
 */
function childModelModeOf(value: { provider: string; model: string; reasoningEffort?: string } | 'follow-main' | undefined): ChildModelMode {
  if (value === undefined) return 'inherit'
  return value === 'follow-main' ? 'follow' : 'custom'
}

/**
 * 取出具体路由（哨兵/未配一律 undefined）。
 * @param value - 同 {@link childModelModeOf}。
 * @returns 具体路由或 undefined。
 */
function childModelRouteOf(value: { provider: string; model: string; reasoningEffort?: string } | 'follow-main' | undefined): { provider: string; model: string; reasoningEffort?: string } | undefined {
  if (value === undefined || value === 'follow-main') return undefined
  return value
}

/**
 * 把草稿的三态转成 `saveProfile` 的载荷。
 *
 * ⚠️ 只有 `'custom'` 落在具体路由上；`'follow'` 必须写**哨兵字面量** `'follow-main'`
 * （host 侧 `FOLLOW_MAIN` 同值）——它是协议值，不是给人看的文案，改动会破坏兼容。
 * `'inherit'` 由调用方处理（**不写键**），不会进本函数。
 * @param mode - 三态（调用方已排除 `'inherit'`）。
 * @param provider - 供应商 id。
 * @param model - 模型 id。
 * @param effort - 推理等级（'' = 默认档，不写该键）。
 * @returns 写入 `agent.json` 的值。
 */
function childModelPayloadOf(
  mode: ChildModelMode,
  provider: string,
  model: string,
  effort: string,
): { provider: string; model: string; reasoningEffort?: string } | 'follow-main' {
  if (mode === 'follow') return 'follow-main'
  return { provider, model, ...(effort !== '' ? { reasoningEffort: effort } : {}) }
}

/** 某条路由（`provider/model`）的推理元数据（`session/modelCatalog` 投影）。 */
interface ReasoningMeta {
  efforts: { id: string; name: string; description?: string }[]
  defaultEffort?: string
}

/**
 * `session/modelCatalog` 的返回投影（只声明本页消费到的字段）。
 *
 * ⚠️ 这是**带推理元数据**的目录源（与 composer 模型选择器同源）；
 * `corumAgent/listModels` 的投影只有 `{id, name}`，**不含** reasoning
 * ⇒ 撑不起「推理等级」列。
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
 * 「推理等级」列的档位选项：默认档置顶（label 标注落在哪个默认值），其后是目录中的各档。
 *
 * @param meta - 当前路由的推理元数据；无元数据（不渲染该列）时返回空数组。
 * @returns SelectField 选项。
 */
function effortOptionsOf(meta: ReasoningMeta): Array<{ id: string; label: string }> {
  return [
    { id: '', label: `默认档（${meta.defaultEffort ?? 'provider 默认'}）` },
    ...meta.efforts.map(e => ({ id: e.id, label: e.name })),
  ]
}

/* ── 扩展包归属台账（P5d provenance + locked uninstall）────────────────── */

/** 六类资源类别（与 host 侧 ExtensionItemKind 同口径；本页只用 presets）。 */
type OwnershipKind = 'presets' | 'skills' | 'mcp' | 'plugins' | 'themes' | 'ui'

/** ownership() 返回的 wire 形状（六个 kind 键都在）。 */
type OwnershipWire = Readonly<Record<OwnershipKind, Readonly<Record<string, string>>>>

/** list() 返回的包摘要。 */
interface PackSummaryWire { readonly id: string; readonly name?: string; readonly version: string }
interface ListWire { readonly packs: readonly PackSummaryWire[] }

const EMPTY_OWNERSHIP: OwnershipWire = {
  presets: {}, skills: {}, mcp: {}, plugins: {}, themes: {}, ui: {},
}

/**
 * 取扩展包归属台账（fail-soft：RPC 不可用时返回空归属）。
 * 与 `corum-ide-integrations-pages-ui/ownership.ts` 同构——本包不跨依赖那个包。
 */
function useExtensionOwnership(rpc: CorumRpcCall | null): {
  ownerOf: (kind: OwnershipKind, name: string) => string | null
} {
  const [ownership, setOwnership] = useState<OwnershipWire>(EMPTY_OWNERSHIP)
  const [packNames, setPackNames] = useState<Readonly<Record<string, string>>>({})

  useEffect(() => {
    if (rpc === null) return
    let cancelled = false
    void (async () => {
      try {
        const [own, list] = await Promise.all([
          rpc<OwnershipWire>('extensionManager', 'ownership', {}),
          rpc<ListWire>('extensionManager', 'list', {}),
        ])
        if (cancelled) return
        const names: Record<string, string> = {}
        for (const p of list.packs) {
          names[p.id] = p.name !== undefined && p.name !== '' ? p.name : p.id
        }
        setOwnership(own)
        setPackNames(names)
      } catch {
        if (!cancelled) { setOwnership(EMPTY_OWNERSHIP); setPackNames({}) }
      }
    })()
    return () => { cancelled = true }
  }, [rpc])

  const ownerOf = useCallback((kind: OwnershipKind, name: string): string | null => {
    const packId = ownership[kind]?.[name]
    if (packId === undefined) return null
    return packNames[packId] ?? packId
  }, [ownership, packNames])

  return { ownerOf }
}

function provenanceLabel(ownerName: string | null, fallback: string): string {
  if (ownerName !== null) return `扩展包 · ${ownerName}`
  return fallback
}

function packOwnedTitle(ownerName: string): string {
  return `由扩展包「${ownerName}」统一管理，请到 集成中心 › 扩展包 卸载整包`
}

function EditPresetView({ profile, rpc, template, onBack, onSaved }: {
  profile: AgentProfileSummary | undefined
  rpc: CorumRpcCall
  /** 新建预设时的全局模板值（仅 `profile === undefined` 时生效）。 */
  template?: { sub?: { provider: string; model: string } | undefined; research?: { provider: string; model: string } | undefined } | undefined
  onBack: () => void
  onSaved: () => void
}) {
  const isNew = profile === undefined
  const ownership = useExtensionOwnership(isNew ? null : rpc)
  const [draft, setDraft] = useState<EditDraft>(() => isNew ? emptyDraft(template) : draftFromProfile(profile))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [skillBindOpen, setSkillBindOpen] = useState(false)
  const [mcpBindOpen, setMcpBindOpen] = useState(false)
  const [promptZoom, setPromptZoom] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  // 发布对话框开关（设计稿 P7/P8：footer 发布按钮 → PublishModuleDialog）。
  const [publishOpen, setPublishOpen] = useState(false)
  // 人格 / 提示词两处的 AI 润色（接宿主真实现，替代原 disabled 占位）。
  const { polish, polishing } = usePolishSetting(rpc)
  const { translate, translating } = useTranslateSetting(rpc)
  const sectionNav = useSectionNav()
  const developerMode = useDeveloperMode()
  const fileRef = useRef<HTMLInputElement | null>(null)
  // fork（corum）2026-09-29（用户裁决）：minimal 保持官方原汁原味 ⇒ 内置「极简模式」
  // (minimal-assistant) 的人格/提示词字段置灰、不可编辑（preset 编译时也会忽略它们）。
  // 仅该内置预设的 baseMode === 'minimal'（下拉已不提供 minimal 选项，故只此一径）。
  const isMinimalLocked = draft.baseMode === 'minimal'

  /**
   * 模型目录（`session/modelCatalog` 动态加载；失败用兜底静态目录）。
   *
   * ⚠️ 目录源必须是 **`session/modelCatalog`**（与 composer 模型选择器同源，**带
   * reasoning 元数据**），而不是 `corumAgent/listModels`（投影只有 `{id,name}`）
   * ——后者撑不起设计稿 v4 的「推理等级」第三列。
   * 兜底目录没有 reasoning ⇒ `reasoningByRoute` 为空对象 ⇒ 三档都保持两列，不白屏。
   */
  const [catalog, setCatalog] = useState<{
    providers: typeof FALLBACK_PROVIDERS
    modelsByProvider: Record<string, typeof FALLBACK_MODELS>
    reasoningByRoute: Record<string, ReasoningMeta>
  }>(
    { providers: FALLBACK_PROVIDERS, modelsByProvider: {}, reasoningByRoute: {} },
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await rpc<SessionCatalogResult>('session', 'modelCatalog', {})
        if (cancelled) return
        const groups = r.groups ?? []
        if (groups.length === 0) return
        const providers: typeof FALLBACK_PROVIDERS = []
        const modelsByProvider: Record<string, typeof FALLBACK_MODELS> = {}
        const reasoningByRoute: Record<string, ReasoningMeta> = {}
        for (const p of groups) {
          providers.push({ id: p.id, label: p.name !== undefined && p.name !== '' ? p.name : p.id })
          const models = (p.models ?? []).map(m => ({ id: m.id, label: m.name !== undefined && m.name !== '' ? m.name : m.id }))
          modelsByProvider[p.id] = models
          for (const m of p.models ?? []) {
            if (m.reasoning === undefined) continue
            // exactOptionalPropertyTypes：可选属性不能显式传 undefined，故条件展开。
            reasoningByRoute[`${p.id}/${m.id}`] = {
              efforts: (m.reasoning.efforts ?? []).map(e => ({
                id: e.id,
                name: e.name,
                ...(e.description === undefined ? {} : { description: e.description }),
              })),
              ...(m.reasoning.defaultEffort === undefined ? {} : { defaultEffort: m.reasoning.defaultEffort }),
            }
          }
        }
        setCatalog({ providers, modelsByProvider, reasoningByRoute })
      } catch {
        // 静默用兜底目录（不阻断编辑页；reasoningByRoute 保持为空 ⇒ 不显示推理等级列）。
      }
    })()
    return () => { cancelled = true }
  }, [rpc])

  const mainProviderOptions = catalog.providers
  const mainModelOptions = catalog.modelsByProvider[draft.provider] ?? FALLBACK_MODELS

  // 技能目录（skillManager/listAll）：技能卡 desc 行显示技能描述（设计稿 VttzW/a0RSk）。
  const [skillDescMap, setSkillDescMap] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await rpc<{ skills: Array<{ name: string; description: string }> }>('skillManager', 'listAll', {})
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const s of r.skills) map[s.name] = s.description
        setSkillDescMap(map)
      } catch {
        // 静默：无描述时技能卡 desc 退回版本号。
      }
    })()
    return () => { cancelled = true }
  }, [rpc])

  // MCP 服务器目录（mcpManager/listServers）：工具卡 desc 行显示服务描述（设计稿 V0OOkx/cMHCe）。
  const [mcpDescMap, setMcpDescMap] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await rpc<{ servers: Array<{ name: string; description?: string }> }>('mcpManager', 'listServers', {})
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const s of r.servers) map[s.name] = s.description ?? ''
        setMcpDescMap(map)
      } catch {
        // 静默：无描述时工具卡 desc 退回服务名。
      }
    })()
    return () => { cancelled = true }
  }, [rpc])
  const subProviderOptions = [SAME_AS_MAIN, FOLLOW_MAIN_OPTION, ...catalog.providers]
  const subModelOptions = draft.subMode === 'custom'
    ? [SAME_AS_MAIN, FOLLOW_MAIN_OPTION, ...(catalog.modelsByProvider[draft.subProvider] ?? FALLBACK_MODELS)]
    : [SAME_AS_MAIN, FOLLOW_MAIN_OPTION]
  // research 用自己的 provider 状态查模型表（旧实现复用 subModelOptions：当两档 provider
  // 不同时，research 的模型下拉会列出**子 Agent 那档**的模型 —— 一个既存的错配，
  // 顺手修正，避免"选出来的值不在候选里"）。
  const researchModelOptions = draft.researchMode === 'custom'
    ? [SAME_AS_MAIN, FOLLOW_MAIN_OPTION, ...(catalog.modelsByProvider[draft.researchProvider] ?? FALLBACK_MODELS)]
    : [SAME_AS_MAIN, FOLLOW_MAIN_OPTION]

  // 推理等级元数据（三档各自按当前「供应商/模型」路由查表）：无元数据 ⇒ 该档不渲染
  // 「推理等级」列，保持两列形态（设计稿 v4 + 参照 ModelPairField 的条件渲染语义）。
  const mainReasoning = catalog.reasoningByRoute[`${draft.provider}/${draft.model}`]
  const subReasoning = catalog.reasoningByRoute[`${draft.subProvider}/${draft.subModel}`]
  const researchReasoning = catalog.reasoningByRoute[`${draft.researchProvider}/${draft.researchModel}`]

  const set = <K extends keyof EditDraft>(k: K, v: EditDraft[K]) => setDraft(prev => ({ ...prev, [k]: v }))

  const handleAvatarFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file === undefined) return
    const reader = new FileReader()
    reader.onload = () => { if (typeof reader.result === 'string') set('avatar', reader.result) }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  // AI 生成头像（接通）：按岗位/昵称生成方形头像，走项目 text_to_image 图片 API。
  const [aiGenBusy, setAiGenBusy] = useState(false)
  const handleAiGenAvatar = () => {
    if (aiGenBusy) return
    setAiGenBusy(true)
    const subject = (draft.title || draft.nickname || draft.name || 'AI agent').trim()
    const prompt = encodeURIComponent(
      `minimalist flat vector avatar icon for an AI assistant, role: ${subject}, soft gradient glass style, centered, clean background, high quality`,
    )
    set('avatar', `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${prompt}&image_size=square`)
    setAiGenBusy(false)
  }

  const doSave = async () => {
    const id = draft.name.trim().toLowerCase().replace(/\s+/g, '-')
    if (id === '') { setError('预设 ID 不能为空'); return }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { setError('预设 ID 只能包含小写字母、数字、连字符'); return }
    setBusy(true)
    setError(null)
    try {
      await rpc('corumAgent', 'saveProfile', {
        input: {
          id,
          ...(draft.nickname.trim() !== '' ? { nickname: draft.nickname.trim() } : {}),
          ...(draft.title.trim() !== '' ? { title: draft.title.trim() } : {}),
          dimension: draft.dimension,
          ...(draft.experience.trim() !== '' ? { experience: draft.experience.trim() } : {}),
          personaPreset: draft.personaPreset,
          // 仅「自定义」写 persona 自由文本；内置预设由 host 端 PERSONA_PRESET_PROMPTS 解析。
          ...(draft.personaPreset === 'custom' && draft.personaCustom.trim() !== ''
            ? { persona: draft.personaCustom.trim() }
            : {}),
          ...(draft.avatar !== '' ? { avatar: draft.avatar } : {}),
          baseMode: draft.baseMode as EditDraft['baseMode'],
          prompt: draft.prompt,
          // 主 Agent 模型三元组：推理等级为空（默认档）时不展开该键。
          model: {
            provider: draft.provider,
            model: draft.model,
            ...(draft.mainEffort !== '' ? { reasoningEffort: draft.mainEffort } : {}),
          },
          // 自定义设置关闭时不覆盖系统统一设置：不写子/研究模型与并发键。
          // 三态（2026-10-11）：'custom' 写具体路由；'follow' 写 `'follow-main'` 哨兵；
          // 'inherit' **不写键**（= 不覆盖，走全局档）。三者不可混同——旧实现只有
          // 「写路由 / 不写键」两态，会把用户选的「显式跟随主 Agent」静默降级成「不覆盖」。
          ...(draft.customEnabled && draft.subMode !== 'inherit'
            ? { subagentModel: childModelPayloadOf(draft.subMode, draft.subProvider, draft.subModel, draft.subEffort) } : {}),
          ...(draft.customEnabled && draft.researchMode !== 'inherit'
            ? { researchModel: childModelPayloadOf(draft.researchMode, draft.researchProvider, draft.researchModel, draft.researchEffort) } : {}),
          ...buildParallelWork(draft),
          skills: draft.skills,
          mcpServers: draft.mcpServers,
          terminal: { mode: draft.terminal },
          // 记忆开关落 memoryPolicy.scope：开='agent'（专属记忆目录），关='none'。
          memoryPolicy: { scope: draft.memoryEnabled ? 'agent' : 'none' },
          // 开发者模式下编排的 Agent 固化为系统级预置（trust:'system'，不可删除）；
          // 非开发者模式新建为 user；已有 profile 保留原 trust。
          trust: developerMode ? 'system' : (isNew ? 'user' : draft.trust),
        },
      })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    if (profile === undefined) return
    setBusy(true)
    try {
      await rpc('corumAgent', 'deleteProfile', { id: profile.id })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Esc 缩小（设计稿 sBqOd：「Esc 缩小 · ⌘Z 撤销润色」）。
  // ⚠️ 必须用 capture 阶段：设置壳 dialog 的 bubble 阶段 Esc 处理器会关闭整个设置弹窗，
  //    capture 阶段先拿到事件并 stopPropagation，Esc 只缩小、不冒泡到壳。
  useEffect(() => {
    if (!promptZoom) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      setPromptZoom(false)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [promptZoom])

  // 提示词放大态（设计稿 sBqOd：单栏铺满内容区 — zoom-hd + big-area + hint）
  if (promptZoom) {
    return (
      <div className={css.promptZoomCol}>
        <div className={css.promptZoomHd}>
          <span className={css.promptZoomTitle}>提示词</span>
          <div className={css.promptZoomActions}>
            <button
              type="button"
              className={css.btnPolish}
              disabled={polishing || draft.prompt.trim() === ''}
              title={draft.prompt.trim() === '' ? '先填写提示词' : '用润色模型改写这段提示词'}
              onClick={() => {
                void polish(draft.prompt).then(next => { if (next !== null) set('prompt', next) })
              }}
            >
              <Sparkles size={11} />{polishing ? '润色中…' : 'AI 润色'}
            </button>
            <button type="button" className={css.btnGhost} onClick={() => setPromptZoom(false)}><Minimize2 size={12} />缩小</button>
          </div>
        </div>
        <div className={css.promptZoomArea}>
          <textarea
            className={css.promptZoomTextarea}
            value={draft.prompt}
            onChange={e => set('prompt', e.target.value)}
            placeholder="你是研发工程师。接到任务后简洁完成并调用 complete_task 上报。"
          />
        </div>
        <p className={css.hintText}>Esc 缩小 · ⌘Z 撤销润色</p>
      </div>
    )
  }

  // ⚠️ 2026-10-11 修（台账 ui.agent-presets.preview.persona-field-inert）：这里原先读
  // 一个**已删的 `draft.persona` 副本**——用户输入只写 `draft.personaCustom`（见人格输入框），
  // 那个副本只在回填时被赋值一次、此后**永不更新** ⇒ 预览恒显示旧值，用户新填的人格不出现。
  //
  // 现在与**保存**逐字同源（保存那条见 `doSave` 的 `personaPreset === 'custom' &&
  // personaCustom.trim() !== ''`），保证「预览 == 将要落盘的值」。刻意**不**在非 custom 时
  // 回落到那个副本：那会让预览显示一个保存时会被丢弃的值，等于把「不一致」换个方向。
  // 这是一条「同一事实两个字段、只有一个权威」的隐患；此前无人察觉是因为 `AgentCard`
  // 不渲染 persona，一旦有人让它渲染就会当场表现为「预览与保存不一致」。
  const previewProfile: AgentProfileSummary = {
    id: draft.name || 'new-agent',
    ...(draft.nickname !== '' ? { nickname: draft.nickname } : {}),
    ...(draft.title !== '' ? { title: draft.title } : {}),
    ...(draft.dimension !== '' ? { dimension: draft.dimension } : {}),
    ...(draft.experience !== '' ? { experience: draft.experience } : {}),
    ...(draft.personaPreset === 'custom' && draft.personaCustom.trim() !== ''
      ? { persona: draft.personaCustom.trim() }
      : {}),
    ...(draft.avatar !== '' ? { avatar: draft.avatar } : {}),
    prompt: draft.prompt,
    model: { provider: draft.provider, model: draft.model },
    skills: draft.skills,
    mcpServers: draft.mcpServers,
    terminal: { mode: draft.terminal },
    version: 1,
    trust: draft.trust,
    source: 'corum',
  }

  return (
    // 整页统一滚动（顶部一排 + 下方表单同处一个滚动流，操作体验优于局部滚动）。
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: '100%', height: '100%', minHeight: 0, overflowY: 'auto' }}>
      {/* 返回行（设计稿 GHBvv KLRxp：纯文本幽灵行，非按钮） */}
      <button type="button" className={css.backRowGhost} onClick={onBack}>
        <ChevronLeft size={14} />返回 Agent 预设
      </button>

      {/* 顶部一排：基本信息（左）+ 名片预览（右） */}
      <div style={{ display: 'flex', gap: 20, width: '100%' }}>
        {/* 左：基本信息（设计稿 GHBvv basicCol: gap 4 + avatarRow gap 18，纵向居中） */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className={css.formGroupTitle}>基本信息</div>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
            {/* avatarCol：88 头像 + AI 生成钮 + 上传提示（纵向 gap 4，居中；AI 生成接通） */}
            <div className={css.avatarBlock}>
              <div className={css.avatarBox} onClick={() => fileRef.current?.click()} role="button">
                {draft.avatar !== ''
                  ? <img className={css.agentAvatarImg} src={draft.avatar} alt="" />
                  : <Upload size={32} className={css.avatarIcon} />}
              </div>
              <button type="button" className={css.btnAiGen} onClick={handleAiGenAvatar}>
                <Sparkles size={12} className={css.btnPolishIcon} />AI 生成
              </button>
              <span className={css.avatarHint}>点击上传头像</span>
            </div>
            {/* fieldsBlock：两列字段（组内 gap 14，纵向居中） */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14, justifyContent: 'center' }}>
              <div className={css.formCols}>
                <div className={css.formCol} style={{ gap: 4 }}>
                  <label className={css.fieldLabelSm}>预设 ID</label>
                  <input className={css.fieldInputSm} value={draft.name} onChange={e => set('name', e.target.value)} placeholder="my-agent" disabled={!isNew} />
                </div>
                <div className={css.formCol} style={{ gap: 4 }}>
                  <label className={css.fieldLabelSm}>昵称</label>
                  <input className={css.fieldInputSm} value={draft.nickname} onChange={e => set('nickname', e.target.value)} placeholder="我的 Agent" />
                </div>
              </div>
              <div className={css.formCols}>
                <div className={css.formCol} style={{ gap: 4 }}>
                  <label className={css.fieldLabelSm}>岗位 / 职位</label>
                  <input className={css.fieldInputSm} value={draft.title} onChange={e => set('title', e.target.value)} placeholder="如：前端工程师 / 测试 / PM" />
                </div>
                <div className={css.formCol} style={{ gap: 4 }}>
                  <label className={css.fieldLabelSm}>岗位维度（名片筛选）</label>
                  <SelectField value={draft.dimension} options={DIMENSION_OPTIONS} onChange={v => set('dimension', v)} variant="fill" />
                </div>
              </div>
              {/* 2026-09-16 用户定调：「专业领域」条目过时，全面移除（含数据与代码）——
                  它实际只进存储、不进 persona 组装（compile.ts 用的是 title；UI 注释
                  「组装进 persona」不实），仅名片/技术栈映射用的自由文本。 */}
              {/* 来源（P5d）：已有预设标 provenance，扩展包拥有的标「扩展包 · <pack>」，
                  其余保留既有口径「用户创建」。新建预设不显示（尚无 profileId）。 */}
              {!isNew && profile !== undefined && (
                <div className={css.formCols}>
                  <div className={css.formCol} style={{ gap: 4 }}>
                    <label className={css.fieldLabelSm}>来源</label>
                    <span className={css.fieldInputSm} style={{ display: 'flex', alignItems: 'center' }}>
                      {provenanceLabel(ownership.ownerOf('presets', profile.id), '用户创建')}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarFile} />
        </div>

        {/* 右：名片预览（设计稿 prevCol: width 280, gap 4；预览卡 chev enabled:false，隐藏箭头） */}
        <div style={{ flex: 'none', width: 280, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className={css.formGroupTitle}>名片预览</div>
          <AgentCard profile={previewProfile} onClick={() => {}} hideChevron />
        </div>
      </div>

      {/* 下方单一纵向表单列（设计稿 v4 formCol: gap 4；整页滚动流，不再局部滚动）。
          顺序 = 设计稿 v4 formCol.children：继承(仅开发者) → 工作经验 → 人格 → 提示词 →
          技能/工具 → 终端/记忆 → 模型与并发(页面最下方·默认折叠) → 页脚。 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
        {/* 继承自（设计稿 GHBvv g-inherit：仅开发者模式显示；非开发者模式固定
            继承标准模式并覆盖其 persona，不展示该选项） */}
        {developerMode && (
          <div className={css.formGroup} style={{ gap: 3 }}>
            <label className={css.fieldLabel}>继承自</label>
            <SelectField value={draft.baseMode} options={BASE_MODE_OPTIONS} onChange={v => set('baseMode', v)} variant="fill" disabled={isMinimalLocked} />
            <p className={css.fieldHint}>
              {draft.baseMode === 'standard'
                ? '标准模式将覆盖官方身份模板，使用你的人格与提示词'
                : `将继承「${baseModeLabel(draft.baseMode)}」的系统提示词与 persona`}
            </p>
          </div>
        )}

        {/* 工作经验（设计稿 GHBvv g-exp F73NUB：只读，基于 Agent 记忆自动总结；
            后续在「记忆管理」中维护，此处不可编辑） */}
        <div className={css.formGroup} style={{ gap: 3 }}>
          <div className={css.formGroupTitle}>工作经验</div>
          <div className={css.expReadBox}>
            <span className={css.expReadText}>{draft.experience || '暂无记忆摘要。'}</span>
          </div>
          <div className={css.expNoteRow}>
            <Lock size={11} className={css.expNoteIcon} />
            <span className={css.expNoteText}>基于 Agent 记忆自动总结 · 不可编辑</span>
          </div>
        </div>

        {/* 人格设置（设计稿 v4 g-persona：300 宽预设下拉 + smile icon + 右侧说明；
            选「自定义」时下方展开单行输入（≤20 字）+ 计数 + 底部说明） */}
        <div className={css.formGroup} style={{ gap: 3 }}>
          <div className={css.formGroupTitle}>人格设置</div>
          <div className={css.personaRow}>
            <div className={css.personaTriggerWrap}>
              <Smile size={14} className={css.personaTriggerIcon} />
              <SelectField
                value={draft.personaPreset}
                options={PERSONA_PRESET_OPTIONS}
                onChange={v => set('personaPreset', v)}
                variant="fill"
                disabled={isMinimalLocked}
              />
            </div>
            <span className={css.personaCap}>
              决定该 Agent 的沟通风格与行为倾向；可选内置预设，或自定义人格名称
            </span>
          </div>
          {draft.personaPreset === 'custom' && (
            <div className={css.personaCustomCol}>
              <div className={css.personaCustomInput}>
                <input
                  className={css.personaCustomField}
                  value={draft.personaCustom}
                  placeholder="例如：复盘驱动型"
                  maxLength={PERSONA_CUSTOM_MAX}
                  disabled={isMinimalLocked}
                  onChange={e => set('personaCustom', e.target.value.slice(0, PERSONA_CUSTOM_MAX))}
                />
                <span className={css.personaCustomCount}>{draft.personaCustom.length} / {PERSONA_CUSTOM_MAX}</span>
              </div>
              <div className={css.personaCustomNoteRow}>
                <Info size={11} className={css.personaCustomNoteIcon} />
                <span className={css.personaCustomNote}>自定义人格名称，最多 {PERSONA_CUSTOM_MAX} 个字符，用于生成该 Agent 的行为描述</span>
              </div>
            </div>
          )}
          {isMinimalLocked && (
            <p className={css.fieldHint}>极简模式保持官方原样，不支持设置人格与自定义提示词。</p>
          )}
        </div>

        {/* 提示词（设计稿 GHBvv g-prompt：放大钮为 ghost 小钮；AI 润色在文本域内底部行） */}
        <div className={css.formGroup}>
          <div className={css.formGroupTitleRow}>
            <span className={css.formGroupTitle}>提示词</span>
            <button type="button" className={css.btnGhost} onClick={() => setPromptZoom(true)}><Maximize2 size={12} />放大</button>
          </div>
          <label className={css.fieldLabel}>自定义提示词（叠加在基础模式 persona 之上，非替代）</label>
          <div className={css.promptArea}>
            <textarea className={css.promptTextarea} value={draft.prompt} onChange={e => set('prompt', e.target.value)} placeholder="你是研发工程师。接到任务后简洁完成并调用 complete_task 上报。" rows={3} disabled={isMinimalLocked} />
            <div className={css.promptActionsRow}>
              <button
                type="button"
                className={css.btnPolish}
                disabled={isMinimalLocked || polishing || draft.prompt.trim() === ''}
                title={draft.prompt.trim() === '' ? '先填写提示词' : '用润色模型改写这段提示词'}
                onClick={() => {
                  void polish(draft.prompt).then(next => { if (next !== null) set('prompt', next) })
                }}
              >
                <Sparkles size={11} className={css.btnPolishIcon} />{polishing ? '润色中…' : 'AI 润色'}
              </button>
              {/* 「AI 翻译」（2026-09-16 用户定调：翻译是给预设 Agent 提示词用的）——
                  中英互译自动判向，与「AI 润色」同位（提示词文本域内底部行）。 */}
              <button
                type="button"
                className={css.btnPolish}
                disabled={isMinimalLocked || translating || draft.prompt.trim() === ''}
                title={draft.prompt.trim() === '' ? '先填写提示词' : '中英互译这段提示词（自动判向）'}
                onClick={() => {
                  void translate(draft.prompt).then(next => { if (next !== null) set('prompt', next) })
                }}
              >
                <Languages size={11} className={css.btnPolishIcon} />{translating ? '翻译中…' : 'AI 翻译'}
              </button>
            </div>
          </div>
          {isMinimalLocked && (
            <p className={css.fieldHint}>极简模式保持官方原样，不支持设置人格与自定义提示词。</p>
          )}
        </div>

        {/* 技能 + 工具（设计稿 GHBvv g-skill-mcp：双列各「2 卡网格 + 添加钮」，
            卡片 = icon+name(+tag) / ver+del 头行 + desc 行；右列标题「工具配置」） */}
        <div className={css.formColsStretch}>
          <div className={css.formCol} style={{ gap: 4 }}>
            <div className={css.formGroupTitle}>技能配置</div>
            <div className={css.skillCardGrid}>
              {draft.skills.slice(0, 2).map((s, i) => (
                <div key={`${s.name}-${i}`} className={css.skillCard}>
                  <div className={css.skillCardTop}>
                    <div className={css.skillCardLeft}>
                      {skillIcon(s.name, 13, css.skillCardIcon)}
                      <span className={css.skillCardName}>{s.name}</span>
                    </div>
                    <div className={css.skillCardRight}>
                      <span className={css.skillCardVer}>{s.versionId}</span>
                      <Trash2 size={12} className={css.listDel} onClick={() => set('skills', draft.skills.filter((_, idx) => idx !== i))} />
                    </div>
                  </div>
                  <span className={css.skillCardDesc}>{skillDescMap[s.name] || `绑定版本 ${s.versionId}`}</span>
                </div>
              ))}
              {draft.skills.length === 1 && <div className={css.skillCardPlaceholder} />}
            </div>
            <button type="button" className={css.btnAdd} onClick={() => setSkillBindOpen(true)}><Plus size={12} />添加技能</button>
          </div>
          <div className={css.formCol} style={{ gap: 4 }}>
            <div className={css.formGroupTitle}>MCP 配置</div>
            <div className={css.skillCardGrid}>
              {draft.mcpServers.slice(0, 2).map((s, i) => (
                <div key={`${s}-${i}`} className={css.skillCard}>
                  <div className={css.skillCardTop}>
                    <div className={css.skillCardLeft}>
                      {toolIcon(s, 13, css.skillCardIcon)}
                      <span className={css.skillCardName}>{s}</span>
                      <span className={css.skillCardTag}>MCP</span>
                    </div>
                    <div className={css.skillCardRight}>
                      <Trash2 size={12} className={css.listDel} onClick={() => set('mcpServers', draft.mcpServers.filter((_, idx) => idx !== i))} />
                    </div>
                  </div>
                  <span className={css.skillCardDesc}>{mcpDescMap[s] || s}</span>
                </div>
              ))}
              {draft.mcpServers.length === 1 && <div className={css.skillCardPlaceholder} />}
            </div>
            <button type="button" className={css.btnAdd} onClick={() => setMcpBindOpen(true)}><Plus size={12} />添加 MCP</button>
          </div>
        </div>

        {/* 终端 + 记忆（设计稿 GHBvv g-misc：终端模式 sel + 记忆功能 field(「默认关闭」+switch)） */}
        <div className={css.formColsStretch}>
          <div className={css.formCol} style={{ gap: 3 }}>
            <label className={css.fieldLabelSm}>终端模式</label>
            <SelectField value={draft.terminal} options={TERMINAL_OPTIONS} onChange={v => set('terminal', v as 'sandbox' | 'host')} variant="fill" />
          </div>
          <div className={css.formCol} style={{ gap: 3 }}>
            <label className={css.fieldLabelSm}>记忆功能</label>
            <div className={css.memoryField}>
              <span className={css.memoryState}>{draft.memoryEnabled ? '已开启' : '默认关闭'}</span>
              <Switch checked={draft.memoryEnabled} onChange={v => set('memoryEnabled', v)} />
            </div>
          </div>
        </div>

        {error !== null && <p className={css.hintText}>{error}</p>}

        {/* 模型与并发（设计稿 v4 card-模型与并发：页面最下方、**默认折叠**；
            自定义设置默认关闭 = 跟随系统统一设置；开启后展开三档模型 + 并发数覆盖） */}
        <div className={css.mcpCard}>
          <button
            type="button"
            className={css.modelCardHead}
            onClick={() => set('modelCardExpanded', !draft.modelCardExpanded)}
          >
            <span className={css.modelCardHeadLeft}>
              <span className={css.modelCardTitle}>模型与并发</span>
              <span className={draft.customEnabled ? css.modelCardTipActive : css.modelCardTip}>
                {draft.customEnabled ? '本预设的执行模型与并发策略 · 已自定义' : '本预设的执行模型与并发策略 · 跟随系统'}
              </span>
            </span>
            {draft.modelCardExpanded
              ? <ChevronUp size={14} className={css.modelCardChev} />
              : <ChevronDown size={14} className={css.modelCardChev} />}
          </button>

          <div className={css.modelCardOverride}>
            <span className={css.modelCardOverrideLeft}>
              <span className={css.modelCardOverrideTitle}>自定义设置</span>
              <span className={css.modelCardOverrideHint}>
                {draft.customEnabled ? '已覆盖系统统一设置（模型 / 并发）' : '开启后可覆盖系统统一设置（模型 / 并发）'}
              </span>
            </span>
            <Switch checked={draft.customEnabled} onChange={v => set('customEnabled', v)} />
          </div>

          {draft.modelCardExpanded && (
            <>
              <div className={css.modelCardDivider} />

              {/* 三档执行模型（关闭自定义时只读）；「推理等级」列按当前路由有无
                  reasoning 元数据条件渲染（无元数据 = 保持两列，见 mainReasoning 等）。
                  三档纵向堆叠（设计稿 dZDmd）：每档独占一行，行内仍为横排三列。 */}
              <div className={css.formColsVertical}>
                <div className={css.formCol} style={{ gap: 4 }}>
                  <label className={css.fieldLabelSm}>主 Agent 模型</label>
                  <div className={css.selectStack}>
                    <div className={css.formCol} style={{ gap: 3 }}>
                      <label className={css.fieldLabelSm}>供应商</label>
                      <SelectField
                        value={draft.provider}
                        options={mainProviderOptions}
                        // 联动：provider 变更后原模型若不在新目录里则回落兜底列表；
                        // 推理等级一律重置为默认档（新模型的档位未必兼容）。
                        onChange={v => { set('provider', v); set('mainEffort', '') }}
                        disabled={!draft.customEnabled}
                        variant="fill"
                      />
                    </div>
                    <div className={css.formCol} style={{ gap: 3 }}>
                      <label className={css.fieldLabelSm}>模型</label>
                      <SelectField
                        value={draft.model}
                        options={mainModelOptions}
                        onChange={v => { set('model', v); set('mainEffort', '') }}
                        disabled={!draft.customEnabled}
                        variant="fill"
                      />
                    </div>
                    {mainReasoning !== undefined && (
                      <div className={css.formCol} style={{ gap: 3 }}>
                        <label className={css.fieldLabelSm}>推理等级</label>
                        <SelectField value={draft.mainEffort} options={effortOptionsOf(mainReasoning)} onChange={v => set('mainEffort', v)} disabled={!draft.customEnabled} variant="fill" />
                      </div>
                    )}
                  </div>
                </div>
                <div className={css.formCol} style={{ gap: 4 }}>
                  <label className={css.fieldLabelSm}>子 Agent 模型（不配则用全局；全局也没配才同主 Agent）</label>
                  <div className={css.selectStack}>
                    <div className={css.formCol} style={{ gap: 3 }}>
                      <label className={css.fieldLabelSm}>供应商</label>
                      {/* 三态合一的选择：'' = 不覆盖（继承全局）；'follow-main' = 显式跟随
                          主 Agent；其余 = 具体供应商。用同一个 Select 表达三态，避免再引入
                          一个开关控件（也就不会再出现"开关与选择不一致"的状态组合）。 */}
                      <SelectField
                        value={draft.subMode === 'custom' ? draft.subProvider : draft.subMode === 'follow' ? 'follow-main' : ''}
                        options={subProviderOptions}
                        onChange={v => {
                          if (v === '') { set('subMode', 'inherit'); return }
                          if (v === 'follow-main') { set('subMode', 'follow'); return }
                          set('subMode', 'custom'); set('subProvider', v); set('subEffort', '')
                        }}
                        disabled={!draft.customEnabled}
                        variant="fill"
                      />
                    </div>
                    <div className={css.formCol} style={{ gap: 3 }}>
                      <label className={css.fieldLabelSm}>模型</label>
                      <SelectField
                        value={draft.subMode === 'custom' ? draft.subModel : draft.subMode === 'follow' ? 'follow-main' : ''}
                        options={subModelOptions}
                        onChange={v => {
                          if (v === '') { set('subMode', 'inherit'); return }
                          if (v === 'follow-main') { set('subMode', 'follow'); return }
                          set('subMode', 'custom'); set('subModel', v); set('subEffort', '')
                        }}
                        disabled={!draft.customEnabled || draft.subMode !== 'custom'}
                        variant="fill"
                      />
                    </div>
                    {subReasoning !== undefined && (
                      <div className={css.formCol} style={{ gap: 3 }}>
                        <label className={css.fieldLabelSm}>推理等级</label>
                        <SelectField value={draft.subEffort} options={effortOptionsOf(subReasoning)} onChange={v => set('subEffort', v)} disabled={!draft.customEnabled || draft.subMode !== 'custom'} variant="fill" />
                      </div>
                    )}
                  </div>
                </div>
                <div className={css.formCol} style={{ gap: 4 }}>
                  <label className={css.fieldLabelSm}>调查 Agent 模型（缺省同子 Agent）</label>
                  <div className={css.selectStack}>
                    <div className={css.formCol} style={{ gap: 3 }}>
                      <label className={css.fieldLabelSm}>供应商</label>
                      {/* 三态同子 Agent 项：'' = 不覆盖（回落子 Agent 项的全局默认）；
                          'follow-main' = 显式跟随主 Agent（跳过全局档）；其余 = 具体供应商。 */}
                      <SelectField
                        value={draft.researchMode === 'custom' ? draft.researchProvider : draft.researchMode === 'follow' ? 'follow-main' : ''}
                        options={subProviderOptions}
                        onChange={v => {
                          if (v === '') { set('researchMode', 'inherit'); return }
                          if (v === 'follow-main') { set('researchMode', 'follow'); return }
                          set('researchMode', 'custom'); set('researchProvider', v); set('researchEffort', '')
                        }}
                        disabled={!draft.customEnabled}
                        variant="fill"
                      />
                    </div>
                    <div className={css.formCol} style={{ gap: 3 }}>
                      <label className={css.fieldLabelSm}>模型</label>
                      <SelectField
                        value={draft.researchMode === 'custom' ? draft.researchModel : draft.researchMode === 'follow' ? 'follow-main' : ''}
                        options={researchModelOptions}
                        onChange={v => {
                          if (v === '') { set('researchMode', 'inherit'); return }
                          if (v === 'follow-main') { set('researchMode', 'follow'); return }
                          set('researchMode', 'custom'); set('researchModel', v); set('researchEffort', '')
                        }}
                        disabled={!draft.customEnabled || draft.researchMode !== 'custom'}
                        variant="fill"
                      />
                    </div>
                    {researchReasoning !== undefined && (
                      <div className={css.formCol} style={{ gap: 3 }}>
                        <label className={css.fieldLabelSm}>推理等级</label>
                        <SelectField value={draft.researchEffort} options={effortOptionsOf(researchReasoning)} onChange={v => set('researchEffort', v)} disabled={!draft.customEnabled || draft.researchMode !== 'custom'} variant="fill" />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* 子 Agent 并发数（− [n] ＋ 步进器） */}
              <div className={css.formCol} style={{ gap: 4 }}>
                <label className={css.fieldLabelSm}>子 Agent 并发数</label>
                <div className={css.stepperRow}>
                  <button
                    type="button"
                    className={css.stepperBtn}
                    disabled={!draft.customEnabled}
                    onClick={() => set('maxParallel', String(Math.max(1, (Number.parseInt(draft.maxParallel, 10) || 4) - 1)))}
                  ><Minus size={13} /></button>
                  <span className={css.stepperValue}>{draft.maxParallel.trim() === '' ? '4' : draft.maxParallel}</span>
                  <button
                    type="button"
                    className={css.stepperBtn}
                    disabled={!draft.customEnabled}
                    onClick={() => set('maxParallel', String(Math.min(8, (Number.parseInt(draft.maxParallel, 10) || 4) + 1)))}
                  ><Plus size={13} /></button>
                  <span className={css.stepperHint}>同时运行的最大子 Agent 数（1–8）</span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* footer（设计稿 GHBvv footer s8r0w：左 信任级 badge + 记忆管理(brain)，
            右 删除(error)/取消/保存；删除走内联二次确认弹窗 confirm-pop）
            P5d：pack-owned 预设禁用删除（只能整包卸载），title 引导到 集成中心 › 扩展包。 */}
        <div className={css.formGroup} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, position: 'relative' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className={css.trustLabel}>信任级</span>
            <span className={css.trustBadge}>{draft.trust}</span>
            {sectionNav !== null && (
              <button type="button" className={css.btnMemoryNav} onClick={() => sectionNav.openSection('memory')}>
                <Brain size={14} className={css.btnMemoryNavIcon} />记忆管理
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* 发布为模块（设计稿 P7/P8：footer 第一个位置，与删除/取消/保存同排）。
                仅已有预设（非新建）可发布——新建未保存，无 profileId。
                打开 PublishModuleDialog（配置 + 完成两屏，闸门逻辑见行为规格 §5）。 */}
            {!isNew && (
              <button type="button" className={css.btnPublish} onClick={() => setPublishOpen(true)} disabled={busy}>
                <Package size={13} className={css.btnIconLeft} />发布
              </button>
            )}
            {/* 系统级预置 Agent（trust:'system'）不可删除，隐藏删除钮。
                pack-owned 预设禁用删除（只能整包卸载），title 引导到 集成中心 › 扩展包。 */}
            {!isNew && draft.trust !== 'system' && (() => {
              const packOwner = profile !== undefined ? ownership.ownerOf('presets', profile.id) : null
              return (
                <button
                  type="button"
                  className={css.btnDeleteGhost}
                  onClick={() => setConfirmDel(true)}
                  disabled={busy || packOwner !== null}
                  title={packOwner !== null ? packOwnedTitle(packOwner) : undefined}
                >
                  <Trash2 size={13} className={css.btnDeleteIcon} />删除
                </button>
              )
            })()}
            <GlassButton onClick={onBack}>取消</GlassButton>
            <GlassButton variant="primary" onClick={() => void doSave()} disabled={busy}>{busy ? '保存中…' : isNew ? '创建' : '保存'}</GlassButton>
          </div>

          {/* 内联二次确认（统一确认框 inline 形态，设计稿 DKRwC confirm-pop） */}
          {confirmDel && profile !== undefined && (
            <ConfirmDialog
              placement="inline"
              title="删除该预设？"
              message="预设删除后不可恢复，此操作需要二次确认。"
              confirmLabel="确认删除"
              busy={busy}
              onConfirm={() => { setConfirmDel(false); void doDelete() }}
              onCancel={() => setConfirmDel(false)}
            />
          )}
        </div>
      </div>

      {/* 弹窗 */}
      {skillBindOpen && (
        <SkillBindDialog
          rpc={rpc}
          bound={draft.skills}
          onClose={() => setSkillBindOpen(false)}
          onConfirm={skills => { set('skills', skills); setSkillBindOpen(false) }}
        />
      )}
      {mcpBindOpen && (
        <McpBindDialog
          rpc={rpc}
          bound={draft.mcpServers}
          onClose={() => setMcpBindOpen(false)}
          onConfirm={servers => { set('mcpServers', servers); setMcpBindOpen(false) }}
        />
      )}
      {/* 发布对话框（设计稿 P7 配置屏 + P8 完成屏；闸门逻辑见行为规格 §5） */}
      {publishOpen && profile !== undefined && (
        <PublishModuleDialog
          rpc={rpc}
          profileId={profile.id}
          profileName={profile.nickname ?? profile.id}
          onClose={() => setPublishOpen(false)}
        />
      )}
    </div>
  )
}

/* ── 技能绑定弹窗（设计稿 ExxZt）─────────────────────────────────────── */

function SkillBindDialog({ rpc, bound, onClose, onConfirm }: {
  rpc: CorumRpcCall
  bound: SkillBinding[]
  onClose: () => void
  onConfirm: (skills: SkillBinding[]) => void
}) {
  const [allSkills, setAllSkills] = useState<SkillInfo[] | null>(null)
  const [versionsMap, setVersionsMap] = useState<Record<string, SkillVersion[]>>({})
  const [checked, setChecked] = useState<Map<string, string>>(() => new Map(bound.map(b => [b.name, b.versionId])))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const r = await rpc<{ skills: SkillInfo[] }>('skillManager', 'listAll', {})
        if (cancelled) return
        setAllSkills(r.skills)
        // 拉取每个技能的版本列表
        const entries = await Promise.all(r.skills.map(async s => {
          const h = await rpc<{ versions: SkillVersion[] }>('skillManager', 'getSkillHistory', { name: s.name })
          return [s.name, h.versions] as const
        }))
        if (cancelled) return
        const map: Record<string, SkillVersion[]> = {}
        for (const [name, versions] of entries) map[name] = versions
        setVersionsMap(map)
        setLoading(false)
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false) }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [rpc])

  const toggle = (name: string) => {
    setChecked(prev => {
      const next = new Map(prev)
      if (next.has(name)) next.delete(name)
      else {
        const versions = versionsMap[name] ?? []
        next.set(name, versions[versions.length - 1]?.id ?? '')
      }
      return next
    })
  }

  const setVersion = (name: string, versionId: string) => {
    setChecked(prev => new Map(prev).set(name, versionId))
  }

  const doConfirm = () => {
    const result: SkillBinding[] = [...checked.entries()]
      .filter(([, v]) => v !== '')
      .map(([name, versionId]) => ({ name, versionId }))
    onConfirm(result)
  }

  return createPortal(
    <div className={css.modalOverlay} onClick={onClose}>
      <div className={css.modalDialog} onClick={e => e.stopPropagation()} style={{ width: 480 }}>
        <div className={css.modalHeader}>
          <span className={css.modalTitle}>添加技能</span>
          <button type="button" className={css.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={css.modalBody}>
          <p className={css.hintText}>从全局技能库选择技能并绑定版本；一个 Agent 可绑定多个技能。</p>
          {error !== null && <p className={css.hintText}>{error}</p>}
          {loading && <p className={css.hintText}>加载中…</p>}
          {!loading && allSkills !== null && allSkills.length === 0 && (
            <p className={css.hintText}>暂无技能，请先在「技能」页导入。</p>
          )}
          {(allSkills ?? []).map(s => {
            const isChecked = checked.has(s.name)
            const versions = versionsMap[s.name] ?? []
            // 设计稿 ExxZt：未选中行也显示版本选择器（dimmed 禁用态，值为最新版）
            const latest = versions[versions.length - 1]?.id ?? ''
            const displayVersion = isChecked ? (checked.get(s.name) ?? latest) : latest
            return (
              <div
                key={s.name}
                className={`${css.bindPickRow}${isChecked ? ' ' + css.bindPickRowActive : ''}`}
                onClick={() => toggle(s.name)}
                role="button"
              >
                <span className={`${css.bindCheckbox}${isChecked ? ' ' + css.bindCheckboxOn : ''}`}>
                  {isChecked && <Check size={10} className={css.bindCheckIcon} />}
                </span>
                <div className={css.bindPickMeta}>
                  <div className={css.bindPickName}>
                    <Star size={12} className={css.listIcon} />
                    <span className={css.skillLabel}>{s.name}</span>
                  </div>
                  <span className={css.bindPickDesc}>{s.description}</span>
                </div>
                {versions.length > 0 && (
                  <span
                    className={isChecked ? undefined : css.bindVersionDim}
                    onClick={e => e.stopPropagation()}
                  >
                    <SelectField
                      value={displayVersion}
                      options={versions.map(v => ({ id: v.id, label: v.id }))}
                      onChange={v => setVersion(s.name, v)}
                      disabled={!isChecked}
                      variant="compact"
                    />
                  </span>
                )}
              </div>
            )
          })}
        </div>
        <div className={css.modalFooter}>
          <div className={css.footerLeft} />
          <div className={css.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            <GlassButton variant="primary" onClick={doConfirm}>绑定 {checked.size} 个技能</GlassButton>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ── MCP 绑定弹窗（设计稿 hMLsO）─────────────────────────────────────── */


function McpBindDialog({ rpc, bound, onClose, onConfirm }: {
  rpc: CorumRpcCall
  bound: string[]
  onClose: () => void
  onConfirm: (servers: string[]) => void
}) {
  const [servers, setServers] = useState<McpServerSummaryWire[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(() => new Set(bound))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const r = await rpc<{ servers: McpServerSummaryWire[] }>('mcpManager', 'listServers', {})
        if (!cancelled) { setServers(r.servers); setLoading(false) }
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false) }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [rpc])

  const toggle = (name: string) => {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }

  return createPortal(
    <div className={css.modalOverlay} onClick={onClose}>
      <div className={css.modalDialog} onClick={e => e.stopPropagation()} style={{ width: 480 }}>
        <div className={css.modalHeader}>
          <span className={css.modalTitle}>添加 MCP 服务</span>
          <button type="button" className={css.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={css.modalBody}>
          <p className={css.hintText}>从全局 MCP 注册表选择服务授权给此 Agent；新服务请在「MCP 与集成」中注册。</p>
          {error !== null && <p className={css.hintText}>{error}</p>}
          {loading && <p className={css.hintText}>加载中…</p>}
          {!loading && servers !== null && servers.length === 0 && (
            <p className={css.hintText}>暂无 MCP 服务，请先在「MCP 与集成」中添加。</p>
          )}
          {(servers ?? []).map(s => {
            const isChecked = checked.has(s.name)
            const disabled = s.disabled === true
            return (
              <div
                key={s.name}
                className={`${css.bindPickRow}${isChecked ? ' ' + css.bindPickRowActive : ''}`}
                onClick={() => toggle(s.name)}
                role="button"
              >
                <span className={`${css.bindCheckbox}${isChecked ? ' ' + css.bindCheckboxOn : ''}`}>
                  {isChecked && <Check size={10} className={css.bindCheckIcon} />}
                </span>
                <div className={css.bindPickMeta}>
                  <div className={css.bindPickName}>
                    <span className={css.listDot} style={disabled ? { background: 'var(--dsw-alias-label-dimmed)' } : undefined} />
                    <span className={css.skillLabel}>{s.name}</span>
                  </div>
                  <span className={css.bindPickDesc}>{s.description ?? s.transport}{disabled ? ' · 已停用' : ''}</span>
                </div>
              </div>
            )
          })}
        </div>
        <div className={css.modalFooter}>
          <div className={css.footerLeft} />
          <div className={css.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            <GlassButton variant="primary" onClick={() => onConfirm([...checked])}>授权 {checked.size} 个服务</GlassButton>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
