/**
 * Shared in-process child composition: the delegation-depth budget, the
 * durable session metadata, the resolved child `AgentOptions`, the delegated
 * policy seed, and the scoped setup a child agent needs. Both the one-shot
 * provider driver and the continuation manager compose children this way, so
 * depth accounting, lineage stamping, and delegation policy have one home.
 *
 * @module @deepseek-ai/dsh-subagent/child-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
// Type-only: make `ctx.get('sandboxPolicy')` / `ctx.get('approval')` resolve
// to the policy services when composed — delegation consumes both
// opportunistically (the documented `ctx.get` pattern), never as a hard dep —
// and merge the `sandbox/mode` / `approval/policy` session-event payloads.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
// Type-only: make `ctx.get('agentPresets')` resolve to the preset roster when
// composed — a child inherits its parent's composition opportunistically (the
// documented `ctx.get` pattern), never as a hard dep. A rosterless deployment
// keeps its model-facing rows on the host plane, where the child already sees
// them through the tool registry's global layer.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { corumNarrowDenyFilter, corumVisibleToolNames, confinementGuard, type ConfinementScope } from '@corum/corum-orchestration'
// fork（corum）2026-09-26：子 Agent 提权（用户 9-14 需求）——判定纯函数在 escalation-policy.ts，
// 应答器在 escalation-answerer.ts。两者与 `approvalPolicy: 'ask'` 成对（见 capture 的头注）。
import { installEscalationAnswerer } from './escalation-answerer.ts'
import { hardCeilingFor } from './escalation-policy.ts'
import { CHILD_WORKER_ROLE, CHILD_WORK_STYLE, RESEARCHER_ROLE } from './child-roles.ts'
import { delegationDepthOf } from './depth.ts'
import { SubagentError } from './error.ts'

/** Thrown when starting a child would exceed the requested depth cap. */
export class SubagentDepthError extends Error {
  constructor(public readonly attemptedDepth: number, public readonly maxDepth: number) {
    super(`subagent depth ${attemptedDepth} exceeds maxDepth ${maxDepth}`)
    this.name = 'SubagentDepthError'
  }
}

/**
 * Resolve the child's delegation depth from its parent and enforce an optional
 * cap. The persisted parent header is the monotone floor, so a resumed parent
 * cannot delegate as if it were top-level.
 * @param parent - the delegating parent agent.
 * @param maxDepth - optional absolute cap the resolved depth must not exceed.
 * @returns the child's non-negative safe-integer depth.
 * @throws {SubagentDepthError} when the resolved depth exceeds `maxDepth`.
 * @throws {RangeError} when the resolved depth leaves the safe-integer range.
 */
export function resolveChildDepth(parent: Agent, maxDepth: number | undefined): number {
  const childDepth = delegationDepthOf(parent) + 1
  if (!Number.isSafeInteger(childDepth)) {
    throw new RangeError('subagent child depth exceeds the safe-integer range')
  }
  if (maxDepth !== undefined && childDepth > maxDepth) {
    throw new SubagentDepthError(childDepth, maxDepth)
  }
  return childDepth
}

/**
 * Resolve the parent values inherited by a child. The latest request header
 * owns provider, model, and reasoning effort after request-time selection;
 * creation options remain the fallback before the first request and retain
 * the configured output-token limit.
 * @param parent - delegating parent Agent.
 * @returns detached Agent options for child-option merging.
 */
export function parentAgentOptionsForDelegation(parent: Agent): AgentOptions {
  const requestConfig = parent.session.requestHeader()?.config
  if (requestConfig === undefined) return { ...parent.options }
  const {
    provider: _createdProvider,
    model: _createdModel,
    reasoningEffort: _createdReasoningEffort,
    ...createdOptions
  } = parent.options
  return {
    ...createdOptions,
    provider: requestConfig.provider,
    model: requestConfig.model,
    ...requestConfig.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: requestConfig.reasoningEffort },
  }
}

/**
 * Resolve the child's `AgentOptions`: the parent's provider/model,
 * reasoning-effort, and maxTokens values unless the request overrides them,
 * stamped with the child's own delegation depth. Changing the route without
 * naming an effort clears the parent's route-owned effort so the selected
 * model resolves its own default.
 * @param parent - the delegating parent whose route the child inherits.
 * @param requested - per-child overrides, if any.
 * @param childDepth - the resolved delegation depth to stamp.
 * @returns the resolved options for `ctx.agents.create()`.
 */
export function resolveChildAgentOptions(
  parent: Agent,
  requested: AgentOptions | undefined,
  childDepth: number,
): AgentOptions {
  const parentOptions = parentAgentOptionsForDelegation(parent)
  const parentProvider = parentOptions.provider
  const parentModel = parentOptions.model
  const parentReasoningEffort = parentOptions.reasoningEffort
  const parentMaxTokens = parentOptions.maxTokens
  const resolved: AgentOptions = {
    ...parentProvider !== undefined ? { provider: parentProvider } : {},
    ...parentModel !== undefined ? { model: parentModel } : {},
    ...parentReasoningEffort !== undefined ? { reasoningEffort: parentReasoningEffort } : {},
    ...parentMaxTokens !== undefined ? { maxTokens: parentMaxTokens } : {},
    ...requested,
    subagentDepth: childDepth,
  }
  const routeChanged = resolved.provider !== parentProvider || resolved.model !== parentModel
  if (routeChanged && requested?.reasoningEffort === undefined) delete resolved.reasoningEffort
  return resolved
}

