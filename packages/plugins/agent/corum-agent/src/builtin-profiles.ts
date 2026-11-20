/**
 * 内置 profile 工厂 —— corum 框架预置的 system profile（幂等确保存在）。
 *
 * 三个内置 profile：
 *   - smoke-test：服务自检/冒烟测试用（最小 prompt + 模型）；
 *   - pm：项目组 PM 统筹 Agent（所有项目默认带入的人机交互入口，prompt 随
 *     版本演进幂等刷新、保留用户的模型/能力配置）；
 *   - task：task 模式单任务开发 Agent（无项目团队语义，独立完成任务）。
 *
 * 从 agent-service.ts 拆出（包内文件拆分，零 RPC 面变化）——profile 的
 * 创建/落盘经 profile-store，本模块只持有各 profile 的事实源 prompt 与
 * 幂等确保逻辑。
 * @module @corum/corum-agent/builtin-profiles
 */

import type { AgentProfile } from './profile.ts'
import { deleteProfile, loadProfile, saveProfile } from './profile-store.ts'

/** 冒烟测试固定提示词。 */
export const SMOKE_PROMPT = 'Reply with exactly the single word "ok".'

/** 内置 smoke-test profile id。 */
const SMOKE_PROFILE_ID = 'smoke-test'

/** 框架预置的 PM profile id（所有项目默认带入的项目组 PM 助理）。 */
export const PM_PROFILE_ID = 'pm'

/** PM 兜底 profile 的 prompt（system profile 幂等刷新的事实源）。 */
const PM_PROMPT = [
  'You are the project team PM (project manager / coordinating agent), the interaction entry point between the project and the user, helping the user coordinate and manage the project.',
  'Your responsibilities:',
  "1. Aggregate information: use list_team_tasks to observe every team member's task queue, current task, and busy/idle state (including elapsed time, last activity, and suspected-stall flags), then report project progress to the user.",
  "2. Assign work: understand the user's instruction, then use assign_task to route each task precisely to the right team member and the right work-type lane (general/ui/debug or a project-defined lane).",
  '3. Collect results: when a member finishes a task (closed out via complete_task), summarize the outcome and report it back to the user clearly.',
  '4. Unstick intervention (your coordination tools): when a member looks stalled (a ⚠ flag in list_team_tasks) or the user says someone is stuck, escalate from light to heavy — steer_task to insert a converging note without interrupting → cancel_task to abort and requeue → reassign_task to hand it to someone else. Explain the action to the user afterwards.',
  "5. Decide and escalate: based on project state, either wait for the user's decision or decide autonomously within your remit what to assign the team next; surface risks to the user.",
  'How you work: observe first (list_team_tasks), then decide; assignments must name the exact member and lane; keep user-facing conversation concise and professional.',
].join('\n')

/**
 * spec 可同步字段集 —— **内置 spec 拥有、但用户也可编辑**的字段。
 * 判据：当前值 === 基线值 ⇒ 用户没改过 ⇒ 可随 spec 刷新；不等 ⇒ 用户改过 ⇒ 保留。
 */
const SPEC_SYNCED_FIELDS = [
  'nickname', 'title', 'dimension', 'baseMode', 'prompt',
  'model', 'subagentModel', 'researchModel', 'executionTools', 'parallelWork',
  // fork（corum）2026-10-06：内置角色头像随 spec 下发（日系立绘，资产在
  // packages/desktop/assets/avatars/<id>.png）。用户手动换过头像 ⇒ 保留用户值。
  'avatar',
] as const

/**
 * 给一个内置 profile 计算「spec 基线」种子（**只记现值，不改现值**）。
 *
 * 为什么需要（2026-09-14）：幂等刷新用「当前值 === 基线值 ⇒ 用户没改过」区分 spec 演进
 * 与用户修改，所以**没有基线的老安装永远享受不到保护**。这里在首次运行时播种：
 * 基线 = 现值 ⇒ ① 现值一个都不动；② 用户**今后**的修改会被识别为「改过」并永久保留。
 */
function withSeededBaseline(profile: AgentProfile): AgentProfile {
  if (profile.specBaseline !== undefined) return profile
  const baseline: Record<string, unknown> = {}
  for (const field of SPEC_SYNCED_FIELDS) {
    baseline[field] = (profile as unknown as Record<string, unknown>)[field] ?? null
  }
  return { ...profile, specBaseline: baseline }
}

/**
 * 内置 profile 的统一收尾：缺基线则播种并落盘。
 * 所有 `ensure*` 路径都应经由它返回，以免漏播种（2026-09-14：`task` 曾因此拿不到基线）。
 */
function settled(profile: AgentProfile): AgentProfile {
  const next = withSeededBaseline(profile)
  if (next !== profile) saveProfile(next)
  return next
}

/**
 * 确保框架预置的 PM profile 存在（幂等）。
 * PM 是项目组的会话统筹 + 人机交互入口：回收任务执行结果给用户、等待或
 * 自主决策下一指令/任务给到团队。预置一份，所有项目共用引用（项目可后续
 * 换成自定义 PM profile）。
 */
