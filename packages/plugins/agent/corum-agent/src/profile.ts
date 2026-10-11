/**
 * AgentProfile 数据模型：corum 跨项目、可复用的 Agent 配置单元。
 *
 * 对应 PRD §4.0.2 的六项：
 *   prompt / model / skills / mcpServers / terminal / memoryPolicy
 * 加上 version / trust（快照隔离 / 信任级）。
 *
 * 存储：`~/.corum/.agent-presets/<id>/agent.json`。
 *
 * MCP 服务采用全局注册表 + 授权引用：
 *   agent.json 的 mcpServers 字段记录 string[]（授权的服务名列表），
 *   编译 preset 时从 ~/.corum/mcp-servers.json 读取完整配置。
 *
 * Skill 采用引用绑定 + 版本 pinning：
 *   agent.json 的 skills 字段记录 SkillBinding[]（name + versionId），
 *   Agent mount 前把对应版本的 SKILL.md 复制为当前 SKILL.md。
 *   Skill 全局统一管理在 <CORUM_HOME>/skills/。
 * @module @corum/corum-agent/profile
 */

/** 默认大模型配置。 */
export interface ProfileModel {
  /** provider route（如 deepseek / pi-ai）。 */
  provider: string
  /** model id。 */
  model: string
  /** 可选 reasoning effort。 */
  reasoningEffort?: string
}

/**
 * 「**显式跟随主 Agent**」的哨兵值（子 Agent 模型配置的第三态）。
 *
 * ## 为什么需要它（它修的是什么）
 *
 * 2026-10-11 起子 Agent 模型路由是**三档**：
 *   ① 预设里配的模型 ＞ ② 全局的子 Agent 默认模型 ＞ ③ 跟随主 Agent
 *
 * 于是预设侧「没配」有两种**不同**含义，必须能分开表达：
 *   · `undefined`（键不存在）= **不覆盖** ⇒ 走 ②，全局也没配才到 ③；
 *   · `FOLLOW_MAIN` = **显式跟随主 Agent** ⇒ **跳过 ②**，直接到 ③。
 *
 * 在旧的两档语义下这两者恰好等价（当时没有 ②），所以「删除键」就足以实现
 * 「永久跟随主 Agent」。三档之后不再等价：删键会落到全局档 —— 修正之前，模型不可用
 * 面板上的「永久跟随主 Agent」会失效，且**只有全局配了模型时**（预设本来就没配）删键
 * 是空操作 ⇒ 下一轮再次命中同一个坏模型 ⇒ 无限弹同一个面板。
 *
 * ## 为什么用字面量哨兵而不是布尔标志
 *
 * 布尔标志（如另加 `followMain: true`）漏改一处**不会报错**，只会静默按旧语义跑 ——
 * 本仓最贵的失效类。做成联合类型后，任何读 `subagentModel.provider` 的地方都必须先
 * 收窄，漏改由 `tsc` 拦下。
 */
export const FOLLOW_MAIN = 'follow-main' as const

/** 子 Agent 模型配置：具体路由，或显式跟随主 Agent（见 {@link FOLLOW_MAIN}）。 */
export type ProfileChildModel = ProfileModel | typeof FOLLOW_MAIN

/** 终端能力。 */
export interface ProfileTerminal {
  /** sandbox | host（host 级敏感，需人显式开启）。 */
  mode: 'sandbox' | 'host'
}

/** 专属记忆策略（PRD §4.0.5）。 */
export interface ProfileMemoryPolicy {
  /**
   * 记忆作用域：'agent' = 专属记忆目录（默认 ~/.corum/memory/<profileId>/）；
   * 'none' = 关闭记忆（Agent 预设「记忆功能」开关的关态）。
   */
  scope: 'agent' | 'none'
  /** 自定义记忆目录（空 = 默认 `~/.corum/memory/<profileId>/`）。 */
  dir?: string
}

/**
 * Skill 绑定：Agent 引用全局 skill 的一个固定版本。
 * - name：skill 名称（对应 <CORUM_HOME>/skills/<name>/）
 * - versionId：pin 的版本 ID（日期+序号，如 2026-08-22-01）
 *   Agent 创建前把对应版本的 SKILL.md 复制为当前 SKILL.md。
 */
export interface SkillBinding {
  /** skill name（全局目录 <CORUM_HOME>/skills/<name>/ 下的子目录名）。 */
  name: string
  /** pin 的版本 ID（日期+序号）。Agent 对 skill 版本不可见，始终用此版本。 */
  versionId: string
}

/**
 * corum Agent 的基础模式（persona 继承来源 + 语义口径）。
 *
 * `standard` / `ptc` / `minimal` / `cordis` 对应 dsh 官方四种 preset 的 persona 口径；
 * `conductor`（指挥模式，2026-09-10 用户需求）= 与标准模式同级的基准模式——工具面与
 * standard 相同，但主 Agent 的执行工具在运行时被裁掉（只编排不亲手执行），人格为
 * 「指挥者」。**`baseMode: 'conductor'` 的 corum 角色自动继承指挥语义**（见
 * conductor.ts 的 `effectiveExecutionTools`：未显式声明 executionTools 时恒按
 * orchestrator 处理）。
 */