/**
 * Build the child session's durable creation metadata: the parent's workspace,
 * its direct lineage, coarse product origin, the recursion budget that must
 * survive persistence, the seed boundary that separates inherited parent
 * history from child work, and the composition the child runs under.
 *
 * The preset is read from the parent's LIVE scope chain rather than from its
 * header, because a parent that switched preset while blank runs on the newer
 * composition and its header still names the older one. Recording it is what
 * makes a child's history reconstructable: without it a cold read of the child
 * resolves the deployment default and rebuilds turns under a tool set the
 * child never had.
 * @param parent - the delegating parent agent.
 * @param childDepth - the resolved delegation depth to persist.
 * @param isSeeded - whether this child inherits a parent-log prefix, including an explicitly empty one.
 * @param selectedPreset - independent preset selection, or omission to inherit the parent's.
 * @returns the `meta` for `ctx.agents.create()`.
 */
export function childSessionMeta(
  parent: Agent,
  childDepth: number,
  isSeeded: boolean,
  selectedPreset?: string,
): NonNullable<CreateAgentOptions['meta']> {
  const parentHeader = parent.session.header
  const agentPreset = selectedPreset ?? parent.ctx.get('agentPresets')?.composedPreset(parent.ctx)
  return {
    ...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {},
    ...agentPreset === undefined ? {} : { agentPreset },
    parentSession: parentHeader.id,
    isSeeded,
    // Navigation classification only; the descriptor remains the authority
    // for mode and continuation capability.
    origin: 'subagent',
    // Durable: the recursion budget must survive persistence and resume.
    delegationDepth: childDepth,
  }
}

/**
 * fork（corum）：子 Agent 的**种类**——决定它拿哪套角色人格契约（2026-09-20 用户定调）。
 *
 * 为什么需要显式信号（而不是从工具面反推）：用户要求「**所有**子 Agent 都不继承主 Agent
 * 人格」，且两类子 Agent 的性格**相反**——
 *   · `worker`     = 忠实执行者：照 brief 做、不重规划、不越界、达标即停、**不做构建**；
 *   · `researcher` = 全面调查员：主动多角度深挖、交叉验证、可继续派子 Agent 深入调查。
 * 把「哪种」当作机制事实显式传递，才不会出现「execution 面能写就猜是 worker」这类
 * 脆弱推断（同 `conductorModes` 内存表的教训，见 docs/LESSONS.md §4.29 附近）。
 */
export type ChildKind = 'worker' | 'researcher'

/** The scoped composition a child agent's creation window applies. */
export interface ChildComposition {
  /** Independently mounted preset; omission shares the parent's standing generation. */
  readonly agentPreset?: string | undefined
  /**
   * fork（corum）：子 Agent 种类 → 决定影子人格选哪套契约。
   *
   * `undefined` = 调用方未声明（精简装配/官方路径），人格**不被替换**，维持既有继承行为。
   */
  readonly kind?: ChildKind | undefined
  /**
   * fork（corum）：主 Agent 动态注入的**叠加层**人格（2026-09-20 用户定调「叠加，且不可
   * 覆盖机制层」）。
   */
  readonly personaHint?: string | undefined
  /** Per-child persona shadowing the deployment persona. */
  readonly persona?: string | undefined
  /** Per-child tool scoping. */
  readonly toolFilter?: ToolRestriction | undefined
  /**
   * fork（corum）2026-09-22：**隔离写边界**（纵深防御，用户拍板的修法 2）。
   */
  readonly confined?: boolean | undefined
}

/**
 * Model-facing delegation-scope statement for every in-process child. A
 * runtime-context contribution rather than a system-prompt section, so the
 * deployment's system prompt stays uniform across parents and children.
 */
export const SUBAGENT_DELEGATION_CONTEXT
  = 'You are a delegated subagent: your permission scope was fixed when you were started. If a command is '
    + 'blocked by the sandbox, you MAY retry that exact command once with `sandbox_permissions` plus a '
    + 'one-sentence `justification`. For anything OUTSIDE the current repository the mechanism grants it when '
    + 'it stays within what the delegating agent itself holds, and otherwise asks the user. Targeting the '
    + 'CURRENT repository is the exception: that retry is refused WITHOUT any prompt (its other branches, '
    + 'worktrees, refs and the shared `.git` are readable but never writable by a delegated child), so there '
    + 'is no card to wait for. Hard limits: a read-only scope can never widen; an isolated scope may still ask '
    + 'for a wider tier, but its write boundary is by PATH and does not move. Either way a refusal is final: '
    + 'state the limitation in your reply so the delegating agent can handle it instead of working around it.'