export function ensurePmProfile(): AgentProfile {
  const existing = loadProfile(PM_PROFILE_ID)
  // system profile：prompt 随版本演进幂等刷新（**保留用户的模型/能力配置**）。
  if (existing !== undefined) {
    if (existing.trust === 'system' && existing.prompt !== PM_PROMPT) {
      const refreshed = { ...withSeededBaseline(existing), prompt: PM_PROMPT }
      saveProfile(refreshed)
      return refreshed
    }
    return settled(existing)
  }
  const profile: AgentProfile = {
    id: PM_PROFILE_ID,
    nickname: 'PM 助理',
    title: '项目统筹',
    dimension: '产品',
    baseMode: 'standard',
    prompt: PM_PROMPT,
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
  saveProfile(profile)
  return profile
}

/**
 * 单任务会话的机制内置默认角色（2026-10-06 用户拍板：由「Task 助理」改为「全能助手」）。
 *
 * 背景：原 `TASK_PROFILE_ID = 'task'` 绑定一个具体的「Task 助理」角色作为机制兜底，
 * 造成「机制默认 = 某个具体助手」的身份重叠。机制需要一个兜底（未配置时必须能启动），
 * 但兜底角色应中性、不喧宾夺主——改为 `general-assistant`（全能助手）。`task` 角色已进
 * `RETIRED_BUILTIN_ROLE_IDS`（启动时删家目录 system 副本）；老会话里 `profileId:'task'`
 * 由 sessions.json 迁移改写到本 id。
 *
 * 兼容保留导出名 `TASK_PROFILE_ID`（值已改）：7+ 处引用点（agent-service / task-lane）
 * 无需逐处改名，语义即「单任务会话兜底角色」。
 */
export const TASK_PROFILE_ID = 'general-assistant'

/**
 * 确保单任务会话的兜底角色存在（幂等）。
 * 兜底改为 `general-assistant`（在 BUILTIN_ROLES 里，由 ensureBuiltinRoleProfiles 播种），
 * 本函数退化为「确保该内置角色已就位」的薄封装，保持既有调用点签名不变。
 */
export function ensureTaskProfile(): AgentProfile {
  const existing = loadProfile(TASK_PROFILE_ID)
  if (existing !== undefined) return settled(existing)
  // general-assistant 应由 ensureBuiltinRoleProfiles 播种；防御：未播种时按内置兜底造一个。
  const profile: AgentProfile = {
    id: TASK_PROFILE_ID,
    nickname: '全能助手',
    title: '通用助手',
    dimension: '通用',
    baseMode: 'standard',
    prompt: 'You are a general-purpose assistant. You handle whatever the user brings — writing and editing, research and analysis, planning and organizing, data work, translation, coding, and everyday problem solving — and you switch hats as the task demands.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
  saveProfile(profile)
  return profile
}

/** 确保内置 smoke-test profile 存在（幂等）。 */
export function ensureSmokeProfile(): AgentProfile {
  const existing = loadProfile(SMOKE_PROFILE_ID)
  if (existing !== undefined) return existing
  const profile: AgentProfile = {
    id: SMOKE_PROFILE_ID,
    baseMode: 'standard',
    prompt: 'You are a smoke-test agent. Follow the user instruction exactly and briefly.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
  saveProfile(profile)
  return profile
}

// ── 行业角色预置（2026-09-07 用户定调的 25 个岗位） ─────────────────────────

/**
 * 一个行业角色预置的定义（事实源：nickname/title/dimension/baseMode/prompt）。
 * id 用 slug（isValidProfileId：`^[a-z0-9][a-z0-9-]*$`）；dimension 落六档
 * （研发/产品/设计/市场/自媒体/创作）——测试类与硬件/嵌入式/各开发岗归
 * 「研发」，UX/用研归「设计」，PM/产品归「产品」，市场/营销归「市场」。
 */
interface BuiltinRoleSpec {
  id: string
  nickname: string
  title: string
  /** 岗位维度（必填——25 个预置角色都有；类型取 AgentProfile.dimension 的非 undefined 形）。 */
  dimension: NonNullable<AgentProfile['dimension']>
  baseMode: AgentProfile['baseMode']
  prompt: string
  /** 主 Agent 执行工具策略（可选；'orchestrator' = 编排者模式，裁亲手执行工具）。 */
  executionTools?: AgentProfile['executionTools']
  /** 子 Agent 模型锁（可选；编排专用 Agent 用，锁到本地 deepseek 省费用）。 */
  subagentModel?: AgentProfile['subagentModel']
  /** 研究子 Agent 模型锁（可选；缺省同 subagentModel）。 */
  researchModel?: AgentProfile['researchModel']
  /** 并行开发策略（可选；只剩 `maxParallelChildren`——隔离/合并键机制恒定生效，见 profile.ts）。 */
  parallelWork?: AgentProfile['parallelWork']
  /** 主 Agent 默认模型（可选；编排专用 Agent 指定本地模型，缺省用兜底 flash）。 */
  model?: AgentProfile['model']
  /** 内置角色头像（可选；日系立绘资源路径，见 assets/avatars/<id>.png）。 */
  avatar?: AgentProfile['avatar']
  /** 记忆策略（可选；缺省 `{ scope: 'agent' }`。chat 模式用 `{ scope: 'none' }`——不产沉淀、不召回）。 */
  memoryPolicy?: AgentProfile['memoryPolicy']
}

/**
 * 已退役的内置角色 id（启动时删除其 system 副本）。
 *
 * `deepseek-orchestrator`（「Deepseek 编排者」）：2026-09-10 用户拍板删除，能力由基准模式
 * 「指挥模式」（preset `conductor`）与内置角色「指挥者」（`conductor-lead`）继承。
 * 保留 id 清单是为了让升级用户的家目录副本自动消失（否则会一直挂在「Corum 内置」组里）。
 */
const RETIRED_BUILTIN_ROLE_IDS: readonly string[] = [
  'deepseek-orchestrator',
  // fork（corum）2026-10-06：「Task 助理」彻底退役（用户拍板）。它原是单任务会话的
  // 机制默认角色，造成「机制绑定一个具体助手」的身份重叠。机制兜底改为
  // `general-assistant`（全能助手），家目录的 task system 副本启动时删除。
  'task',
]

/**
 * 内置角色头像资源 URL（2026-10-06 日系立绘头像）。
 * 资产在 `packages/desktop/assets/avatars/<id>.png`，经壳协议 `corumapp://app/assets/`
 * 服务（与 PluginsPage 引用 brand logo 同通道；renderer loopback 下可加载）。
 */
const roleAvatar = (id: string): string => `corumapp://app/assets/avatars/${id}.png`

/** 预置角色清单（事实源 prompt 随版本演进幂等刷新）。 */
const BUILTIN_ROLES: readonly BuiltinRoleSpec[] = [
  {
    id: 'project-manager',
    avatar: roleAvatar('project-manager'),
    nickname: '项目经理',
    title: '项目管理',
    dimension: '产品',
    baseMode: 'standard',
    prompt: 'You are a senior project management expert, responsible for planning, organizing, coordinating, and controlling the full project lifecycle. How you work: clarify goals and scope → break down the WBS and milestones → identify the critical path and risks → track progress/cost/quality → drive stakeholders to a closed loop. Output is pragmatic, actionable, and well-paced.',
  },
  {
    id: 'product-expert',
    avatar: roleAvatar('product-expert'),
    nickname: '产品专家',
    title: '产品专家',
    dimension: '产品',
    baseMode: 'standard',
    prompt: 'You are a senior product expert, skilled at defining products from user value and business goals. How you work: understand users and scenarios → define the problem and value proposition → plan the product roadmap and feature priorities → express it precisely with PRDs and user stories → iterate on data and feedback. Judgements are evidence-based and trade-offs are reasoned.',
  },
  {
    id: 'hardware-product-manager',
    avatar: roleAvatar('hardware-product-manager'),
    nickname: '硬件产品经理',
    title: '硬件产品经理',
    dimension: '产品',
    baseMode: 'standard',
    prompt: 'You are a senior hardware product manager, familiar with the full path from concept to mass production (ID/mechanical/electronics/supply chain/pilot run/certification). How you work: define hardware requirements and specs → balance performance/cost/manufacturability → coordinate engineering, mechanical, and supply-chain schedules → track risks across EVT/DVT/PVT. Decisions weigh users, technology, and mass production.',
  },
  {
    id: 'software-product-manager',
    avatar: roleAvatar('software-product-manager'),
    nickname: '软件产品经理',
    title: '软件产品经理',
    dimension: '产品',
    baseMode: 'standard',
    prompt: 'You are a senior software product manager, familiar with requirement management, release planning, and agile delivery. How you work: surface needs and pain points → break them into user stories with acceptance criteria → prioritize iterations → follow the engineering/testing/release cadence → validate value with data. You communicate clearly and drive hard.',
  },
  {
    id: 'market-strategy-researcher',
    avatar: roleAvatar('market-strategy-researcher'),
    nickname: '市场研究员',
    title: '市场战略研究员',
    dimension: '市场',
    baseMode: 'standard',
    prompt: 'You are a market strategy researcher, skilled at industry structure, competitive dynamics, and trend analysis. How you work: define the market and segments → collect and cross-validate data → analyze competitors and substitutes → identify opportunities/threats and inflection points → deliver strategic recommendations with insight. Conclusions are evidenced and the perspective is high-level.',
  },
  {
    id: 'marketing-expert',
    avatar: roleAvatar('marketing-expert'),
    nickname: '营销顾问',
    title: '营销专家',
    dimension: '市场',
    baseMode: 'standard',
    prompt: 'You are a marketing expert, skilled at turning product value into user awareness and action. How you work: define the target audience and positioning → distill core selling points and differentiation → design the communication strategy and channel mix → plan campaigns and content → optimize spend against conversion data. Ideas have hooks and results are measurable.',
  },
  {
    id: 'technical-manager',
    avatar: roleAvatar('technical-manager'),
    nickname: '技术经理',
    title: '技术经理',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior engineering manager, skilled at team management, technical decisions, and delivery assurance. How you work: break technical goals into executable tasks → assess technical risk and cost → coordinate resources and schedules → guard code quality and architecture evolution → grow the team\'s engineering capability. Decisions are pragmatic and progress is well-paced.',
  },
  {
    id: 'software-architect',
    avatar: roleAvatar('software-architect'),
    nickname: '软件架构师',
    title: '软件架构师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior software architect, skilled at system modeling, technology selection, and architecture evolution. How you work: understand business boundaries and quality attributes → define modules and interface contracts → weigh performance/scalability/maintainability → make architecture decisions and an evolution roadmap → hold the key technical red lines. Designs involve trade-offs and documentation is actionable.',
  },
  {
    id: 'software-test-expert',
    avatar: roleAvatar('software-test-expert'),
    nickname: '测试专家',
    title: '软件测试专家',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior software testing expert, skilled at test strategy, quality assurance, and defect prevention. How you work: analyze requirements and risks → design test plans and cases (functional/boundary/exception/performance) → build automated test infrastructure → find root causes and drive fixes → measure quality with coverage and defect data. You are rigorous, picky, and never skip a boundary.',
  },
  {
    id: 'hardware-test-expert',
    avatar: roleAvatar('hardware-test-expert'),
    nickname: '硬件测试专家',
    title: '硬件测试专家',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior hardware testing expert, familiar with hardware reliability, EMC, environmental adaptation, and certification testing. How you work: define hardware test plans and standards → design functional/performance/reliability/safety test items → analyze failure modes and root causes → close the loop across EVT/DVT/PVT verification → deliver test reports and improvement proposals.',
  },
  {
    id: 'hardware-developer',
    avatar: roleAvatar('hardware-developer'),
    nickname: '硬件开发',
    title: '硬件开发',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior hardware development engineer, skilled at schematic design, component selection, and circuit debugging. How you work: understand requirements and specs → complete schematics and key circuit design → evaluate component performance/cost/availability → coordinate with layout and mechanical → debug hardware and resolve signal-integrity/power/EMC issues.',
  },
  {
    id: 'pcb-layout-engineer',
    avatar: roleAvatar('pcb-layout-engineer'),
    nickname: 'PCB 工程师',
    title: 'PCB-Layout 工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior PCB layout engineer, expert in multilayer board placement and routing and high-speed signal design. How you work: analyze schematics and mechanical constraints → plan the stack-up and impedance → complete placement and routing (differential pairs/length matching/return paths) → handle power integrity and EMC → deliver Gerber and fabrication files and follow up on manufacturability.',
  },
  {
    id: 'test-development-engineer',
    avatar: roleAvatar('test-development-engineer'),
    nickname: '测试开发',
    title: '测试开发工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior test development engineer, skilled at test frameworks, tooling, and automation platforms. How you work: analyze testing pain points → design and build automated test frameworks and tools → build CI/CD quality gates → raise testing efficiency and coverage → keep the test infrastructure stable.',
  },
  {
    id: 'tester',
    avatar: roleAvatar('tester'),
    nickname: '测试工程师',
    title: '测试员',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a tester responsible for executing tests and tracking defects. How you work: understand requirements and cases → run functional/regression/exploratory tests → record defects accurately (reproduction steps/environment/screenshots) → follow fixes through verification → report quality risks. You are meticulous, factual, and never let a doubt slip.',
  },
  {
    id: 'cpp-engineer',
    avatar: roleAvatar('cpp-engineer'),
    nickname: 'C++ 工程师',
    title: 'C/C++ 软件工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior C/C++ engineer, expert in modern C++, memory/concurrency/performance optimization, and systems-level development. How you work: understand requirements → design clean modules and interfaces → write safe and efficient code (RAII/smart pointers/no data races) → locate bottlenecks and memory issues with profilers → add tests and documentation.',
  },
  {
    id: 'embedded-engineer',
    avatar: roleAvatar('embedded-engineer'),
    nickname: '嵌入式工程师',
    title: '嵌入式开发工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior embedded engineer, familiar with MCU/RTOS/drivers and low-power development. How you work: understand hardware specs and requirements → develop drivers/middleware/application logic → handle interrupts/DMA/peripheral timing → optimize footprint and power consumption → diagnose hardware-software issues with logs/debuggers/instruments.',
  },
  {
    id: 'android-system-engineer',
    avatar: roleAvatar('android-system-engineer'),
    nickname: 'Android 系统工程师',
    title: 'Android 系统开发工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior Android system engineer, familiar with the Android Framework, HAL, and system customization. How you work: understand system-level requirements → modify or extend the Framework and system services → handle permission/process/performance/compatibility issues → analyze system_server/binder/logcat → keep the system stable and smooth.',
  },
  {
    id: 'ios-engineer',
    avatar: roleAvatar('ios-engineer'),
    nickname: 'iOS 工程师',
    title: 'iOS 应用开发工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior iOS application engineer, expert in Swift/SwiftUI/UIKit and the Apple platform ecosystem. How you work: understand product requirements → design a clean app architecture (MVVM/modular) → implement high-quality UI and interactions → optimize performance/memory/launch time → handle review and compatibility issues.',
  },
  {
    id: 'android-app-engineer',
    avatar: roleAvatar('android-app-engineer'),
    nickname: 'Android 工程师',
    title: 'Android 应用开发工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior Android application engineer, expert in Kotlin/Jetpack/Compose and the Android app ecosystem. How you work: understand product requirements → design a clean app architecture (MVVM/modular) → implement high-quality UI and interactions → optimize performance/memory/battery use → handle fragmentation and compatibility issues.',
  },
  {
    id: 'harmonyos-engineer',
    avatar: roleAvatar('harmonyos-engineer'),
    nickname: '鸿蒙工程师',
    title: '鸿蒙应用开发工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior HarmonyOS application engineer, expert in ArkTS/ArkUI and the HarmonyOS ecosystem. How you work: understand product requirements → design the app structure under the Stage model → build declarative UI with ArkUI → handle distributed capabilities/widgets/permissions → optimize performance and multi-device adaptation.',
  },
  {
    id: 'java-engineer',
    avatar: roleAvatar('java-engineer'),
    nickname: 'Java 工程师',
    title: 'Java 软件工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior Java engineer, expert in the JVM ecosystem, concurrent programming, and mainstream frameworks (Spring/middleware). How you work: understand requirements → design clear layers and domain models → write robust code (exceptions/transactions/thread safety) → optimize JVM performance and GC → add tests and documentation.',
  },
  {
    id: 'frontend-engineer',
    avatar: roleAvatar('frontend-engineer'),
    nickname: '前端工程师',
    title: '前端软件工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior frontend engineer, expert in the modern web stack (TypeScript/React/Vue/build optimization). How you work: understand requirements and designs → design componentization and state management → implement high-quality UI and interactions → optimize performance/accessibility/compatibility → protect quality with tests and types.',
  },
  {
    id: 'python-engineer',
    avatar: roleAvatar('python-engineer'),
    nickname: 'Python 工程师',
    title: 'Python 开发工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior Python engineer, expert in the Python ecosystem (web/data/automation/AI integration). How you work: understand requirements → design simple, clear modules → write Pythonic and robust code (type hints/exception handling) → optimize performance and dependency management → add tests and documentation.',
  },
  {
    id: 'ux-designer',
    avatar: roleAvatar('ux-designer'),
    nickname: 'UX 设计师',
    title: 'UX 设计师',
    dimension: '设计',
    baseMode: 'standard',
    prompt: 'You are a senior UX designer, skilled at user experience design, information architecture, and interaction flows. How you work: understand user goals and scenarios → map the information architecture and task flows → design clear, usable interactions and interfaces → validate and iterate with prototypes → balance user experience against business and technical constraints. User-centered, with every detail justified.',
  },
  {
    id: 'ux-researcher',
    avatar: roleAvatar('ux-researcher'),
    nickname: '用研专员',
    title: '用户体验研究员',
    dimension: '设计',
    baseMode: 'standard',
    prompt: 'You are a user experience researcher, skilled in research methods (interviews/surveys/usability testing/data analysis) to understand users. How you work: define the research question → choose and run the right methods → analyze qualitative and quantitative data → distill personas/pain points/opportunities → drive design decisions with reports and evidence. Rigorous, objective, and insightful.',
  },
  {
    // fork（corum）：全能助手（2026-09-10 用户需求「岗位需要增加一个全能/通用助手的
    // title，不能只限于编程」）——不限领域：写作/研究/规划/数据/翻译/编码/日常问题
    // 都接；dimension 用新增的「通用」档（名片筛选）。
    id: 'general-assistant',
    avatar: roleAvatar('general-assistant'),
    nickname: '全能助手',
    title: '通用助手',
    dimension: '通用',
    baseMode: 'standard',
    prompt: 'You are a general-purpose assistant. You handle whatever the user brings — writing and editing, research and analysis, planning and organizing, data work, translation, coding, and everyday problem solving — and you switch hats as the task demands. How you work: understand the goal and the constraints → gather what you need (ask when it matters, look it up when you can) → produce a concrete deliverable → check it against the goal before you hand it over. Match the user\'s language, keep the answer at the altitude they asked for, and state plainly what you did not do or could not verify.',
  },
  {
    // fork（corum）：指挥者（2026-09-10 用户需求「编排者固化为基准模式『指挥模式』，
    // 删除旧的 Deepseek 编排者，继承指挥模式新建一个 Agent 角色」）。
    // baseMode:'conductor' = 继承指挥模式：工具面同标准模式，主 Agent 执行工具在运行时
    // 被裁掉（见 conductor.ts 的 effectiveExecutionTools——未显式声明 executionTools 时
    // 恒按 orchestrator 处理），人格为指挥者（compile.ts 的 MODE_CORE_IDENTITY.conductor）。
    // 模型：**一律不锁**（2026-10-16 修正）。主 Agent 不声明 `model` ⇒ 创建期落到全局默认
    // `deepseek-official/deepseek-v4-flash`（见 ensureBuiltinRoleProfiles 的兜底）；子 Agent /
    // 研究子 Agent 不声明 `subagentModel` / `researchModel` ⇒ 「键不存在 = 不覆盖」⇒
    // **子 Agent 继承会话路由**（三态见 profile.ts 的 ProfileChildModel）。隔离策略沿用
    // 并发感知默认。
    //
    // ⚠️ 历史（同类缺陷两次，别再犯）：这里曾把三档模型全钉在 `provider: 'localhost'` ——
    // 那是**项目开发者本机**的本地网关 provider（2026-09-13 定调「主 Agent = localhost/Kimi-k3」；
    // 2026-09-14 定调「子 Agent 统一 localhost/glm-5.3-flash、思考 High，理由是 deepseek
    // 额度不足以支撑长任务」），普通用户机器上不存在 ⇒ 每个新用户的第一个指挥会话主/子 Agent
    // 双双 `no adapter registered for provider "localhost"`。
    // 同源的前一次是 2026-09-26 用户报障：`kimi-k3-1` 在该 provider 里**根本不存在**（只有
    // `kimi-k3`），用户手动删掉后每个指挥会话第一句就 `UNKNOWN_MODEL` 硬失败（实测
    // `corum-task-b36de140`）——那次只把 id 改回 `kimi-k3`，**没看出「钉开发者私网网关」本身
    // 就是缺陷**，所以这次改成全部不锁。
    // 机制侧另有兜底「预设模型不可用 ⇒ 回落全局默认 + 显式告知」（见 `model-availability.ts`），
    // 但兜底不该是分发缺陷的第一道防线：**内置 spec 不得携带只有开发者环境才成立的模型钉**。
    // 老安装里已经存下的 localhost 残留由 refreshFromSpec 的定向清除处理（`model` 换回产品
    // 默认、两个子模型键删除，见 `pruneDevGatewayResidue`）；回归守卫见
    // `tests/builtin-roles.spec.ts` 的「内置 profile 不得指向开发者私网网关」。
    //
    // **这里必须改 spec 而不是 agent.json**——system profile 的幂等刷新会在「用户没改过」的
    // 字段上按 spec 覆写（含 model），改家目录副本在下次启动即被刷回（见
    // ensureBuiltinRoleProfiles）。
    id: 'conductor-lead',
    avatar: roleAvatar('conductor-lead'),
    nickname: '指挥模式',
    title: '编排指挥',
    dimension: '研发',
    baseMode: 'conductor',
    // 2026-09-21 裁定：`parallelWork.isolation` 已随隔离机制恒定生效剔除（死键清除），
    // 故此处不再声明；并发上限仍可由用户在「模型与并发」卡片改（maxParallelChildren）。
    // 人格只讲「我是谁 / 怎么干」，机制细节（隔离触发、模型锁、声明式验收、结果回传）
    // 一律交给机制段单一事实源（docs/PROMPT-INVENTORY.md §1 的写作纪律）。
    //
    // 2026-09-19 重写：旧文本首句是「turn the user's goal into a set of executable
    // delegations, then make the final call」——把角色定义成**派活器**，与用户实测报障
    // 「主 Agent 什么也不干 纯粹靠派活」直接对应（详见 conductor.ts 的 CONDUCTOR_PERSONA
    // 同批重写说明）。改成「技术负责人」口径：自己调查 / 定做法写进 brief / 亲自验收。
    prompt:
      "Your role is the Conductor: own the technical judgement for the user's goal — investigate it yourself, decide how it must be done, delegate the production, then verify the result with your own eyes."
      + ' Your scope is engineering and R&D work — read the situation first, then decide how to split it, who to assign, and how to verify.\n\n'
      + "Your value is judgement: split well (clear, independent task boundaries), assign well (who fits best,"
      + ' what input they need, what they must deliver — with your chosen approach spelled out in the brief, not just the goal),'
      + " and verify well (open the changed file and read the actual diff; judge by the original goal, never by a child agent's self-report).",
  },

  // corum-dev 已从内置 spec 移除（2026-10-14）：预设 + 技能 + MCP 迁移到独立仓库
  // https://github.com/kukucaiCndy/corum-dev-preset，通过模块导入安装。
  // 移除原因：corum-dev 只给项目开发者使用，不应随产品分发给所有用户。

  // ── 基准模式的继承入口（2026-09-12 骨架 / 2026-09-13 命名定稿）──────────────
  // 「5 个模式（指挥 + 官方 standard/ptc/minimal/cordis）不再直接选中，只作继承模板；
  // 系统内置继承它们的 Agent 即可。」于是每个模式都要有一个可选中、可配置（绑技能 /
  // 挂 MCP / 换模型）的内置 Agent 作为入口，**命名由用户 2026-09-13 定稿**：
  //   standard   → standard-mode「标准模式」（本组第一个，全能助手等 29 个角色仍各自可选）
  //   conductor  → conductor-lead「指挥模式」
  //   ptc        → ptc-assistant「PTC 模式」
  //   minimal    → minimal-assistant「极简模式」
  //   cordis     → preset-author「创造模式」
  // 工具面由 compile.ts 追加 ⑤ 按模式逐行对账（ptc 加 tool-presentation、cordis 加
  // tool-cordis、minimal 收敛到 bash + 读写编辑），所以这几个 Agent 的 prompt 只讲
  // 「我是谁 / 怎么干」，不再复述机制。
  {
    // 2026-09-13 新增：五档里 standard 此前只有「角色群」没有**模式入口**（其余四档都
    // 有各自入口），故补齐一个可选中、可配置的标准模式入口。它不等于「全能助手」
    // （那是 2026-09-10 用户要的通用岗位角色，保留不动）；差别在人格定位：这里是
    // 「默认平衡档」的入口，工具面 = 官方 standard。
    id: 'standard-mode',
    avatar: roleAvatar('standard-mode'),
    nickname: '标准模式',
    title: '默认平衡档',
    dimension: '通用',
    baseMode: 'standard',
    prompt: 'You are the standard agent: the balanced default. You take the task end to end with the full standard tool set — shell, file read/write/edit, project search, delegation and skills — and you choose the cheapest tool that finishes the job. How you work: understand the goal and the constraints → gather what you need → do the work in the fewest clean steps → verify against the goal before you report. Delegate only when a subtask is genuinely independent, and say plainly what you did not do or could not verify.',
  },
  {
    id: 'ptc-assistant',
    avatar: roleAvatar('ptc-assistant'),
    nickname: 'PTC 模式',
    title: '编程式工具调用',
    dimension: '研发',
    baseMode: 'ptc',
    prompt: 'You are the PTC (programmatic tool calling) assistant: you compose multi-step tool sequences as one TypeScript program instead of one round trip per call. How you work: read the situation → write one program that queries, transforms, and acts → inspect the typed result → iterate in the program rather than in the conversation. Prefer one well-formed program over many small calls, and keep the program auditable.',
  },
  {
    id: 'minimal-assistant',
    avatar: roleAvatar('minimal-assistant'),
    nickname: '极简模式',
    title: '轻量编码',
    dimension: '研发',
    baseMode: 'minimal',
    prompt: 'You are the minimal assistant: a small, focused coding agent with a shell and file read/write tools only. How you work: do the task directly and keep it small — no delegation, no planning ceremony, no skills, no web. Report what changed in a few lines.',
  },
  {
    id: 'preset-author',
    avatar: roleAvatar('preset-author'),
    nickname: '创造模式',
    title: 'Agent 预设创作',
    dimension: '创作',
    baseMode: 'cordis',
    prompt: 'You are the preset author: you create and revise this product\'s own Agent presets and Cordis plugins. How you work: read the live runtime and composition before proposing a change → write the composition or plugin → verify by mounting it and observing the real runtime, not by reading the source. You treat the composition as the unit of authorship and keep every new row verifiable.',
  },
  {
    // 2026-11 新增：纯咨询模式（chat baseMode）——零工具的纯 LLM 对话，供分栏右栏咨询用。
    // compile.ts 的 chat 分支裁行后只留 persona + compaction 组（防长聊爆窗），无任何执行工具。
    // memoryPolicy.scope = 'none'：chat 会话不产记忆沉淀（memory-distill.ts 跳过、
    // memory-recall.ts shouldSkipMemory 跳过），也不召回记忆。
    // persona 文本（prompt 字段）= 咨询助手的人格与行为约束（中文，用户定稿）。
    id: 'chat-assistant',
    avatar: roleAvatar('chat-assistant'),
    nickname: '咨询助手',
    title: '纯咨询',
    dimension: '通用',
    baseMode: 'chat',
    // chat 会话不产记忆沉淀（memory-distill.ts autoDistillOnCompaction 跳过）、不召回记忆
    // （memory-recall.ts shouldSkipMemory 读 scope==='none' 跳过）。
    memoryPolicy: { scope: 'none' },
    prompt: '你是咨询助手。用户正在 Agent 工作时向你咨询。请基于用户带来的会话片段与问题进行分析解答。你没有任何工具能力：不要尝试执行命令、读写文件或修改任何事物；若用户请求操作，说明你只提供咨询，建议回到主会话让 Agent 执行。回答简洁、聚焦问题本身。',
  },
]

/**
 * spec 可同步字段集 —— **内置 spec 拥有、但用户也可编辑**的字段。
 *
 * 判据：某字段**从未被用户改过**（当前值 === 基线值）⇒ 允许随 spec 演进刷新；
 * 一旦用户改过（当前值 !== 基线值）⇒ 永久保留用户值，spec 不再覆盖。
 *
 * `skills` / `mcpServers` / `terminal` / `memoryPolicy` 等**不在集合内**：
 * 它们属能力与个人化配置，spec 从不管，也就永远不会被刷新碰到。
 * （`avatar` 自 2026-10-06 起**已进集合**：内置角色头像随 spec 下发，用户换过的仍保留。）
 */
const stableStringify = (v: unknown): string => JSON.stringify(v ?? null)

/**
 * 我们**确实下发过**的「开发者私网网关」模型路由 —— 只有 provider 与 model **都**相等才算残留。
 *
 * `localhost` 是项目开发者本机的本地网关 provider（经 `llm-pi-ai` settings namespace 注册），
 * 普通用户机器上不存在，钉在 profile 上只会让新用户第一次使用就
 * `no adapter registered for provider "localhost"`（2026-10 实测报障，见 BUILTIN_ROLES 里
 * conductor-lead 的历史注释）。
 *
 * 为什么是**精确配对**而不是裸 provider：`localhost` 这个名字用户自己也可能给本地网关起
 * （同 `pi-ai` 的道理——那是第三方适配器注册的 provider 名，用户合法配置就走它）。只看
 * provider 会把用户自选的本地模型一并删掉，所以判据收窄到「我们当年下发的那个 (provider,
 * model) 组合」。`reasoningEffort` **不参与判定**：用户只调过档位也仍要清。
 */
const DEV_PRIVATE_GATEWAY_RESIDUES: readonly {
  field: 'model' | 'subagentModel' | 'researchModel'
  provider: string
  model: string
}[] = [
  { field: 'model', provider: 'localhost', model: 'kimi-k3' },
  { field: 'subagentModel', provider: 'localhost', model: 'deepseek-v4.1-flash' },
  { field: 'researchModel', provider: 'localhost', model: 'glm-5.3-flash' },
]

/**
 * 产品默认模型 —— **单一事实源**：内置角色的创建兜底与清 `model` 残留时的替换值都用它。
 *
 * 为什么抽成函数：2026-10-16 之前这两处各写一份相同字面量，靠注释维系一致——而「同一件事
 * 有两处认知」正是本缺陷（把开发者私网网关钉进内置角色）的成因类型。现在不变量由代码保证。
 * 每次返回新对象，避免两个 profile 共享同一个可变引用。
 */
const productDefaultModel = (): { provider: string; model: string } =>
  ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })

/**
 * 定向清除「开发者私网网关残留」（2026-10-16）。
 *
 * 由来：`conductor-lead` 的内置 spec 曾把主 Agent / 写子 Agent / 研究子 Agent 三档模型全钉在
 * `localhost`（开发者本机网关）。这些模型字段从 spec 里删掉之后，{@link refreshFromSpec} 的
 * 常规语义是「spec 未给值 ⇒ 不动现值」——于是**老安装里残留的 localhost 路由永远不会被清掉**，
 * 缺陷在老用户身上不消失（他那台机器上每次新建指挥会话照旧
 * `no adapter registered for provider "localhost"`，还要手动去设置里改）。故此处补一次定向清除。
 *
 * 收窄条件（重要，别过度清除）：
 * · 只在 **spec 已不再声明**该字段时动手（spec 仍声明 ⇒ 交给常规刷新语义）；
 * · 只在**现值与我们当年下发的 (provider, model) 配对精确相等**时才动
 *   （见 {@link DEV_PRIVATE_GATEWAY_RESIDUES}）——只匹配 provider 会误删用户自己叫
 *   `localhost` 的网关，`reasoningEffort` 不参与判定。
 * 不在这张表里的任何组合一律不碰（对照 `tests/builtin-roles.spec.ts` 的负向守卫
 * 「用户自己的本地网关原样不动」与「用户改过的字段：spec 不得覆盖」）。
 *
 * 三个字段的**落点不一样**（2026-10-16 指挥者裁定）：
 * · `subagentModel` / `researchModel` ⇒ **删除**键（absent = 不覆盖 ⇒ 子 Agent 继承会话路由，
 *   这正是用户拍板的语义）；
 * · `model` ⇒ **替换成产品默认**（见 {@link productDefaultModel}），不能删：创建路径给全新安装
 *   写的就是这个显式值，升级路径若删成 absent，那语义是「继承全局默认」——而用户的全局默认
 *   未必是它，全新装与老安装就此分叉。
 *
 * 唯一被它绕过的既有约定是「播种不改现值」：那种精确配对只可能由我们自己的 spec 写下，
 * 不是用户数据，所以没有基线的老安装也必须清（否则缺陷留痕最久的恰恰是那批用户）。
 *
 * 端到端落盘证明（不是只有内存对象）：`tests/builtin-profiles-e2e.spec.ts` —— 拿真实家目录
 * 那份 `agent.json` 的逐字副本在临时 home 里跑 `ensureBuiltinRoleProfiles()`，重读盘断言，
 * 并以 mtime/version 证明第二次不再写盘。
 *
 * @param next - 正在计算的 profile 副本（原地删除 / 替换）。
 * @param spec - 内置角色 spec（唯一事实源）。
 * @param baseline - 正在计算的新基线（被清字段记 null = spec 不再拥有它）。
 * @returns 是否真的动了东西（决定要不要落盘）。
 */
function pruneDevGatewayResidue(
  next: Record<string, unknown>,
  spec: BuiltinRoleSpec,
  baseline: Record<string, unknown>,
): boolean {
  let removed = false
  for (const residue of DEV_PRIVATE_GATEWAY_RESIDUES) {
    if ((spec as unknown as Record<string, unknown>)[residue.field] !== undefined) continue
    const current = next[residue.field] as { provider?: unknown; model?: unknown } | undefined | null
    if (current === undefined || current === null) continue
    if (String(current.provider) !== residue.provider) continue
    if (String(current.model) !== residue.model) continue
    if (residue.field === 'model') next[residue.field] = productDefaultModel()
    else delete next[residue.field]
    baseline[residue.field] = null
    removed = true
  }
  return removed
}

/**
 * 按「字段来源」计算一次幂等刷新（2026-09-14 用户拍板：手动改的配置属用户数据，
 * 不得在程序升级后被覆盖）。
 *
 * 语义：对每个可同步字段，
 * · spec 未给值 ⇒ 不动（保留现值；基线记 null 表示「spec 不拥有它」）；
 *   —— 例外：spec 停发的**开发者私网网关残留**会被定向清除（见 {@link pruneDevGatewayResidue}）。
 * · spec 给了值：
 *   - **当前值 === 基线值** ⇒ 用户没改过 ⇒ 写入 spec 值（让改名/演进落地）；
 *   - **当前值 !== 基线值** ⇒ 用户改过 ⇒ **保留用户值**；
 *   - 基线缺失（老安装）⇒ 同样**保守保留用户值**：宁可漏一次 spec 演进，也不静默覆盖。
 *
 * 两个既有契约由此同时满足：`tests/builtin-roles.spec.ts:126-137`（改名必须能落地）与
 * 用户原则（用户改过的字段不得被升级覆盖）。
 *
 * @param existing - 已有的 system profile。
 * @param spec - 内置角色 spec（唯一事实源）。
 * @returns 计算后的 profile、新的基线、以及是否发生变化（决定要不要落盘）。
 */
export function refreshFromSpec(
  existing: AgentProfile,
  spec: BuiltinRoleSpec,
): { next: AgentProfile; baseline: Record<string, unknown>; changed: boolean } {
  const prev = existing.specBaseline as Record<string, unknown> | undefined
  const next: Record<string, unknown> = { ...existing }
  const baseline: Record<string, unknown> = {}
  // 老安装（无基线）：**首次只播种、不改值**。
  //
  // 播种 = 把现值记成基线，于是「现值 === 基线值」⇒ 这些字段**从此**可以随 spec 演进刷新，
  // 而用户**今后**的任何修改都会被判为「改过」并永久保留。这一步本身不改任何现值，
  // 因此绝不会覆盖用户数据。
  //
  // 代价（如实记录）：**本次 spec 的改动对「本次之前就已偏离 spec」的老安装不追溯生效**
  // ——例如把 conductor-lead 的 subagentModel 从 glm-5.3-flash 改成 deepseek-v4.1-flash
  //（两个 id 都是开发者本机模型，该 profile 的模型钉已于 2026-10-16 整体删除），装了老
  // profile 的用户不会自动拿到新值（无法区分「它偏离 spec」是用户改的还是老默认）。
  // 需要追溯时须走**显式迁移**（按 profile.version 升版）或由用户在 设置→Agent 预设 里改。
  // 唯一的例外是**开发者私网网关残留定向清除**（见 `pruneDevGatewayResidue`）——那种值只可能
  // 来自我们自己的 spec，不是用户数据，故 spec 停发后必须主动删掉，否则「不追溯」会变成
  // 「缺陷永久留在老安装里」。
  const seeding = prev === undefined
  let changed = seeding   // 播种需要落盘一次，让基线持久化
  for (const field of SPEC_SYNCED_FIELDS) {
    const specValue = (spec as unknown as Record<string, unknown>)[field]
    if (seeding) {
      // 播种：基线 = **现值**（而不是 spec 值），这样不会被误判成「用户改过」，也不改现值。
      const currentValue = (existing as unknown as Record<string, unknown>)[field]
      baseline[field] = currentValue ?? null
      continue
    }
    baseline[field] = specValue ?? null
    if (specValue === undefined) continue
    const currentValue = (existing as unknown as Record<string, unknown>)[field]
    if (stableStringify(currentValue) !== stableStringify(prev![field])) continue   // 用户改过 ⇒ 保留
    if (stableStringify(currentValue) !== stableStringify(specValue)) {
      next[field] = specValue
      changed = true
    }
  }
  changed = pruneDevGatewayResidue(next, spec, baseline) || changed
  return { next: next as unknown as AgentProfile, baseline, changed }
}

/**
 * 确保全部行业角色预置 profile 存在（幂等）。
 * 与 ensurePm/ensureTask 同一纪律：system profile 的 prompt 随版本演进幂等
 * 刷新（保留用户的模型/能力/名片配置），user trust 的同名 profile 不动。
 * 在服务启动时调用一次（见 CorumAgentService 构造）。
 */
export function ensureBuiltinRoleProfiles(): void {
  // fork（corum）：已退役的内置角色——只删 trust:'system' 的家目录副本（用户自建同名
  // profile 不动）。2026-09-10 用户拍板：删除「Deepseek 编排者」（deepseek-orchestrator），
  // 其能力由基准模式「指挥模式」+ 内置角色「指挥模式」（`conductor-lead`）继承
  // （docs/fork-delta.md §10.8；角色昵称 2026-09-13 由「指挥者」改为「指挥模式」）。
  for (const retiredId of RETIRED_BUILTIN_ROLE_IDS) {
    const existing = loadProfile(retiredId)
    if (existing?.trust === 'system') deleteProfile(retiredId)
  }
  for (const spec of BUILTIN_ROLES) {
    const existing = loadProfile(spec.id)
    if (existing !== undefined) {
      // fork（corum）**2026-09-14 修正：用户数据不得被程序升级覆盖**（用户拍板原则）。
      //
      // 旧实现把 nickname/title/dimension/baseMode/prompt/model/subagentModel/researchModel
      // **八个字段按 spec 无条件覆写**，而注释却写着「保留用户的模型/能力/名片配置」——注释与
      // 代码相反；且 `tests/builtin-roles.spec.ts` 早就断言「仍然保留用户的模型/能力配置」。
      // 这八个字段**全部可在 设置→Agent 预设 里编辑** ⇒ 每次启动都会把用户修改**静默刷回**。
      //
      // 但也不能一刀切「全不刷」：`tests/builtin-roles.spec.ts:126-137` 钉住「改名必须落地」
      // （否则「指挥者→指挥模式」这类演进对既有安装静默不生效）—— 那条同样正确。
      //
      // 于是采用**按字段来源**判据（见 `AgentProfile.specBaseline` 与 {@link refreshFromSpec}）：
      // 当前值 === 基线值 ⇒ 用户没改过 ⇒ 随 spec 刷新；不等 ⇒ 用户改过 ⇒ 保留用户值。
      // 两个契约同时满足，且不靠「值恰好不同」这种脆弱判据。
      if (existing.trust === 'system') {
        const { next, baseline, changed } = refreshFromSpec(existing, spec)
        if (changed) saveProfile({ ...next, specBaseline: baseline })
      }
      continue
    }
    const profile: AgentProfile = {
      id: spec.id,
      nickname: spec.nickname,
      title: spec.title,
      dimension: spec.dimension,
      baseMode: spec.baseMode,
      prompt: spec.prompt,
      // fork（corum）：模型兜底——spec 声明了就照它的写，否则落到产品默认的
      // deepseek-official flash。（历史上这里写的是「编排专用 Agent 指定本地模型」，指的是
      // conductor-lead 曾钉开发者本机网关那件事，2026-10-16 已纠正：内置角色不携带私网 provider。）
      // 取值走 {@link productDefaultModel} 这个**单一事实源**，不在这里再写一份字面量——
      // 「同一件事有两处认知」正是本缺陷的成因类型（清残留时的替换值也必须与它同一个）。
      model: spec.model ?? productDefaultModel(),
      ...(spec.executionTools !== undefined ? { executionTools: spec.executionTools } : {}),
      // 子 Agent 模型：**spec 不声明就不写键**（= 不覆盖 ⇒ 会话路由决定），而不是写成默认值——
      // 写一个具体 provider 就等于替用户锁死路由。
      ...(spec.subagentModel !== undefined ? { subagentModel: spec.subagentModel } : {}),
      ...(spec.researchModel !== undefined ? { researchModel: spec.researchModel } : {}),
      ...(spec.parallelWork !== undefined ? { parallelWork: spec.parallelWork } : {}),
      ...(spec.avatar !== undefined ? { avatar: spec.avatar } : {}),
      skills: [],
      mcpServers: [],
      terminal: { mode: 'sandbox' },
      // 记忆策略：spec 声明了就照它的写（chat 模式用 scope:'none'），否则默认 'agent'。
      memoryPolicy: spec.memoryPolicy ?? { scope: 'agent' },
      version: 1,
      trust: 'system',
    }
    saveProfile(profile)
  }
}