export type BaseMode = 'standard' | 'ptc' | 'minimal' | 'cordis' | 'conductor'

/**
 * 并行开发策略（多子 Agent 硬隔离编排，docs/plan/PLAN-subagent-isolation.md §4）。
 * 编译进 fork #10（@corum/corum-tool-subagent）双实例行的 config。
 *
 * 2026-09-21 裁定：**隔离 / 合并相关键（原 `isolation` / `worktreeRoot` / `branchPrefix` /
 * `merger` / `autoCleanup` / `denyDirectFs` / `integrateChecks`）已从本接口移除**——这些
 * 机制已恒定生效（凡写委派恒隔离、自动清理、deny 直连 FS、按父 cwd 探测核查命令、父 Agent
 * 合并），不再允许 preset 覆盖，属**死键清除**。存量 preset yaml 里的旧键**忽略不迁移**
 * （宽松处理：读到时丢弃，不报错、不做转换）。
 */
export interface ParallelWorkPolicy {
  /** 会话级并行子 Agent 上限（默认 4，超限拒绝新召唤）。 */
  maxParallelChildren?: number
}

/** Agent 岗位维度（名片筛选维度；`通用` = 不限编程/跨领域岗位，2026-09-10 新增）。 */
export type AgentDimension = '研发' | '产品' | '设计' | '市场' | '自媒体' | '创作' | '通用'

/** 工作场景人格预设。 */
export type PersonaPreset =
  | 'rigorous-architect'   // 严谨架构师：代码审查、系统设计、质量保证
  | 'steady-coach'         // 稳健教练：资深带教、方案评审、跨部门协调
  | 'efficient-executor'   // 高效执行者：任务分解、进度跟踪、应急响应
  | 'innovative-explorer'  // 创新探索者：技术选型、预研项目、疑难杂症
  | 'custom'               // 自定义（保留自由文本）

/** AgentProfile 完整定义。 */
export interface AgentProfile {
  /** profile id（文件名，slug）。 */
  id: string
  /** 昵称（显示用，可选）。 */
  nickname?: string
  /** 岗位 / 职位（显示用，可选）。 */
  title?: string
  /** 岗位维度（名片筛选，可选）。 */
  dimension?: AgentDimension
  /** 名片履历（可选，手动编辑；如「参与 6 个项目 · 完成 128 次任务」）。 */
  experience?: string
  /** 人格预设（选择工作场景人格原型；'custom' 时走 persona 自由文本）。 */
  personaPreset?: PersonaPreset
  /** 自定义人格描述（personaPreset === 'custom' 时使用；其他情况可作补充微调）。 */
  persona?: string
  /** 头像 URL（可选，用户上传或 AI 生成）。 */
  avatar?: string
  /** 基础模式：继承 dsh 四种预设的 persona（standard/ptc/minimal/cordis）。 */
  baseMode: BaseMode
  /**
   * 用户自定义提示词，叠加在基础模式 persona 之上（而非替代）。
   * compilePreset 拼接：基础模式 persona + "\n\n" + 自定义提示词。
   */
  prompt: string
  /** 默认大模型配置。 */
  model: ProfileModel
  /**
   * 子 Agent 模型配置（可选）。
   *
   * 三态（2026-10-11 起）：
   *   · 键不存在 = **不覆盖** ⇒ 走全局 `corum-subagent.defaultModel`，全局也没配才跟随主 Agent；
   *   · {@link FOLLOW_MAIN} = **显式跟随主 Agent**（跳过全局档）；
   *   · 具体路由 = 机制锁：设什么跑什么，与 LLM 决策无关。
   */
  subagentModel?: ProfileChildModel
  /** 研究子 Agent 模型（可选；键不存在 ⇒ 回落 {@link subagentModel}；缺省同 subagentModel）。 */
  researchModel?: ProfileChildModel
  /** 并行开发策略（可选；缺省 = write-tasks 语义由 fork #10 默认兜底）。 */
  parallelWork?: ParallelWorkPolicy
  /**
   * 主 Agent 执行工具策略（可选，缺省 'full'）。
   * - 'full'：standard 全量工具（现状不变）。
   * - 'orchestrator'：编排者模式——主 Agent 只留「编排（subagent/subagent_research/
   *   orchestrate/send_message/list_agents）+ 只读调查（glob/grep）+ 规划辅助
   *   （todo/ask_user/goal/jobs）」，编译时裁掉一切亲手执行工具（bash 命令、
   *   文件写/编辑），主 Agent 物理上无法亲手实现，只能派子 Agent 干活。
   *   用于「主 Agent 只思考规划、子 Agent 全权执行」的编排专用 Agent
   *   （docs/plan/PLAN-deepseek-orchestrator-agent.md）。
   */
  executionTools?: 'full' | 'orchestrator'
  /** 技能绑定列表（引用全局 skill + pin 版本）。 */
  skills: SkillBinding[]
  /** MCP 服务授权列表（引用全局注册表中的服务名）。 */
  mcpServers: string[]
  /** 终端能力。 */
  terminal: ProfileTerminal
  /** 专属记忆策略。 */
  memoryPolicy: ProfileMemoryPolicy
  /** 版本号（快照隔离）。 */
  version: number
  /** 信任级（system / user）。 */
  trust: 'system' | 'user'
  /**
   * fork（corum）：**spec 基线快照** —— 上一次由内置 spec 写入的「可同步字段」值。
   *
   * 为什么需要它（2026-09-14 用户拍板「手动改的模型配置属于用户数据，不应该在程序升级后
   * 被覆盖」）：内置角色（`trust: 'system'`）的字段既要 ①**随 spec 演进幂等刷新**（否则
   * 「指挥者→指挥模式」这类改名对既有安装静默不生效），又要 ②**不覆盖用户的手工修改**。
   * 二者只靠「值是否等于 spec」无法区分 —— 用户可能正好改成了与 spec 相同的值，也可能
   * spec 与用户改成了不同的值。
   *
   * 判据（{@link refreshFromSpec}）：**当前值 === 基线值 ⇒ 用户没改过 ⇒ 可随 spec 刷新；
   * 当前值 !== 基线值 ⇒ 用户改过 ⇒ 保留用户值。**
   *
   * 缺省（老安装没有该字段）：对可同步字段一律**保留现值**（宁可漏一次 spec 演进，也不
   * 静默覆盖用户数据）。
   */
  specBaseline?: Record<string, unknown>
  /**
   * **模块来源标记**（2026-10-11 用户裁定 Q1 = 装进用户根）。
   *
   * 模块装的与用户自建的**同目录**（`<home>/.agent-presets/<id>/`），没有这个字段
   * 就分不清——升级/卸载/「这个预设能不能删」都无处下手。由 `installProfileModule`
   * 写入；`saveProfileRemote` 白名单带过（它不由 `SaveProfileInput` 承载）。
   */
  moduleSource?: import('@corum/corum-preset-modules').ModuleSource
}