/**
 * Compose one child inside its creation window: join its parent's preset,
 * register the fixed delegation-scope statement, then apply the child's own
 * shadowing persona section and tool restriction, all owned by the child's
 * scope and therefore invisible to its parent and siblings. Creation and cold
 * resume both pass through here.
 *
 * The join comes first and the child's own registrations second, which is the
 * order the layering already implies — the nearest scope wins a name, and a
 * per-child restriction intersects with everything its chain admits — but
 * stating it here keeps the two steps from being read as independent.
 *
 * The join and the per-child registrations live in ONE call because a child
 * composed without the join is exactly the defect this function exists to
 * prevent: with every model-facing row on the agent plane, a child that joins
 * no preset sees an empty tool registry and none of its parent's prompt
 * sections. Taking the parent as a parameter is what makes that omission
 * unrepresentable at the call sites.
 * @param childCtx - the child agent's scoped creation context.
 * @param parent - the delegating parent whose composition the child joins.
 * @param composition - the per-child persona and tool filter to install.
 */
export function applyChildComposition(
  childCtx: Context,
  childAgent: Agent,
  parent: Agent,
  composition: ChildComposition,
): void | Promise<void> {
  // fork（corum）：独立 preset 挂载走官方通路（agentPreset 字段）。
  if (composition.agentPreset !== undefined) {
    const presets = childCtx.get('agentPresets')
    if (presets === undefined) {
      throw new SubagentError('selecting a child agent preset requires the agent-presets service', 'PRESET_UNAVAILABLE')
    }
    return presets.mount(childCtx, composition.agentPreset).then(() => {
      applyChildOverrides(childCtx, childAgent, parent, composition)
    })
  }
  childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)
  applyChildOverrides(childCtx, childAgent, parent, composition)
}

