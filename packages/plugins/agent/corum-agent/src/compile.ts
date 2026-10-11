/**
 * AgentProfile → preset 编译（路径 A 的核心）。
 *
 * 把 AgentProfile 翻译成一份 agent.cordis.yml 文本 + preset.yml 元数据，
 * 落盘到 agent-presets 的 user root（`~/.corum/.agent-presets/<id>/`），
 * 再由 `ctx.agentPresets.mount(agentCtx, id)` 走官方组装链路。
 *
 * 编译架构（2026-09-02 用户定调）：corum Agent **默认继承官方 standard 模式**
 * （standard 全量行）+ corum 覆盖/增量，不是另一套精简组合。
 *   prompt        → persona 行（text，替换官方模板）
 *   model         → 不进 preset（创建 Agent 时的 agentOptions）
 *   skills        → skill-filesystem 覆盖行（includeDefaultRoots:false +
 *                   customSkillDirs = 集中技能库里该 Agent 被授权的目录，
 *                   即 `<CORUM_HOME>/skills/<绑定名>`；技能实体由 corum
 *                   统一管理，Agent 只按 name 引用，不复制文件）
 *   mcpServers    → corum-mcp-proxy 追加行（每 server 一行，只带 serverName）
 *   terminal      → **保持官方两行**（一次性 tool-bash/tool-pwsh，2026-09-14 撤销
 *                   了 persistent-shell 持久终端组覆盖；sandbox 由 host 层提供）
 *   filesystem    → 追加 fs-local + str-replace-editor 组（与 standard 沙箱
 *                   tool-fs 并存）
 *   memoryPolicy  → 不进 preset（记忆由专属工具/服务注入，后续接入）
 *
 * 纯函数，无副作用：输出两份文件的内容，由调用方落盘。
 * @module @corum/corum-agent/compile
 */

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { McpServerConfig } from '@corum/corum-mcp-manager'
import type { AgentProfile, BaseMode, ProfileModel, ProfileChildModel, PersonaPreset, ParallelWorkPolicy } from './profile.ts'
import { FOLLOW_MAIN } from './profile.ts'
// fork（corum）：指挥模式的指挥者人格——基准模式与 corum 角色（baseMode: 'conductor'）
// 共用同一段文本（单一事实源，见 conductor.ts）。
import { CONDUCTOR_PERSONA } from './conductor.ts'

/**
 * corum 运行目录（统一 home 解析，废弃 ~/.dsh）。
 * 桌面进程已把 DSH_HOME 指向 CORUM_HOME（见 corum-desktop/host/home.ts），
 * 所以 skill 根 = CORUM_HOME/skills。纯函数模式下优先读 CORUM_HOME。
 */
function corumHome(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : '~/.corum'
  return resolveDshHome(configured)
}

/** 一行 cordis 配置（编译成 YAML 的中间表示）。 */
interface CordisRow {
  id: string
  name: string
  config?: Record<string, unknown>
  /** 布尔或 `!!js ...` 表达式字符串（YAML 标记）。 */
  disabled?: boolean | string
  group?: boolean
  isolate?: Record<string, boolean>
  children?: CordisRow[]
}

/** 编译结果：preset 目录的两份文件内容。 */
export interface CompiledPreset {
  /** agent.cordis.yml 文本。 */
  cordisYml: string
  /** preset.yml 文本。 */
  presetYml: string
}

/**
 * 官方 standard preset 的全量行（2026-09-02 用户定调：corum Agent **默认继承
 * 官方 standard 模式**——corum Agent 是 standard 的拓展，不是另一套精简组合）。
 * 来源：`@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml`。
 *
 * 中间表示与官方逐行对应（persona/tool-bash/tool-pwsh/tool-fs/tool-fs-search/
 * tool-jobs/skill-filesystem/tool-skill/command-goal/tool-goal/planning 组/
 * compaction 组/delegation 组/tool-ask-user/tool-todo/tool-web）。
 *
 * **官方升级同步**：bump dsh-agent-presets 后，对照官方 standard 源文件逐行
 * diff 本数组（结构一致，机械合并）。
 *
/**
 * fork #10 双实例行的 config 构造：profile 级覆盖（parallelWork/subagentModel/
 * researchModel）。**三级配置模型下，parallelWork 只剩 `maxParallelChildren` 可由
 * preset 覆盖**（2026-09-21 裁定：隔离 / 合并相关键已从 `ParallelWorkPolicy` 移除，
 * 机制恒定生效，见 profile.ts）；模型锁（subagentModel/researchModel）仍由 profile 决定。
 */