/** 校验一个 profile id（slug 形式，防路径逃逸）。 */
export function isValidProfileId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id)
}

/** 校验岗位维度值（可选；不合法值在 saveProfile 处丢弃）。 */
export function isValidAgentDimension(v: string): v is AgentDimension {
  return v === '研发' || v === '产品' || v === '设计' || v === '市场' || v === '自媒体' || v === '创作' || v === '通用'
}

/** 校验人格预设值（可选；不合法值在 saveProfile 处丢弃）。 */
export function isValidPersonaPreset(v: string): v is PersonaPreset {
  return v === 'rigorous-architect' || v === 'steady-coach' || v === 'efficient-executor'
    || v === 'innovative-explorer' || v === 'custom'
}

/**
 * 内置「极简模式」预设 id——唯一允许 `baseMode: 'minimal'` 的预设（来源：
 * `builtin-profiles.ts` 的 `BUILTIN_ROLES` 中 `minimal-assistant` spec，2026-09-13
 * 用户定稿命名）。此处单独声明常量（不 import BUILTIN_ROLES，避免 profile.ts
 * 反向依赖 builtin-profiles.ts 的内部表）。
 */
export const MINIMAL_BUILTIN_PROFILE_ID = 'minimal-assistant'

/**
 * 校验用户自建预设的 baseMode：**极简模式只允许内置「极简模式」预设继承**。
 *
 * 用户裁决（2026-09-29）：「minimal 保持官方原汁原味，我们的 Agent 预设不再允许
 * 继承此模式。只内置一个继承此模式的极简助手即可。」故用户自建预设的 `baseMode`
 * 不允许是 `'minimal'`——内置 `minimal-assistant`（`id === MINIMAL_BUILTIN_PROFILE_ID`
 * 且 `trust === 'system'`）是唯一例外，它必须仍能编译。
 *
 * 判定方式（「内置 vs 用户自建」）：内置预设由 spec 幂等播种（`trust: 'system'`），
 * 用户自建预设 `trust: 'user'`；再叠加 id 精确匹配内置 minimal spec，确保只有那个
 * 内置预设本身能过——用户用同名 id 覆盖内置预设属既有边界，不在本校验职责内。
 *
 * 调用点：`saveProfileRemote`（UI 可编辑的保存路径）。内置预设的 spec 播种走
 * `ensureBuiltinRoleProfiles` → `saveProfile`，不经本校验，故内置 minimal 仍可编译。
 *
 * @param input - 待保存预设的 id / baseMode / trust。
 * @throws 当 `baseMode === 'minimal'` 但非内置 minimal-assistant 时。
 */
export function assertBaseModeAllowedForPreset(input: { id: string; baseMode: string; trust: string }): void {
  if (input.baseMode === 'minimal'
    && !(input.id === MINIMAL_BUILTIN_PROFILE_ID && input.trust === 'system')) {
    throw new Error('极简模式不可作为自建预设的基础模式（仅内置「极简模式」可用）')
  }
}