/** Apply corum-specific overrides: delegation context, persona, toolFilter, confinement, escalation. */
function applyChildOverrides(
  childCtx: Context,
  childAgent: Agent,
  parent: Agent,
  composition: ChildComposition,
): void {
  childCtx.systemPrompt.context({
    name: 'subagent:delegation',
    order: childCtx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    text: SUBAGENT_DELEGATION_CONTEXT,
  })
  /**
   * 子 Agent 人格契约（2026-09-11 首版「指挥模式不继承父人格」；**2026-09-20 扩为无条件**）。
   *
   * ## 为什么无条件（用户实测报障）
   *
   * 原实现以「父是不是指挥模式」为门（`conductorParent`），于是：
   *   ① 非指挥模式的子 Agent **全量继承父的角色人格** —— 一个"产品专家"派出的 worker
   *      会自称产品专家；指挥模式派出的则会自称编排者；
   *   ② 该判定读 `conductorModes`（**纯内存表**）⇒ 宿主重启后为空 ⇒ 影子段整段失效，
   *      子 Agent 带着继承来的编排者人格去干活（实测 8/8 worker 零执行者契约）。
   *      更糟的是那份人格写着「你没有写工具」，而它手上正握着 write/edit/bash ——
   *      实测有 worker 在自己的推理里被这个矛盾卡住（"Hmm, but wait. My system prompt
   *      says 'You have no write tools'... Yet the tool list includes write/edit/bash."）。
   *
   * 用户定调（2026-09-20）：**所有子 Agent 都不继承主 Agent 人格**，按种类拿固定的角色
   * 契约——worker 是**忠实执行者**，researcher 是**全面调查员**。这条规则无条件成立，
   * 因此不再依赖任何运行时可失状态（①类判断消失，②类 bug 随之消失）。
   *
   * ## 三段拼装（顺序固定，注入层不可覆盖机制层）
   *
   *   `[kind 角色契约]` + `[父的工作风格人格（若有）]` + `[主 Agent 的 personaHint（若有）]`
   *
   * - 角色契约由 `kind` 唯一决定，是机制单一事实源；
   * - 工作风格（设置里那个「专业干练」）**保留继承**——用户 2026-09-11 定调：子 Agent 只继承
   *   「怎么干活」，不继承「你是谁」；
   * - `personaHint` 是主 Agent 注入的**叠加层**，只承载本次任务的领域/约定，**无法**删除或
   *   覆盖前两段（用户 2026-09-20 定调）；长度在上游截断。
   *
   * `composition.persona` 仍是最高优先级的**整体替换**通路（机制内部构造者使用，如集成者
   * 人格）——它不是主 Agent 可注入的那个字段。
   */
  const conductor = childCtx.get('corumConductor') as ConductorFace | undefined
  const conductorParent = conductor !== undefined && conductor.isConductor(String(parent.session.id))
  // fork（corum）2026-09-29：修复人格与工具面矛盾（用户已确认的 bug）。
  // 旧实现：`childPersonaOf` 有一个 conductor 兜底（`kind` 未声明但父是指挥模式 ⇒
  // 给 `CHILD_WORKER_ROLE`），而下面的 deny 判定只看 `composition.kind`、不看这个兜底
  // ⇒ 同一子 Agent 可能人格=执行者契约、却没 deny 委派工具（人格与工具面矛盾）。
  // 修法（方案「让 deny 看同一个兜底」）：在**唯一一处**解析 `resolvedKind`——
  // `kind` 未声明但父是指挥模式时默认 `worker`——人格拼装与 deny 判定都读这个同一个值，
  // 二者永远一致。`fork`/`isolated`/`spawn` 三个 provider（经 driver）恒透传 `request.kind`
  // （仅 `undefined` 时省略），所以兜底只在工具层未传 `kind` 的指挥模式委派时生效。
  const resolvedKind: ChildKind | undefined = composition.kind ?? (conductorParent ? 'worker' : undefined)
  const persona = composition.persona ?? childPersonaOf(childCtx, parent, resolvedKind, composition.personaHint)
  if (persona !== undefined) {
    childCtx.systemPrompt.section({
      name: 'deployment:persona-prefix',
      order: childCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: persona,
    })
  }
  /**
   * 委派工具的 deny（**非对称**，2026-09-20 用户定调）：
   *   · `worker`     —— **保持不能再委派**：执行者只干活，分层由主 Agent 负责；
   *   · `researcher` —— **允许继续派子 Agent**，用于深入调查（多角度/追根因）。
   *
   * 指挥模式下**无差别** deny（2026-09-11 定调「指挥模式下子 Agent 只干活不分层」）——
   * 该语义保持：指挥模式下连 researcher 也不分层。
   *
   * ## ⚠️ researcher 只能派**只读**子 Agent（2026-09-20 实机验出的漏洞）
   *
   * 首版实现只做了「worker 禁止委派、researcher 放开」，**没限制 researcher 用哪个委派工具**。
   * 实测后果（会话 `f1dab4d6` → `a192efcf`，depth 1 → 2）：只读调查员选了**写能力**的
   * `subagent` 工具派孙 Agent ⇒ 孙 Agent 拿到 **worker 契约**（自我认知是"我能写"），
   * 而它的沙箱仍是 `read-only`（继承自祖父）⇒ **人格与工具面再次矛盾**，实测该孙 Agent
   * 第一步就撞上拒绝。这正是本轮要根除的那类错配。
   *
   * 修法：researcher 只保留 `subagent_research`（及其它**只读**研究实例），把写能力的
   * `subagent` / `orchestrate` deny 掉——「只读的调查员只能派出只读的调查员」由工具面保证，
   * 不依赖模型自觉。只读性因此**沿委派链闭合**：任何 read-only 源头以下的整棵子树都只读。
   */
  const delegationsDenied = conductorParent || resolvedKind === 'worker'
  const researchDeny = resolvedKind === 'researcher'
    ? writeCapableDelegationToolNames(childCtx)
    : []
  const raw = (delegationsDenied || researchDeny.length > 0)
    ? mergeDelegationDeny(composition.toolFilter, [
        ...(delegationsDenied ? delegationToolNames(childCtx) : []),
        ...researchDeny,
      ])
    : composition.toolFilter
  const toolFilter = raw === undefined ? undefined : narrowChildToolFilter(childCtx, raw)
  if (toolFilter !== undefined) childCtx.tools.restrict(toolFilter)

  /**
   * fork（corum）2026-09-22：**隔离写边界的纵深防御门禁**（用户拍板的修法 2）。
   *
   * 为什么还要一层（沙箱已经是强边界）：隔离的第 2 层（fs 写沙箱）是**按档位**开关的，
   * 而档位是用户可改的状态——2026-09-22 实测「用户在指挥模式切完全权限后，隔离的物理
   * 基础整档消失」（worker 成功删掉 19 个 worktree 并对主树执行 merge）。修法 1 已把
   * 隔离期子会话的沙箱钉成 `workspace-write`，本门禁是**与沙箱正交**的第二道：
   * 即便沙箱被旁路（未装配 / 平台差异 / 未来有人改动档位语义），越界写仍被拒绝。
   *
   * 单调性：guard 是「deny or abstain, never allow」，后注册者无法复活被拒的调用
   * （与主 Agent 只读门禁同一机制，见 `@corum/corum-agent` 的 `permission-policy.ts`）。
   * 注册在 `childCtx`（子 Agent 自己的 scope）上 ⇒ **只作用于这个子会话**，不泄漏给它的
   * 父或兄弟；`track`/集成者/只读研究都不置 `confined`，因此不受影响。
   */
  /**
   * fork（corum）2026-09-27：**隔离作用域算一次，两处共用**——写边界门禁（`tools.guard`）
   * 与提权应答器（主仓目标的提权直接 refuse）必须是同一份边界，否则两处各算一遍迟早漂移。
   *
   * fork（corum）2026-10-27：边界取子会话的**有效工作目录**（working-directory 服务的
   * projection state），而不是 `header.cwd`。`header.cwd` 只在创建时由 `childSessionMeta`
   * 从父会话继承，`workingDirectory.set` 更新的是 projection state，不是 header——之前读
   * `header.cwd` 导致隔离子会话的 worktreeRoot 退化到父会话 cwd（= 主树），confinement
   * 判定形同虚设。冷恢复时 projection 从持久化的 `working-directory/change` 事件重建
   * 同一份目录，边界仍然正确。
   * 主树根 = 委派方的 cwd（隔离要保护的对象）。**必须显式传**：工作区可能就建在临时区
   * 之内（本仓测试与部分用户环境如此），只靠「worktree 之外都拦」会被临时区允许集放行，
   * 门禁等于没装。非 `confined`（集成者 / 主树子 Agent / 只读研究）⇒ `undefined`。
   */
  const confinementScope: ConfinementScope | undefined = composition.confined !== true
    ? undefined
    : ((): ConfinementScope | undefined => {
        const workingDirectory = childCtx.get('workingDirectory')
        const root = workingDirectory !== undefined
          ? workingDirectory.get(childAgent.session)
          : childAgent.session.header.cwd
        if (root === undefined || root === '') return undefined
        const parentWorkingDirectory = childCtx.get('workingDirectory')
        const parentTree = parentWorkingDirectory !== undefined
          ? parentWorkingDirectory.get(parent.session)
          : parent.session.header.cwd
        return {
          worktreeRoot: root,
          ...parentTree !== undefined && parentTree !== '' ? { parentTreeRoot: parentTree } : {},
        }
      })()

  if (confinementScope !== undefined) {
    // 单调性：guard 是「deny or abstain, never allow」，后注册者无法复活被拒的调用
    // （与主 Agent 只读门禁同一机制，见 `@corum/corum-agent` 的 `permission-policy.ts`）。
    childCtx.tools.guard(confinementGuard(confinementScope))
  }

  /**
   * fork（corum）2026-09-26：**子 Agent 提权应答器**（用户 9-14 需求，9-26 拍板口径）。
   *
   * 与 `captureDelegatedPolicyOverrides` 的 `approvalPolicy: 'ask'` **成对**（见那里的头注）：
   * 那条把子会话的 ask 放进 waterfall，本条**抢在转发器之前**认领并判定
   * （`X ≤ P` 机制自批 / 越硬天花板直接拒 / 否则以父 Agent 为载体上呈用户）。
   *
   * 硬天花板由**本组合已有的两个事实**推出，不新增透传字段：
   * `researcher`（只读研究）⇒ `read-only`；`confined`（隔离）⇒ `workspace-write`；否则不设界。
   * ⚠️ 2026-09-27 更正：隔离**不再**构成档位天花板（2026-09-26 裁定，见 `escalation-policy.ts:51`）；
   * 只读研究（`pinReadOnly`）才是唯一保留的硬天花板。隔离保留的是**按路径**的写边界（confinement）。
   * 这与 `captureDelegatedPolicyOverrides` 里 `pinReadOnly` 胜过 `confineToWorktree` 同序
   * （只读是更强的保证）。新增受限子 Agent 种类时改 `hardCeilingFor` 一处即可。
   *
   * 未装成（该部署没有 `approval` 服务）⇒ 不改变任何既有行为（那条策略同时也是 `undefined`）。
   */
  installEscalationAnswerer(childCtx, childAgent, {
    parent,
    hardCeiling: hardCeilingFor({
      // 2026-09-26 用户裁定：隔离**不是**档位天花板（两个轴：guard 守写边界、档位是权限面），
      // 故这里只看只读研究。理由见 hardCeilingFor 的头注。
      // fork（corum）2026-09-29：与人格/deny 共用 resolvedKind（含 conductor 兜底）。
      ...resolvedKind === 'researcher' ? { pinReadOnly: true } : {},
    }),
    // 2026-09-27 用户裁定：**主仓目标不可提权**。只给隔离子 Agent —— 主 Agent 与派到 main
    // 上工作的集成者保留完整的 bash / 合并能力（T4 只约束隔离子 Agent）。给了它之后，
    // 「沙箱层可提权」不再能穿透「不许碰主仓其它分支」这条线。
    ...confinementScope !== undefined ? { confinement: confinementScope } : {},
    logger: parent.ctx.logger,
  })
}