function corumSubagentConfig(
  role: 'worker' | 'research',
  profile: { subagentModel?: ProfileChildModel; researchModel?: ProfileChildModel; parallelWork?: ParallelWorkPolicy; executionTools?: 'full' | 'orchestrator' },
  mcpDenyNames: readonly string[],
): Record<string, unknown> {
  const pw = profile.parallelWork
  const config: Record<string, unknown> = {
    provider: 'corum-spawn',
    toolName: role === 'worker' ? 'subagent' : 'subagent_research',
    modelSelectionSettings: false,
    backgroundMode: 'continuable',
  }
  // fork（corum）：orchestrator 模式收紧 worker 的 maxDepth 为 1——子 Agent 只执行、
  // 不再派孙 Agent（编排职责完全收归主 Agent，避免多层嵌套失控 + 省 token）。
  // （PLAN-deepseek-orchestrator-agent.md §6 决策：maxDepth 收紧到 1）
  if (role === 'worker' && profile.executionTools === 'orchestrator') {
    config.maxDepth = 1
  }
  // 模型锁（机制固化，设什么跑什么；research 键不存在时缺省同 worker）。
  //
  // ⚠️ 三态（2026-10-11）：`FOLLOW_MAIN` 是**非空字符串**，`??` 不会穿透它——这是刻意的。
  //   · `undefined`（键不存在）= 不覆盖 ⇒ 不写 config.model，运行期走全局档；
  //   · `FOLLOW_MAIN` = 显式跟随主 Agent ⇒ 写 `modelFollowMain: true`，运行期**跳过**全局档；
  //   · 具体路由 = 写 config.model。
  // research 的回落只看**键是否存在**（`!== undefined`），不能用 `??`：否则
  // `researchModel: FOLLOW_MAIN` 会被 `??` 判为"有值"而正确保留——这点 `??` 恰好也对，
  // 但 `researchModel: FOLLOW_MAIN` 与 `researchModel: undefined` 必须落到不同结果，
  // 写明判据避免后人误用 `??` 之外的写法（如 `||`，它会把 FOLLOW_MAIN 当假值穿透）。
  const childModel: ProfileChildModel | undefined =
    role === 'worker' ? profile.subagentModel : (profile.researchModel !== undefined ? profile.researchModel : profile.subagentModel)
  if (childModel === FOLLOW_MAIN) {
    // 显式跟随主 Agent：不写 config.model（与"不覆盖"同形），用独立标志让运行期区分。
    config.modelFollowMain = true
  } else if (childModel !== undefined) {
    config.model = {
      provider: childModel.provider,
      model: childModel.model,
      ...(childModel.reasoningEffort !== undefined && childModel.reasoningEffort !== ''
        ? { reasoningEffort: childModel.reasoningEffort }
        : {}),
    }
  }
  if (role === 'research') {
    // 只读研究实例：deny **变异**工具（write/edit/str_replace_editor）+ 已授权 MCP 前缀，
    // **保留 shell**（调研要跑命令）；只读性由子会话沙箱 read-only 保证（2026-09-12 用户定调）。
    config.readonlyResearch = true
    config.toolFilter = { deny: [...corumMutationToolsForPlatform(), ...mcpDenyNames] }
    return config
  }
  // worker 实例：**只有 maxParallelChildren 可由 preset 覆盖**（2026-09-21 裁定，
  // 隔离 / 合并机制恒定生效，不再透传 isolation/merger/integrateChecks）。
  if (pw?.maxParallelChildren !== undefined) config.maxParallelChildren = pw.maxParallelChildren
  return config
}

/** fork #10：写工具清单（research 实例预 deny；与 fork #10 常量对账，见单测）。 */
const CORUM_WRITE_TOOLS = ['str_replace_editor', 'write', 'edit', 'bash', 'pwsh']

/**
 * fork（corum）：只读研究实例要 deny 的**变异**工具（2026-09-12 用户定调）。
 *
 * 用户要求「research 需要开放 shell 来执行命令完成调研」——调研常要跑命令（`git log`、
 * 读 PID 文件、verify 脚本的 `status`）。只读性因此分两层：**工具面 deny 变异工具** +
 * **子会话沙箱钉 `read-only`**（见 corum-subagent 的 `readonlySandbox`）。与
 * `@corum/corum-orchestration` 的 `corumMutationToolsForPlatform` 逐字对账
 * （dev-conventions §4a 的两处对账纪律）。
 */
const CORUM_MUTATION_TOOLS = ['str_replace_editor', 'write', 'edit']

/** 本平台的变异工具名（research 的 deny 名单）。 */
function corumMutationToolsForPlatform(): readonly string[] {
  return CORUM_MUTATION_TOOLS
}

/**
 * 平台实际存在的写工具（deny 名单只能包含已注册工具——tools.restrict 对未知名
 * fail loud。pwsh 仅在 win32 装载，见 standardRows tool-pwsh 行的 !!js 条件）。
 */
function corumWriteToolsForPlatform(): readonly string[] {
  return process.platform === 'win32'
    ? CORUM_WRITE_TOOLS
    : CORUM_WRITE_TOOLS.filter(t => t !== 'pwsh')
}