/**
 * 组装一个子 Agent 的角色人格（三段拼装，见 {@link applyChildComposition} 的注释）。
 *
 * 返回 `undefined` = 不替换人格（`kind` 未声明且父非指挥模式 ⇒ 维持既有继承行为）。
 *
 * fork（corum）2026-09-29：conductor 兜底**上移到** `applyChildComposition`（在那里解析
 * `resolvedKind`，人格与 deny 共用同一个值）。本函数只看传入的 `kind`，不再自行查 conductor
 * 服务——这消除了「人格看了兜底、deny 没看」的不一致（用户已确认的 bug）。
 * @param childCtx - 已 join 父 preset 的子 scope。
 * @param parent - 委派方（保留形参以便将来按 ctx/parent 裁剪）。
 * @param kind - 已解析的子 Agent 种类（含 conductor 兜底后的值；`undefined` = 不替换人格）。
 * @param personaHint - 主 Agent 注入的叠加层人格（可空）。
 * @returns 替换用的人格文本，或 `undefined`。
 */
export function childPersonaOf(
  childCtx: Context,
  parent: Agent,
  kind: ChildKind | undefined,
  personaHint: string | undefined,
): string | undefined {
  const parts: string[] = []
  if (kind === 'researcher') parts.push(RESEARCHER_ROLE)
  else if (kind === 'worker') parts.push(CHILD_WORKER_ROLE)
  else {
    return undefined
  }
  /**
   * 工作风格（「怎么干活」）——**固定为「高效务实」，不再继承父的设置**（用户 2026-09-20
   * 定调「工作风格都固定为 高效务实」）。
   *
   * 旧行为是继承父 profile 的 `personaPreset`，实测会把 `steady-coach`（「经验丰富的团队
   * 导师……来自下属的不成熟方案先肯定再指出问题」）传给一个没有下属、被禁止重新设计的执行者
   * ——风格与角色相冲。用户定调后子 Agent 一律用 `CHILD_WORK_STYLE`；父在设置里选什么风格
   * 都不再影响子 Agent（主 Agent 自身仍按设置走）。
   */
  parts.push(CHILD_WORK_STYLE)
  if (personaHint !== undefined && personaHint.trim() !== '') {
    parts.push(personaHint.trim())
  }
  // childCtx / parent 目前未用于取片段（保留形参以便将来按 ctx 裁剪），显式消费避免 lint 报未用。
  void childCtx
  void parent
  return parts.join('\n\n')
}

/**
 * `corumConductor` 服务的**本地能力接口**（红线 3：跨 bundle 用能力接口收窄，不耦合实现包）。
 * 服务由 `@corum/corum-agent` provide；本包按可选服务消费（缺席 = 无指挥模式语义）。
 *
 * 2026-09-20：**只保留 `isConductor`**。原先还有一个 `workStyleFor`（向父索取工作风格人格），
 * 自用户定调「工作风格都固定为 高效务实」后子 Agent 一律用本包的 {@link CHILD_WORK_STYLE}，
 * 不再向父方索取风格，故该成员连同 `corum-agent` 侧的实现一并删除（避免留死接口）。
 */
interface ConductorFace {
  isConductor: (sessionId: string) => boolean
}

/**
 * 子 scope 里**实际可见**的委派工具名（`subagent*` 全族 + `orchestrate`）。
 *
 * 按可见面取而不是写死清单：`tools.restrict({deny})` 对未注册的名字 fail-loud，
 * 而委派工具在不同装配下可能缺席（精简 preset / 未来改名）。
 * @param childCtx - 已 join 父 preset 的子 scope。
 * @returns 需要 deny 的工具名（可能为空）。
 */
function delegationToolNames(childCtx: Context): readonly string[] {
  const visible = corumVisibleToolNames(childCtx)
  return [...visible].filter(name => name === 'orchestrate' || name.startsWith('subagent'))
}

/**
 * fork（corum）2026-09-20：子 scope 里**写能力**的委派工具名（researcher 必须被 deny 掉的那些）。
 *
 * 判据 = 委派工具全族 **减去**只读研究实例。为什么按「减去」而不是写死 `['subagent','orchestrate']`：
 *   · `subagent_research*` 的命名可能演进（研究实例现在叫 `subagent_research`）；
 *   · 用户自定义 preset 可能起别的只读实例名。
 * 用「含 research 且不含 fork」识别只读实例过于脆弱，故采用**显式名单 + 可见面收敛**：
 * 只要名字以 `subagent_research` 开头就视为只读（当前唯一的只读实例族），其余委派工具一律
 * 视为写能力。名单最终仍要过 `narrowChildToolFilter` 收敛到真实可见面（未注册名会 fail-loud）。
 *
 * @param childCtx - 已 join 父 preset 的子 scope。
 * @returns 需要 deny 的写能力委派工具名（可能为空）。
 */
function writeCapableDelegationToolNames(childCtx: Context): readonly string[] {
  return delegationToolNames(childCtx).filter(name => !name.startsWith('subagent_research'))
}

/**
 * 把子 Agent 的 toolFilter 收敛到**该子 scope 真实可见**的工具名上。
 *
 * 为什么必须做（2026-09-12 实机事故）：`preset` 里给的 deny 名单是**编译期写死**的，
 * 它会随装配漂移，而 `tools.restrict()` 对未知名 **fail-loud**（docs/LESSONS.md §6.18）。
 * 实测两次踩坑：
 *  1. `str_replace_editor` 从 corum preset 退场后，研究实例的 deny 仍写着它 →
 *     **每一次 `subagent_research` 都抛 `names unknown global tools`**，指挥者只能退回
 *     用 `subagent` 重发同一件事（用户看到「两个重复的子 Agent」），还白占一个隔离 worktree；
 *  2. `mcpDenyNames` 取的是 **MCP 服务名**（`pencil-mcp`），而实际工具名是
 *     `mcp__pencil-mcp__*` —— 服务名同样不是全局工具名，一配上 MCP 就必炸。
 *
 * 处理口径：
 *  - 名字直接可见 → 原样保留；
 *  - 名字是**某个 MCP 服务名**（隐藏前缀形态）→ 展开成该服务**实际可见**的工具名
 *    （保住「pencil 有写能力，只读研究实例也必须 deny 它」的原始意图）；
 *  - 其余不可见的名字 → 丢弃（拒绝一个不存在的工具没有意义，只会炸掉整次派遣）。
 * @param childCtx - 已 join 父 preset 的子 scope。
 * @param filter - 调用方给的过滤器（编译期 deny / 集成者过滤 / 禁委派）。
 * @returns 只含可见工具名的过滤器；deny 与 allow 收敛后皆空时 undefined。
 */