function standardRows(): CordisRow[] {
  return [
    // ── identity ──
    // agent-instructions 原在 identity 区；corum 把它移进 filesystem 组（与
    // fs-local 同 realm）——它经 `ctx.get('fs')` 读 AGENTS.md，必须命中 realm 内
    // 的 fs-local（见下方 filesystem 组注释）。在此删除，避免重复注册。

    // ── shell（一次性 bash/pwsh，官方两行原样；corum 不再覆盖为持久终端）──
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: '!!js process.platform === \'win32\'' },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: '!!js process.platform !== \'win32\'' },

    // ── filesystem（沙箱工具集；corum 追加 fs-local 裸本地 FS）──
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },

    // ── background jobs ──
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },

    // ── skills（skill-filesystem 由 corum 按 profile.skills 定制覆盖；tool-skill 保留）──
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },

    // ── goals ──
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },

    // ── plan mode（entry-local realm 是正确生命周期）──
    {
      id: 'planning',
      name: 'cordis:group',
      group: true,
      isolate: { planMode: true },
      children: [
        {
          id: 'plan-mode',
          name: '@deepseek-ai/dsh-plan-mode',
          config: {
            section:
              'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user\'s conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.\n\n'
              + 'Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.\n\n'
              + 'The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.\n\n'
              + 'Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.\n\n'
              + 'Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.\n\n'
              + 'When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.',
          },
        },
      ],
    },

    // ── compaction（compaction-basic + command-compact + tool-result-pruner 同 realm）──
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      children: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        },
      ],
    },

    // ── delegation & workflows（subagent 全家；workflowEngine realm）──
    {
      id: 'delegation',
      name: 'cordis:group',
      group: true,
      isolate: { workflowEngine: true },
      children: [
        { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
        { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
        // fork（corum）：tool-subagent 行由 compilePreset 的 fork #10 双实例替换
        // （corumSubagentRows），此处仅占位注释——行序保持 delegation 组语义。
        // 官方 fork provider 实例 2026-09-09 退役（用户拍板 A 案，
        // docs/PROMPT-INVENTORY.md §4）：它不走 corum 机制（无隔离/模型锁/settlement
        // notice/并发感知），提示词里的「后台默认」段落又与 subagent 近乎逐字重复，
        // 人格段也没提它（模型可能误选）。若将来需要「带父会话上下文的子会话」，
        // 应作为能力并入 corum worker 的 provider 选择，而不是复活本行。
        {
          id: 'tool-subagent-fork',
          name: '@deepseek-ai/dsh-tool-subagent',
          disabled: true,
          config: { provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable' },
        },
        {
          id: 'tool-subagent-codex',
          name: '@deepseek-ai/dsh-tool-subagent',
          disabled: true,
          config: { provider: 'codex', toolName: 'subagent_codex', backgroundMode: 'one-shot', maxDepth: 'provider-managed' },
        },
        {
          id: 'tool-subagent-claude-code',
          name: '@deepseek-ai/dsh-tool-subagent',
          disabled: true,
          config: { provider: 'claude-code', toolName: 'subagent_claude_code', backgroundMode: 'one-shot', maxDepth: 'provider-managed' },
        },
        // fork（corum）：**引擎行恢复挂载**（2026-09-27 用户拍板：「指挥模式就是希望用
        // orchestrate 才设计的，一定要挂」）。
        //
        // Phase 5 曾把官方 workflow 全家（workflow-worker-thread + tool-workflow +
        // tool-ralph）退役，理由是「方案甲用 orchestrate 取代官方通用脚本引擎」。该理由
        // **对 orchestrate 本身不成立**：orchestrate 的 script 模式正是构建在这个引擎之上
        // ——`corum-tool-subagent` 里 `runtimeCtx.get('workflowEngine', false)` 取不到就抛
        // `orchestrate script mode requires the workflow engine; this preset does not mount
        // @deepseek-ai/dsh-workflow-worker-thread`。只留 `isolate: { workflowEngine: true }`
        // 的 realm 而不挂 provider ⇒ **工具在列、一调用即失败**（实测 2026-09-27，指挥模式
        // 会话 `corum-task-56b7d485`：主 Agent 按 orchestrate 做计划，第一次派发即报错，
        // 只能退化成单发 subagent，整轮多烧 20 次派发）。
        //
        // 恢复范围刻意最小：**只恢复引擎行**。`tool-workflow`（模型面的第二个自撰编排
        // 语言）与 `tool-ralph` 的退役理由（与 orchestrate 功能重叠）不受影响，继续不挂。
        // 引擎的 provider 只是默认值——orchestrate 起引擎时显式传 `corum-isolated`，
        // 脚本派出的子 Agent 仍走 corum 隔离 + 台账 + settlement notice（见该工具的注释）。
        {
          id: 'workflow-worker-thread',
          name: '@deepseek-ai/dsh-workflow-worker-thread',
          config: { provider: 'corum-spawn' },
        },
      ],
    },

    // ── 其余模型面行 ──
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
    // ── deliverables（present：声明已写文件为最终交付物，用户以文件卡片打开；
    // 宿主工具，无自有客户端 UI；配套 ui-deliverables 已在 cordis.ide.patch.yml 启用。
    // 官方 0.1.5 standard 新增，紧跟 tool-web 之后；与 corum 的 tool-presentation
    // 不冲突——后者只在 ptc 模式挂载）──
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
  ]
}

/**
 * 把一个 AgentProfile 编译成 preset 目录内容。
 *
 * **2026-09-02 架构定调（用户）**：corum Agent **默认继承官方 standard 模式**
 * （standard 全量行）+ corum 覆盖/增量：
 * - `persona` 替换为 profile.prompt（不用官方模板，且不用 complete:true——让
 *   框架正常组装完整 system prompt，与官方 headless bundle 一致）；
 * - `tool-bash`/`tool-pwsh` **保持官方两行不动**（2026-09-14 撤销了曾经的
 *   persistent-shell 持久终端组覆盖；见下方「corum 覆盖 ⓪」段的撤销理由）；
 * - `skill-filesystem` 替换为 corum 定制（includeDefaultRoots:false + 按
 *   profile.skills 绑定的 customSkillDirs）；
 * - 追加 `filesystem` 组（fs-local 裸本地 FS + str-replace-editor，corum 基础
 *   编辑能力，与 standard 的沙箱 tool-fs 并存）；
 * - 追加 MCP 行（profile.mcpServers 授权的服务）；
 * - 其余 standard 行原样保留（agent-instructions/tool-fs/tool-fs-search/tool-jobs/
 *   goal/plan/compaction/subagent/workflow/todo/web）。
 *
/**
 * dsh 四种预设模式的基础 persona 文本（兜底用）。
 * 来源：shipped-presets/official/<mode>/agent.cordis.yml 中的 persona config.text。
 * 仅在「用户身份段全空」时整体回退，保证 persona 非空、模型有基本身份。
 */
const BASE_MODE_PERSONA: Record<BaseMode, string> = {
  standard: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
  ptc: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
  // 指挥模式：无用户身份段时用指挥者人格（+ 模型/目录占位行）。
  conductor: `${CONDUCTOR_PERSONA}\n\nYou are powered by the {{model}} model. Your working directory is {{cwd}}.`,
  minimal: 'You are a helpful software engineer assistant.',
  cordis: 'You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness. Your working directory is {{cwd}}.\n'
    + '\nYou can read and modify the harness you run on. Its composition is Cordis:\n'
    + '- Every capability is a plugin row in a `cordis.yml`.\n'
    + '- An agent preset is one such file, mounted for a single session.',
}

/**
 * 模式核心身份（每模式独立声明，参与结构化组装的最前段）。
 *
 * 与用户身份段（domain/title/persona/prompt）解耦：核心身份表达「这个模式本身是什么」，
 * 用户身份段表达「这个 Agent 是什么专家」。null = 该模式无独立核心身份，由用户身份段覆盖。
 *
 * - standard / ptc：null —— coding-agent 模板属「官方默认身份」，继承时应被用户身份段
 *   覆盖而非保留（用户自建 Agent 不希望顶一句 "You are a coding agent"）。
 * - minimal：保留「通用软件工程助手」自述 —— 极简模式的核心身份，与领域限定叠加。
 * - cordis：保留 harness 自述 —— 「你是 harness、可读写自己」不可丢，是该模式存在的意义。
 */
const MODE_CORE_IDENTITY: Record<BaseMode, string | null> = {
  standard: null,
  ptc: null,
  // 指挥模式：指挥者身份是该模式的核心（不可丢），再接用户身份段。
  conductor: CONDUCTOR_PERSONA,
  minimal: 'You are a helpful software engineer assistant.',
  cordis: BASE_MODE_PERSONA.cordis,
}

/** 极简模式的特殊 flag（complete + suppressRuntimeContext）。 */
const BASE_MODE_COMPLETE: Set<BaseMode> = new Set(['minimal'])

/**
 * 编译 AgentProfile 为 preset 目录的两份文件。
 *
 * persona 拼接逻辑：基础模式 persona + "\n\n" + 用户自定义提示词。
 * 极简模式特殊：persona complete=true，自定义提示词追加在 complete persona 之后
 * （complete 模式下 system-prompt 只渲染 persona section，所以拼接后仍有效）。
 *
 * @param profile - AgentProfile。
 * @returns 两份文件文本（agent.cordis.yml + preset.yml）。
 */
/**
 * corum 自定义 persona 结构化组装（四种模式统一）。
 *
 * 先按固定段落拼装成完整 persona 文本（含 dsh 变量占位 {{model}}/{{cwd}}），
 * 再交 dsh agentLoop 做变量插值与 section 装配。各段按字段非空拼接。
 *
 * 结构：[模式核心身份(可选)] + 专业领域 + 岗位 + 人格 + 工作职责 + 模型/工作目录占位。
 * （{{memory摘要}} 段预留——待 Agent memory 机制设计完成后再接入，当前不参与组装。）
 *
 * 模式核心身份取自 MODE_CORE_IDENTITY（每模式独立声明，可空）：minimal=通用软件工程
 * 助手自述、cordis=harness 自述，standard/ptc=空（官方 coding-agent 模板被用户身份段覆盖）。
 *
 * @param profile - AgentProfile。
 * @param coreIdentity - 模式核心身份文本（MODE_CORE_IDENTITY 值，null 则不拼该段）。
 */
/**
 * 取一个 profile 的**工作风格人格**文本（= 设置里那个「人格」，如专业干练）。
 *
 * 与「角色人格」严格区分（2026-09-11 用户定调）：
 * - **角色人格**（`title` / `domain` / `persona` / `prompt`）——「你是谁、你负责什么」，
 *   指挥模式下**不**被子 Agent 继承（否则子 Agent 会自称指挥者、被 iron rule 告知
 *   "you physically cannot write / edit / bash"，而它实际有全套写工具）；
 * - **工作风格人格**（`personaPreset`）——「怎么干活」，**要**被子 Agent 继承。
 *
 * @param profile - Agent 配置。
 * @returns 英文风格段；未设或自定义（`custom`）时 undefined。
 */
export function workStyleTextOf(profile: { personaPreset?: string | undefined }): string | undefined {
  const preset = profile.personaPreset
  if (preset === undefined || preset === 'custom') return undefined
  return PERSONA_PRESET_PROMPTS[preset as Exclude<PersonaPreset, 'custom'>]
}

/**
 * 工作场景人格预设 → 英文系统提示词片段（组装时映射为英文，除非用户自定义写了汉字）。
 * 四大工作场景人格原型组合，覆盖代码审查/带教/执行/预研四类核心场景。
 */
const PERSONA_PRESET_PROMPTS: Record<Exclude<PersonaPreset, 'custom'>, string> = {
  'rigorous-architect':
    'You are an extremely rigorous technical expert. Before outputting any solution, ' +
    'you must first list boundary conditions and potential failure risks. Your responses ' +
    'must follow a "conclusion-argument-example" structure. For ambiguous requirements, ' +
    'you must proactively ask clarifying questions and never make assumptions.',
  'steady-coach':
    'You are an experienced team mentor. When facing problems, first provide the top-level ' +
    'design thinking, then offer concrete implementation details. For immature proposals ' +
    'from juniors, first extract their reasonable aspects, then gently point out gaps. ' +
    'All suggestions must include actionable acceptance criteria.',
  'efficient-executor':
    'You take action and results as the highest priority. Responses must follow the ' +
    'conclusion-first principle: lead with the conclusion, then the supporting evidence. ' +
    'For complex tasks, you must ' +
    'break them down into a "to-do list" with time estimates. When blocked, directly ' +
    'provide alternative solutions without emotional preamble.',
  'innovative-explorer':
    'You are a curious technical explorer. Beyond the "conventional solution", you must ' +
    'also provide "out-of-the-box alternatives". You enjoy citing cross-disciplinary cases ' +
    'and are good at searching for cutting-edge public information beyond the internal knowledge base.',
}

/**
 * 取人格段的英文文本：预设走 PERSONA_PRESET_PROMPTS 映射；custom 或补充走 persona 原文。
 * 预设与补充可叠加（预设为主，补充在后）。
 */
function resolvePersonaText(profile: AgentProfile): string | null {
  const parts: string[] = []
  if (profile.personaPreset !== undefined && profile.personaPreset !== 'custom') {
    parts.push(PERSONA_PRESET_PROMPTS[profile.personaPreset])
  }
  if (typeof profile.persona === 'string' && profile.persona.trim() !== '') {
    const persona = profile.persona.trim().replace(/[。.．]+$/u, '')
    parts.push(persona)
  }
  return parts.length > 0 ? parts.join(' ') : null
}

/**
 * corum 自定义 persona 的 **prefix**（身份段）——官方 0.1.5 的 `dsh-persona` config
 * 已从单字段 `text` 改为 `prefix`（身份，必填）+ `suffix`（附加内容，可选）。
 *
 * prefix 段 = 模式核心身份 + 岗位句 + 域边界条款 + 模型/工作目录占位行
 * （即 persona 拼装中除「人格(`Your working style: …`)」与「职责(`Your responsibilities: …`)」
 * 以外的所有段；这两段归 suffix，见 {@link composePersonaSuffix}）。
 *
 * @param profile - AgentProfile。
 * @param coreIdentity - 模式核心身份文本（MODE_CORE_IDENTITY 值，null 则不拼该段）。
 * @returns prefix 文本（恒非空：最末段为模型/目录占位行）。
 */
function composePersonaPrefix(profile: AgentProfile, coreIdentity: string | null): string {
  const segments: string[] = []
  // 模式核心身份（如 cordis harness 自述 / minimal 通用助手自述）。
  if (coreIdentity !== null && coreIdentity !== '') segments.push(coreIdentity)
  // 身份句：岗位（领域限定帮助模型路由到合适专家）。
  const title = typeof profile.title === 'string' ? profile.title.trim() : ''
  if (title !== '') segments.push(`You are a ${title}.`)
  // 域边界条款（L1 运行时自判域）：对「有专业定位」的 Agent 注入。判定 = title
  // 非空——用户创建 Agent 时填了岗位，即视为专用 Agent，接到明显越界任务时
  // 「声明越界 + 建议切通用/对应 Agent」而非硬拦（用户决策，见 DESIGN §2）。
  // 通用 Agent（Task 助理/PM 助理等 title 为空者）不注入、不受限。读越界可作
  // 参考，写/深入分析越界禁止。
  if (title !== '') {
    segments.push(
      `Your domain is strictly ${title}. Work outside this domain is out of scope. ` +
      `When a task clearly belongs to a different domain (for example a frontend task assigned to an embedded engineer), ` +
      `do NOT attempt it: briefly state that it is outside your domain, name the kind of Agent better suited ` +
      `(a general-purpose Agent or the matching specialist), and ask the user to switch. ` +
      `Do not analyze, design, or modify out-of-domain work. Within your domain you may read across the project ` +
      `for reference, but only create or modify what your role owns.`,
    )
  }
  // 模型 + 工作目录占位（dsh 变量，render 时插值；variables 全局注册，与 complete/
  // suppressRuntimeContext 无关，minimal 下仍有值）。
  segments.push('You are powered by the {{model}} model. Your working directory is {{cwd}}.')
  return segments.join('\n\n')
}

/**
 * corum 自定义 persona 的 **suffix**（附加内容段）= 人格（做事风格）+ 工作职责。
 *
 * 对应 persona 拼装中 `Your working style: …` 与 `Your responsibilities: …`
 * 两段（与 {@link composePersonaPrefix} 互补：prefix 拼身份，suffix 拼风格与职责）。
 * 无内容时返回空串（`complete: true` 会抑制 suffix）。
 *
 * @param profile - AgentProfile。
 * @returns suffix 文本；无人格且无提示词时为空串。
 */
function composePersonaSuffix(profile: AgentProfile): string {
  const segments: string[] = []
  // 人格（做事风格）：预设走英文映射，custom 或补充走 persona 原文（可含汉字）。
  const personaText = resolvePersonaText(profile)
  if (personaText !== null) {
    segments.push(`Your working style: ${personaText}.`)
  }
  // TODO(memory): 「你有丰富的工作经验：{{memory摘要}}」段——待 memory 机制后接入，当前不组装。
  // 工作职责（用户自定义提示词）。
  if (profile.prompt.trim() !== '') {
    segments.push(`Your responsibilities: ${profile.prompt.trim()}`)
  }
  return segments.join('\n\n')
}

export function compilePreset(profile: AgentProfile): CompiledPreset {
  // persona 走官方 0.1.5 的 prefix/suffix 字段（`dsh-persona` config 已从单字段
  // `text` 改为 `prefix`(身份,必填) + `suffix`(附加内容,可选)）。
  // 模式核心身份（MODE_CORE_IDENTITY）与用户身份段解耦：
  // - standard/ptc：核心身份为空，纯用户身份段（standard 即用户自建覆盖官方模板）。
  // - cordis：核心身份=harness 自述（不可丢），再接用户身份段。
  // - conductor：核心身份=指挥者人格（不可丢），再接用户身份段。
  // - minimal：见下方 minimal 分支——保持官方原汁原味。
  const basePersona = BASE_MODE_PERSONA[profile.baseMode] ?? BASE_MODE_PERSONA.standard
  const isComplete = BASE_MODE_COMPLETE.has(profile.baseMode)
  const coreIdentity = MODE_CORE_IDENTITY[profile.baseMode] ?? null

  let personaPrefix: string
  let personaSuffix: string
  if (isComplete) {
    // ⚠️ 用户裁决（2026-09-29）：minimal 模式「保持官方原汁原味」。
    // 官方 minimal preset 的 persona = 恰好一句 `You are a helpful software
    // engineer assistant.`，不拼任何用户 persona / prompt / corum 纪律 / 输出语言
    // 段（corumMinimalDisciplineLines() 与 outputLanguageSectionText() 在 minimal 下
    // **不再注入**——这是用户裁决的必然结果）。suffix 给空串（`complete: true` 会
    // 抑制 suffix，但显式传空串更清晰，也避免 dsh-persona schema 默认值兜底时行为漂移）。
    personaPrefix = basePersona
    personaSuffix = ''
  } else {
    // 非 minimal：prefix = 身份段（核心身份 + 岗位 + 域边界 + 模型/目录占位），
    // suffix = 人格（working style）+ 工作职责（responsibilities）。
    const hasIdentitySubstance =
      (coreIdentity !== null && coreIdentity !== '') ||
      (typeof profile.title === 'string' && profile.title.trim() !== '')
    // 无核心身份且无岗位时回退 basePersona（保留 standard/ptc 的官方 coding-agent 身份句），
    // 避免 prefix 只剩模型/目录占位行。
    personaPrefix = hasIdentitySubstance ? composePersonaPrefix(profile, coreIdentity) : basePersona
    personaSuffix = composePersonaSuffix(profile)
  }

  const rows: CordisRow[] = [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        prefix: personaPrefix,
        suffix: personaSuffix,
        ...(isComplete ? { complete: true, includeRuntimeContext: false } : {}),
      },
    },
    // fork（corum）：preset 恒全量编译（含执行工具行）——orchestrator 模式的「主 Agent
    // 裁执行工具」**不能**在 preset 编译裁行实现：fork #9 applyChildComposition 让子 Agent
    // composeFrom(parent.ctx) 复用父 preset，preset 裁了什么子 Agent 也没什么（实机暴露：
    // 裁 filesystem/tool-fs 后子 Agent 也没写工具无法执行）。正确做法：preset 全量，
    // 主 Agent 裁执行工具走运行时 tools.restrict 只作用于主 Agent scope（见
    // agent-service.ts 的 orchestrator 分支），子 Agent join 全量 preset 仍全功能。
    ...standardRows(),
  ]

  // fork（corum）双实例行：worker（subagent，全功能+隔离）+ research
  // （subagent_research，只读不可移除）——插在 delegation 组 tool-subagent-fork
  // 之前（原官方 tool-subagent 行位）。MCP deny 名单 = 已授权 MCP 服务工具前缀。
  const mcpDenyNames = resolveMcpServers(profile.mcpServers).map(m => m.name)
  const delegation = rows.find(r => r.id === 'delegation')
  if (delegation?.children !== undefined) {
    const forkIdx = delegation.children.findIndex(c => c.id === 'tool-subagent-fork')
    const insertAt = forkIdx >= 0 ? forkIdx : delegation.children.length
    delegation.children.splice(insertAt, 0,
      {
        id: 'tool-subagent',
        name: '@corum/corum-tool-subagent',
        config: corumSubagentConfig('worker', profile, mcpDenyNames),
      },
      {
        id: 'tool-subagent-research',
        name: '@corum/corum-tool-subagent',
        config: corumSubagentConfig('research', profile, mcpDenyNames),
      },
    )
  }

  // corum 覆盖 ⓪（2026-09-14 撤销）：**持久终端组已移除，回到官方 standard 口径的
  // 一次性 tool-bash/tool-pwsh。**
  //
  // 历史：corum 曾在此处 splice 掉官方 standardRows 的
  //   { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: win32 }
  //   { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: !win32 }
  // 两行，换成 `cordis:group` persistent-shell（pty + terminal-bash +
  // persistent-bash + terminal-pwsh + persistent-pwsh）。现整段删除 → 官方两行
  // 原样保留（它们本来就是平台互斥 disable，无需 corum 再写一遍）。
  //
  // 为什么撤（三条实证，见本轮报告）：
  //   1. 持久 PTY 的 stdin 永不 EOF：裸 `grep foo`（无文件参数）实测挂满整整
  //      300000ms 才被 deadline 砍掉、并 reset 整个会话（丢掉 cwd/环境）。
  //      实测时间戳 1789316451 → 1789316751 = 300s。
  //   2. 一次性执行器的 spawn 用 stdio.stdin='ignore'
  //      （@deepseek-ai/dsh-bash-local lib/index.js:190）→ 子进程拿到立即 EOF，
  //      同一裸 `grep foo` 实测 **6ms** 返回 exit 1 而不是挂死。
  //   3. 官方 2026-09-08 提交 1f1537914f 的动机自述是「minimal 服务的是同一批
  //      trained against a one-shot bash tool 的模型」，官方只把持久 shell 的
  //      **输出表面**对齐到一次性契约，超时/stdin/heredoc 语义没动 —— 即官方
  //      自己把一次性 bash 当模型认知的基准契约。
  //
  // 影响面：模型可见的 shell 工具从 `bash`（参数只有 command，插件级 300000ms
  // deadline）变成 `bash`（参数含 command/description/timeoutMs/workdir/
  // run_in_background，per-call timeoutMs **真的能被兑现**，见下）。
  // 落地后 shell 工具的面与超时全部由官方 base 行提供：
  //   · ctx.shell 提供方 = 官方 base 的 bash-sandbox 行（darwin 启用，
  //     config.timeoutMs: 60000，即**不传 per-call timeoutMs 时的默认 60s**）；
  //   · 模型可见工具 = 官方 standard preset 的 tool-bash 行。
  // 本文件不再为 shell 提供任何 config 或 description —— 也就不存在
  // 「description 与真实参数面不一致」的漂移（这正是 2026-09-14 效率整改轮那条
  // 回归的根因；现在该回归的**前提**已消失，见 tests/compile-base-modes.spec.ts）。
  //
  // 附带收益：bash-local 的 stdio.stdin='ignore' 让「缺终止符 heredoc」也变成
  // 立即失败（实测 10ms，exit 0 且文件被正确写入），不再是静默挂 300s。
  //
  // 回滚方案：本段删除是单点改动、无跨包耦合，把上面那段注释描述的两行 splice
  // 恢复即可（git revert 该 commit；CordisRow/rows 机制原样保留，未改任何机制）。

  // corum 覆盖 ①：skill-filesystem 按 profile.skills 定制（全局统一管理、按
  // Agent 授权可见）。standard 只有 tool-skill，skill-filesystem 行在 tool-skill 前插入。
  const skillsRoot = join(corumHome(), 'skills')
  const customSkillDirs = profile.skills.map(b => join(skillsRoot, b.name))
  const toolSkillIdx = rows.findIndex(r => r.id === 'tool-skill')
  rows.splice(toolSkillIdx, 0, {
    id: 'skill-filesystem',
    name: '@deepseek-ai/dsh-skill-filesystem',
    config: {
      includeDefaultRoots: false,
      ...(customSkillDirs.length > 0 ? { customSkillDirs } : {}),
    },
  })

  // corum 追加 ③：filesystem 组（fs-local 裸本地 FS + str-replace-editor）。
  // fs 服务的可见性：host 已在 root realm 注册 fs-sandbox（SandboxedFileSystem），
  // 若 fs-local 也直接挂 root realm 会因同名 `fs` 重复注册而 mount 失败
  // （2026-09-08 实测：service "fs" has been registered at <SandboxedFileSystem>）。
  // 所以 fs-local 走 realm 私有符号（isolate:fs），不与沙箱 fs 抢 root。
  // 但 `dsh-agent-instructions` 经 `ctx.get('fs')` 读 AGENTS.md 基线——它必须
  // 看到 fs-local：把它移进本组（同 realm），这样它 `ctx.get('fs')` 命中
  // realm 内的 fs-local（否则在组外拿到 host 的 fs-sandbox/或 undefined）。
  const filesystem: CordisRow = {
    id: 'filesystem',
    name: 'cordis:group',
    group: true,
    isolate: { fs: true },
    children: [
      { id: 'fs-local', name: '@deepseek-ai/dsh-fs-local', config: { cwd: '!!js process.env.DSH_CWD ?? process.cwd()' } },
      { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
      // 2026-09-11 用户定调：**str_replace_editor 退场**。它与官方 `edit` 职责完全重叠
      // （都是 old/new 字面替换），却多一套规则（要求绝对路径、独立错误文案），
      // 全库实测它的失败率是三者最高的（29.8%）。TRAE 在 Agentic 阶段把编辑收敛成
      // Write/Delete/Update 三个工具、Update 只留一个 —— 工具越多，模型越容易放弃它们
      // 去用 bash（见 src/tool-policy.ts 的统计）。写工具面 = write + edit。
    ],
  }
  // 插在 standard 的 tool-fs/tool-fs-search 之后（filesystem 语义区）。
  const fsSearchIdx = rows.findIndex(r => r.id === 'tool-fs-search')
  rows.splice(fsSearchIdx + 1, 0, filesystem)

  // corum 追加 ④：MCP（profile.mcpServers 授权的服务）。
  //
  // **2026-09-27 改造**（用户模型：「框架统一管理，自始至终只有一个进程；可授权给多个 Agent
  // 使用，但独占状态，不支持并发使用」）：行由 `@deepseek-ai/dsh-mcp-client`（自带完整定义 ⇒
  // 每个 preset 各起一套进程、改配置要重挂）改为 **`@corum/corum-mcp-manager/proxy`（只带
  // serverName）**。进程与独占租约由宿主池 `corumMcpPool` 负责，于是：
  //   · 多 profile / 多 Agent 授权共用**同一个** server 进程（池按服务名 + 定义指纹持有）；
  //   · 改注册表里的 args/env 不必重写每个 preset（池自己按指纹换进程）；
  //   · 保存 profile 只改授权（挂/卸代理行），**不再重启 MCP 进程**；
  //   · 调用经独占租约（忙则排队，超时拒绝并告知持有者）。
  //
  // 这里**仍然解析注册表**：停用/不存在的服务不编行（与改造前一致），只是不再把定义写进行里
  // ——定义在运行时由池从注册表读取（唯一事实源仍在 `~/.corum/mcp-servers.json`）。
  for (const mcp of resolveMcpServers(profile.mcpServers)) {
    rows.push({
      id: `mcp-${mcp.name}`,
      name: '@corum/corum-mcp-manager/proxy',
      config: { serverName: mcp.name },
    })
  }

  // corum 追加 ⑤：基准模式的**工具面差异**（2026-09-12 用户定调「5 个模式不再直接选中、
  // 只作继承模板，系统内置 5 个继承它们的 Agent」）。在此之前 corum Agent 一律编译成
  // standard 全量行（compile.ts 头部 §8 的 2026-09-02 定调），`baseMode` 只影响人格——
  // 那样「极简助手」其实拿着标准模式的全部工具，继承就是假的。此处按官方四模式的
  // preset 逐行对账补上差异（对账源：shipped-presets/official/*/agent.cordis.yml）：
  //   ptc     → 官方 ptc 相对 standard 只多 tool-presentation（mode: ptc）；
  //   cordis  → 官方 cordis 相对 standard 只多 tool-cordis（运行时自省/插件实验）；
  //   minimal → 官方 minimal 用 persona + persistent-shell 组（pty/terminal-bash/
  //             persistent-bash）+ filesystem，即「bash + str_replace_editor」双
  //             工具面。**corum 已不挂持久组**（见「corum 覆盖 ⓪」），所以 corum
  //             的 minimal 落成 persona + tool-bash + filesystem + tool-fs =
  //             bash + 读写编辑，无 skills / 子 Agent / 目标 / 网页 / 计划 / 待办 / MCP。
  //             （若日后要逐字节对齐官方 minimal，需另行给 minimal 单独挂持久组。）
  //   standard/conductor → 全量面（conductor 的「主 Agent 裁执行工具」仍走运行时
  //             tools.restrict，不能在编译期裁行——见 §472-477 的实机教训）。
  if (profile.baseMode === 'ptc') {
    rows.push({
      id: 'tool-presentation',
      name: '@deepseek-ai/dsh-agent-tool-presentation',
      config: { mode: 'ptc' },
    })
  } else if (profile.baseMode === 'cordis') {
    rows.push({ id: 'tool-cordis', name: '@deepseek-ai/dsh-tool-cordis' })
  } else if (profile.baseMode === 'minimal') {
    const minimalRowIds = new Set(['persona', 'tool-bash', 'filesystem', 'tool-fs'])
    rows.splice(0, rows.length, ...rows.filter(row => minimalRowIds.has(row.id)))
  }

  return {
    cordisYml: renderRows(rows),
    presetYml: `name: ${profile.id}\ndescription: ${profile.prompt.split('\n')[0] ?? ''}\n`,
  }
}