export function narrowChildToolFilter(
  childCtx: Context,
  filter: ToolRestriction,
): ToolRestriction | undefined {
  const visible = corumVisibleToolNames(childCtx)
  const deny = new Set<string>()
  for (const name of filter.deny ?? []) {
    if (visible.has(name)) {
      deny.add(name)
      continue
    }
    // MCP 服务名 → 该服务下实际可见的工具名（否则「只读实例不得用 pencil」形同虚设）。
    for (const candidate of visible) {
      if (candidate.startsWith(`mcp__${name}__`)) deny.add(candidate)
    }
  }
  const allow = filter.allow?.filter(name => visible.has(name))
  if (deny.size === 0 && (allow === undefined || allow.length === 0)) return undefined
  return {
    ...(allow === undefined || allow.length === 0 ? {} : { allow }),
    ...(deny.size === 0 ? {} : { deny: [...deny] }),
  }
}

/**
 * 把「禁委派」并入调用方给的 toolFilter（调用方的 filter 优先语义不变，deny 取并集）。
 * @param filter - 调用方（provider/集成者）给的过滤器。
 * @param deny - 要额外禁止的工具名。
 * @returns 合并后的过滤器；两者皆空时 undefined。
 */
function mergeDelegationDeny(
  filter: ToolRestriction | undefined,
  deny: readonly string[],
): ToolRestriction | undefined {
  if (deny.length === 0) return filter
  // 注意：`ToolRestriction` 的字段是 readonly，而 `corumNarrowDenyFilter` 要可变数组
  // （exactOptionalPropertyTypes 下也不接受显式 undefined）——这里显式重建一个可变对象。
  const combined: string[] = [...(filter?.deny ?? []), ...deny]
  const base: { allow?: string[]; deny?: string[] } = { deny: combined }
  if (filter?.allow !== undefined) base.allow = [...filter.allow]
  const merged = corumNarrowDenyFilter(base, new Set(combined))
  return merged ?? filter ?? { deny: combined }
}

/** Policy seeded onto a child session's log at the delegation boundary. */
export interface DelegatedPolicyOverrides {
  /**
   * The parent session's Auto identity (`auto` / `danger-full-access`), or `undefined`
   * when the permission-preset service is absent or the parent's current preset is neither.
   *
   * Restored 2026-10-28: the official `captureDelegatedPolicyOverrides` captures this
   * preset and `appendDelegatedPolicyOverrides` appends it to the child log as
   * `permission/preset` so the child's effective identity is reconstructable from
   * its own log. The corum fork had dropped both; the official `activation-policy`
   * spec exposed the regression.
   */
  readonly permissionPreset: 'auto' | 'danger-full-access' | undefined
  /** The parent session's explicit sandbox-mode override, or `undefined` without one. */
  readonly sandboxMode: SandboxMode | undefined
  /**
   * The child's approval policy, or `undefined` when the approval capability is not composed.
   *
   * 2026-09-26（fork corum）：由恒为 `'never'` 放宽为 `'ask'`，以放行**子 Agent 提权通路**。
   * `'never'` 的官方语义是「在到达任何应答者之前就确定性 rejected」⇒ 子 Agent 撞到沙箱墙时
   * 既拿不到权限也无人知晓（实测 `bca632cd-…`：4 次拒绝 / 0 次尝试 / 0 条审批事件）。
   *
   * ⚠️ 取值恒为 `'ask' | undefined`（此处刻意收窄成两个字面量，而不是宽泛的
   * `ApprovalPolicy`）：`'ask'` 只有在 `installEscalationAnswerer` 确实装上时才安全，
   * 而后者同样以「`approval` 服务是否存在」为条件 —— 两个字面量让这条**成对不变式**
   * 在类型层面就看得见，也防止有人顺手写别的策略。
   */
  readonly approvalPolicy: 'ask' | undefined
}

/**
 * fork（corum）：沙箱档位的序（`read-only` < `workspace-write` < `danger-full-access`）。
 *
 * 用于「隔离只收窄、绝不放宽」的钳制（见 {@link captureDelegatedPolicyOverrides}）。
 */
const SANDBOX_MODE_ORDER: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/** 取两个档位里更窄的那个（索引小 = 更窄）。 */
function narrowerMode(a: SandboxMode, b: SandboxMode): SandboxMode {
  return SANDBOX_MODE_ORDER.indexOf(a) <= SANDBOX_MODE_ORDER.indexOf(b) ? a : b
}

/**
 * Capture the policy to seed into one delegation. Call synchronously before
 * the child start's first await: a later parent switch belongs to the
 * parent's future, not to this child. Only the parent session's explicit
 * sandbox override is captured — never deployment defaults or one-shot
 * grants.
 *
 * ## fork（corum）2026-09-26：审批策略由 `'never'` 改为 `'ask'`（子 Agent 提权通路）
 *
 * 此前这里恒钉 `'never'`，官方语义是「在到达任何应答者**之前**就确定性 rejected」⇒ 子 Agent
 * 撞到沙箱墙时**既拿不到权限、也无人知晓**（实测会话 `bca632cd-…`：4 次沙箱拒绝、
 * **0 次提权尝试**、**0 条审批事件**，子 Agent 自述「无法从内部申请提权」）。
 *
 * 改为 `'ask'` 后，子会话的 ask 会进入审批 waterfall，由本包新装的
 * {@link installEscalationAnswerer}（`escalation-answerer.ts`）**抢在转发器之前**认领并判定：
 * - 提权请求按 `X ≤ P` 机制自批 / 越硬天花板直接拒 / 否则**以父 Agent 为载体**上呈用户；
 * - **非提权**的 ask 一律回 `rejected` —— 原样保住 `'never'` 的既有语义，不顺手开别的口子。
 *
 * ⚠️ **成对不变式**：本策略只在 `applyChildComposition` 确实装上应答器时才安全。两者都以
 * 「`approval` 服务是否存在」为条件，故取值一致（`installEscalationAnswerer` 返回 `false`
 * 的部署同时也是这里返回 `undefined` 的部署）。改这里时必须同时看那里。
 *
 * ## fork（corum）2026-09-22：`confineToWorktree` —— 隔离的**正交轴**（实测漏洞修复）
 *
 * 隔离的第 2 层（fs 写沙箱）此前**整体继承父档位**：用户在指挥模式切「完全权限」
 * （`danger-full-access`）后，子会话也拿到 `danger-full-access`，而该档位在
 * `fs-sandbox` / `bash-sandbox` / `terminal-bash` 三处都**直通不 confine** ⇒ 隔离的
 * 物理基础当场消失。实测（会话 `corum-task-ef3f751e`）：同一 brief 结构，
 * `workspace-write` 下 worker 写主树 EPERM（硬隔离生效），`danger-full-access` 下
 * worker 成功删掉 19 个 worktree 并对主树 `git -C <主树> merge --no-ff`。
 *
 * 修法与 research 的 {@link pinReadOnly} 同一手法：**把约束钉在不可被用户档位覆盖的
 * 轴上**——隔离期的子会话沙箱**至多** `workspace-write`，边界 = 它自己的
 * `header.cwd`（= worktree）。
 *
 * ⚠️ **只收窄，绝不放宽**（写成取更窄者，而不是无条件写 `workspace-write`）：
 * 父档位是 `read-only` 时子会话必须**维持只读**——隔离要求的是「写不出 worktree」，
 * 而只读是比它更强的保证；父档位 `danger-full-access` 时收到 `workspace-write`。
 * 首版无条件钉 `workspace-write`，会把只读父会话的子 Agent **放宽**成可写，
 * 被本文件的三档矩阵单测当场抓到。
 *
 * @param parent - the delegating parent agent.
 * @param options.pinReadOnly - pin the child to `read-only` (read-only research child).
 * @param options.confineToWorktree - cap the child at `workspace-write` (isolated child);
 *   ignored when `pinReadOnly` is set (read-only is strictly narrower and wins).
 * @returns the sandbox override (or `undefined` without one) and the approval pin.
 */
export function captureDelegatedPolicyOverrides(
  parent: Agent,
  options: { readonly pinReadOnly?: boolean; readonly confineToWorktree?: boolean } = {},
): DelegatedPolicyOverrides {
  const preset = parent.ctx.get('permissionPresets')?.current(parent.session)
  const inherited = parent.ctx.get('sandboxPolicy')?.overrideOf(parent.session)
  const sandboxMode: SandboxMode | undefined = options.pinReadOnly === true
    ? 'read-only'
    : options.confineToWorktree === true
      // 隔离只收窄：父档位缺省（未显式切换）时按 workspace-write 处理（比部署默认更严，
      // 且隔离本就要求「能写自己的 worktree、写不出别的」这一档）。
      ? narrowerMode(inherited ?? 'workspace-write', 'workspace-write')
      : inherited
  return {
    permissionPreset: preset === 'auto' || preset === 'danger-full-access' ? preset : undefined,
    sandboxMode,
    // fork（corum）2026-09-26：`'ask'`（而非 `'never'`）以放行提权通路——见本函数头注的
    // 「成对不变式」：只有 `installEscalationAnswerer` 装上时才安全，两者同条件。
    approvalPolicy: parent.ctx.get('approval') === undefined ? undefined : 'ask',
  }
}

/**
 * Append the captured delegation policy onto the child's own log as
 * `source: 'delegation'` events inside the unpublished creation window, so the
 * child's effective policy is reconstructable from its log alone. Appends land
 * after any fork seed, so fresh policy wins stale seed state; later child
 * switches still win over these events.
 * @param childSession - the unpublished child's session.
 * @param overrides - the policy captured at delegation.
 */
export function appendDelegatedPolicyOverrides(
  childSession: Session,
  overrides: DelegatedPolicyOverrides,
): void {
  if (overrides.sandboxMode !== undefined) {
    childSession.append('sandbox/mode', { mode: overrides.sandboxMode, source: 'delegation' })
  }
  if (overrides.approvalPolicy !== undefined) {
    childSession.append('approval/policy', { policy: overrides.approvalPolicy, source: 'delegation' })
  }
  if (overrides.permissionPreset !== undefined) {
    childSession.append('permission/preset', { preset: overrides.permissionPreset })
  }
}

/** Identity and lineage inputs shared by every in-process child creation. */
export interface ChildCreateInputs {
  /** The child's reserved session id. */
  readonly sessionId: SessionId
  /** The delegating parent agent. */
  readonly parent: Agent
  /** The resolved delegation depth. */
  readonly childDepth: number
  /** How many leading seed events came from the parent's log. */
  readonly lineageSeedLength: number
}