/** 把中间表示的行渲染成 YAML 文本（对齐官方 agent.cordis.yml 风格）。 */
function renderRows(rows: readonly CordisRow[]): string {
  const lines: string[] = []
  for (const row of rows) {
    if (row.group) {
      lines.push(`- id: ${row.id}`)
      lines.push(`  name: ${renderScalar(row.name)}`)
      lines.push(`  group: true`)
      if (row.isolate !== undefined) {
        lines.push(`  isolate:`)
        for (const [key, value] of Object.entries(row.isolate)) {
          lines.push(`    ${key}: ${value}`)
        }
      }
      lines.push(`  config:`)
      for (const child of row.children ?? []) {
        lines.push(`    - id: ${child.id}`)
        lines.push(`      name: ${renderScalar(child.name)}`)
        if (child.disabled !== undefined) lines.push(`      disabled: ${child.disabled}`)
        if (child.config !== undefined) {
          lines.push(`      config:`)
          renderConfigLines(child.config, '        ', lines)
        }
      }
    } else {
      lines.push(`- id: ${row.id}`)
      lines.push(`  name: ${renderScalar(row.name)}`)
      if (row.disabled !== undefined) lines.push(`  disabled: ${row.disabled}`)
      if (row.config !== undefined) {
        lines.push(`  config:`)
        renderConfigLines(row.config, '    ', lines)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** 把一个标量渲染成 YAML 标量（字符串用引号，数字/布尔原样）。 */
function renderScalar(value: unknown): string {
  if (typeof value === 'string') {
    // `!!js ...` 是 YAML 标记表达式（见官方 minimal preset 的 `disabled:` 与
    // `fs-local` 的 `cwd:`），必须不带引号原样输出——JSON.stringify 会把它
    // 包成普通字符串，使 `!!js` 标记失效，terminal/fs 行就会按错误的语义装载。
    if (value.startsWith('!!js ')) return value
    return JSON.stringify(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return 'null'
  return JSON.stringify(value)
}

/** 把 config 的键值渲染成 YAML 行（嵌套对象递归缩进一层，标量走 renderScalar）。 */
function renderConfigLines(config: Record<string, unknown>, indent: string, lines: string[]): void {
  for (const [key, value] of Object.entries(config)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${indent}${key}:`)
      renderConfigLines(value as Record<string, unknown>, `${indent}  `, lines)
    } else {
      lines.push(`${indent}${key}: ${renderScalar(value)}`)
    }
  }
}

/**
 * 从全局注册表（CORUM_HOME/mcp-servers.json）按服务名解析 MCP 配置。
 * compilePreset 是纯函数，不能注入 Cordis 服务，直接读文件。
 */
function resolveMcpServers(names: readonly string[]): McpServerConfig[] {
  const registryPath = join(corumHome(), 'mcp-servers.json')
  if (!existsSync(registryPath)) return []
  let servers: McpServerConfig[]
  try {
    const data = JSON.parse(readFileSync(registryPath, 'utf8')) as { servers?: McpServerConfig[] }
    servers = data.servers ?? []
  } catch {
    return []
  }
  const map = new Map(servers.map(s => [s.name, s]))
  const result: McpServerConfig[] = []
  for (const name of names) {
    const server = map.get(name)
    // 已停用的服务不编进 preset。
    if (server !== undefined && server.disabled !== true) result.push(server)
  }
  return result
}
