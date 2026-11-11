/**
 * fork（corum）2026-09-18：**问用户 + 按答案改变机制行为**的执行核（策略见 `model-ask.ts` 头注释）。
 *
 * 本文件只做「执行」：把 {@link CorumModelFailureFacts} 变成一个
 * `corum/model-ask/request` waterfall 调用，把回传的档位解析成
 * {@link CorumModelAskDecision}，再按决定去
 *   ① 改会话级临时覆盖、② 写预设（永久档）、③ 停用委派、④ 通知。
 * 判定（纯函数）与文案在 `model-ask.ts`，状态在 `corumOrchestration` 服务——三处分离，
 * 各自可单测。
 *
 * ## 通路
 *
 * 事件走 host 侧的**独立通路** `corum/model-ask/request`（`corum-api-remotes` 的转发
 * 白名单里是 `mode: 'waterfall'`），由 `@corum/corum-ui-model-ask` 这个 client 插件应答。
 * 与 `userQuestions`（LLM 主动提问）**完全隔离**：两条 waterfall 各自监听、互不截获。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  corumModelAskOptions,
  corumModelAskShortCause,
  corumResolveModelAskDecision,
  type CorumModelAskOption,
  type CorumModelAskDecision,
  type CorumModelFailureFacts,
} from './model-ask.ts'

/** 一次路由（provider/model/可选 reasoningEffort）。 */
export interface CorumRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * 会话级状态面（由 `corumOrchestration` 服务提供；窄接口而非 import 实现包，红线 3）。
 *
 * fork（corum）2026-09-19：签名加 `role`（可选，缺省 'worker'）——`modelOverrides`
 * 已升级为「sessionId + 角色」双键（corum preset 双实例各有独立锁面）。
 * {@link applyCorumModelDecision} 的 temporary/permanent 档把 `facts.role` 透传进去，
 * 否则 research 角色的临时决定会错误落到 worker 键上（研究实例读不到，改锁面也改错对象）。
 */
export interface CorumDelegationPolicyState {
  /** 写该角色的会话级覆盖；`'follow-main'` = 显式跟随主 Agent（跳过全局兜底档）。 */
  setModelOverride: (sessionId: string, route: CorumRoute | typeof FOLLOW_MAIN, role?: 'worker' | 'research') => void
  /** 取该角色的会话级覆盖（undefined = 未覆盖；`'follow-main'` = 显式跟随主 Agent）。 */
  modelOverrideOf: (sessionId: string, role?: 'worker' | 'research') => CorumRoute | typeof FOLLOW_MAIN | undefined
  clearModelOverride: (sessionId: string) => void
}

/** 可用的模型路由清单（供「永久改为指定模型」内嵌选择）。 */
export interface CorumModelCatalog {
  listRoutes: () => Promise<readonly {
    provider: string
    label: string
    models: readonly { model: string; label: string }[]
  }[]>
}

/**
 * 一条 client 回传的路由是否真的存在于可用模型清单里（host 侧对它的**唯一**校验点）。
 *
 * 为什么必须校验：面板里的候选项是 host 下发的，但回传的 provider/model 是一段裸字符串，
 * 中间隔着一次序列化与任意多个 client 版本。一条不存在的路由拿去重跑 = 用户再吃一次
 * 「模型不可用」，且看不出这次跑的是什么。故只认清单里逐字命中的 provider/model。
 *
 * ⚠️ 只校验 provider/model，不校验 `reasoningEffort`：清单只列模型，不列 effort 取值域；
 * 伪造一个 effort 的后果是请求被网关拒绝（下一次失败会照常再问一遍），不像错路由那样
 * 静默跑到别处去。这一条刻意保持窄。
 *
 * @param catalog - 本次询问下发给 client 的同一份清单（列举失败时为空数组）。
 * @param route - client 指定（或用户选中）的路由。
 * @returns 清单里逐字命中 provider 且有该 model 时 `true`；清单为空 ⇒ 无法确认 ⇒ `false`。
 */
export function corumModelRouteIsAvailable(
  catalog: readonly { provider: string; models: readonly { model: string }[] }[],
  route: { provider: string; model: string },
): boolean {
  return catalog.some(provider =>
    provider.provider === route.provider && provider.models.some(model => model.model === route.model))
}

/**
 * `corum/model-ask/request` 的 host 侧调用面。
 *
 * 为什么用 `ctx.waterfall` 而不是 `ctx.emit`：需要**回传**用户的档位，`emit` 是单向的。
 * 为什么不是 `ctx.get('userQuestions')`：那是 LLM 提问的通路，机制级询问必须在自己的
 * 通路上（见 `model-ask.ts` 头注释）。
 */
export interface CorumModelAskChannel {
  call: (
    request: {
      readonly agent: Agent
      readonly label: string
      readonly configured: { provider: string; model: string }
      readonly fallback: { provider: string; model: string }
      readonly cause: string
      readonly role: 'worker' | 'research'
      readonly options: readonly CorumModelAskOption[]
      readonly catalog: readonly {
        provider: string
        label: string
        models: readonly { model: string; label: string }[]
      }[]
    },
    next: () => Promise<CorumModelAskOutcomeEvent>,
  ) => Promise<CorumModelAskOutcomeEvent>
}

/** client 回传的决定（协议键 `kind` + 可选的选定路由）。 */
export interface CorumModelAskOutcomeEvent {
  readonly kind: 'retry' | 'temporary' | 'permanent-follow' | 'permanent-route' | 'decline' | 'dismissed'
  readonly route?: { provider: string; model: string; reasoningEffort?: string }
}

/**
 * 「**显式跟随主 Agent**」哨兵（本包**本地声明**，刻意不从 `@corum/corum-agent` import）。
 *
 * 权威定义在 `@corum/corum-agent` 的 `profile.ts`（`FOLLOW_MAIN`）。本包**不**依赖
 * 该包（依赖方向是 corum-agent → tool-subagent；反向 import 会成环，也是一处
 * `corum-agent` 自带 `ctx.agent` 类型面的越界）。跨包之间看不到彼此的类型合并，
 * 故按本仓既有手法（见 index.ts 对 `PERSONA_INJECTION_MAX_CHARS` 的同款注释）——
 * 本地声明 + 注释指回权威真源，两侧**必须逐字一致**。
 *
 * @see packages/plugins/agent/corum-agent/src/profile.ts 的 `FOLLOW_MAIN`
 */
export const FOLLOW_MAIN = 'follow-main' as const

/**
 * 会话级覆盖的**上游面**（`corumOrchestration` 服务的三个方法；键是「sessionId + 角色」双键）。
 *
 * 为什么单独声明而不是直接把服务传进来：本包按红线 3 不 import 实现包的类型面；更重要的
 * 是，只有这样「调用时到底把角色转下去了没有」才是**可单测**的一件事
 * （见 {@link corumDelegationPolicyStateFrom}——2026-10-16 的实机缺陷正出在这里）。
 */
export interface CorumOrchestrationOverrideFace {
  /** 缺省（2 参）形态 = `'worker'` 角色（历史兼容，见 corum-orchestration 的同名注释）。 */
  setModelOverride(sessionId: string, route: CorumRoute | typeof FOLLOW_MAIN): void
  setModelOverride(sessionId: string, role: 'worker' | 'research', route: CorumRoute | typeof FOLLOW_MAIN): void
  /** 缺省角色 = `'worker'`。 */
  modelOverrideOf(sessionId: string): CorumRoute | typeof FOLLOW_MAIN | undefined
  modelOverrideOf(sessionId: string, role: 'worker' | 'research'): CorumRoute | typeof FOLLOW_MAIN | undefined
  /** 缺省 = 两角色一起清（decline 档语义）。 */
  clearModelOverride(sessionId: string): void
  clearModelOverride(sessionId: string, role: 'worker' | 'research'): void
}

/**
 * 把编排服务的会话级覆盖面收成 {@link CorumDelegationPolicyState}（本包内部的窄面）。
 *
 * ## ★ 2026-10-16 真因修复：**研究角色（research）模型不可用时永不弹处理面板**
 *
 * 用户报障：只读调研子 Agent 的 provider 不存在、模型调用失败时，本该像 worker 一样弹出
 * 「模型不可用」面板让用户决定，实际却直接以错误返回（`no fallback was authorized`）。
 *
 * 旧实现把三个方法里最关键的一个写成了
 * `modelOverrideOf: sessionId => orchestration.modelOverrideOf(sessionId)` ——
 * **role 参数被丢在地上**，于是「按角色取值」静默退化成「恒取 worker 键」
 * （上游 `modelOverrideOf` 的缺省角色 = `'worker'`）。实机现场（会话
 * `corum-task-5dcf1f0b`，证据见 `.corum/logs/agent-lifecycle.jsonl` 与
 * `.corum/.agent-presets/conductor-lead/agent.json`）：
 *
 * | 时刻 | 事实 |
 * |---|---|
 * | 15:28:54Z | 用户答了 **worker** 角色的面板（永久改 `deepseek-official/deepseek-flash`）⇒ 机制用**正确的键** `setModelOverride(sessionId, route, 'worker')` 写下 worker 覆盖 |
 * | 15:39:01Z | 同一会话的 `subagent_research` 失败（配置模型 `localhost/glm-5.3-flash`）⇒ 陈旧判据拿**worker 键**去比 ⇒ 判成「陈旧失败」⇒ 静默跳过提问 ⇒ 上层抛 "no fallback was authorized"，面板永不出现 |
 *
 * 这同时解释了报障里的不对称：worker 角色的缺省恰好就是正确的键，所以 worker 弹得出来。
 *
 * 修法只此一处：三个方法都把 `role` **逐参转发**（与 `setModelOverride` 既有写法对齐）。
 * 「陈旧失败不问」这条规矩本身一字未改，由 {@link corumModelFailureIsStale} 保持。
 */
export function corumDelegationPolicyStateFrom(
  orchestration: CorumOrchestrationOverrideFace,
): CorumDelegationPolicyState {
  return {
    // 三态透传（含 `'follow-main'` 哨兵）：窄接口的调用形态是 `(sessionId, route, role?)`。
    setModelOverride: (sessionId, route, role) => role === undefined
      ? orchestration.setModelOverride(sessionId, route)
      : orchestration.setModelOverride(sessionId, role, route),
    modelOverrideOf: (sessionId, role) => role === undefined
      ? orchestration.modelOverrideOf(sessionId)
      : orchestration.modelOverrideOf(sessionId, role),
    // 缺省清两角色：decline 档的语义是「本会话的临时决定整体作废」（见 corum-orchestration
    // 的同名注释），刻意不改成按角色清 —— 那是另一个已裁决的语义，不夹带。
    clearModelOverride: sessionId => orchestration.clearModelOverride(sessionId),
  }
}

/**
 * 陈旧失败判据：本次失败声称的「配置模型」若已不等于该会话**该角色当前生效的路由**，
 * 说明用户/机制已经换过了 ⇒ 这条失败是旧路由的遗留，**不问**（返回 `stale: true`）。
 *
 * ## 为什么有这条规矩（★ 2026-09-21，用户实测后立）
 *
 * 实机现场（会话 `corum-task-1b927cf3`）：主 Agent 同时发两个 subagent，两个都拿
 * `deepseek-v4.1-flash` 起跑。用户在第 1 个弹窗选了「永久改为 glm-5.3-flash」⇒ 会话级覆盖
 * 已写、预设已改。但**第 2 个兄弟的失败在那之前就已产生**，它带着「配置模型 =
 * deepseek-v4.1-flash」这一**已经过时**的事实来问，于是用户被同一个根因又问了一遍
 * （seq 191「No choice was made」）。
 *
 * ⚠️ 只在「当前生效路由与失败路由**不同**」时才跳过：相同 ⇒ 换了也还是坏的，那时必须问
 * （那是真·新的信息）。
 *
 * ⚠️ `'follow-main'` 哨兵**不是路由**：它表示「已永久改成跟随主 Agent」⇒ 任何用具体路由
 * 报上来的失败都已成为陈旧信息（与"路由变了"同一条判据，只是落点是跟随）。漏掉这一分支
 * 会让哨兵走到 `effectiveNow.provider` ⇒ 运行时 undefined !== 'xxx' 恒真 ⇒ 恰好也 skip，
 * 但那是「靠巧合正确」；写明判据才经得起后人改动。
 *
 * ★ 2026-10-04 语义收窄（temporary 档改判「一次性消费」）：temporary 自该日起**不再写会话级
 * 覆盖**（旧实现写了且无清理 ⇒ 后续所有派发都被污染，已修复），故本判据只会命中 **permanent
 * 两档**写下的覆盖，语义收窄为「用户已永久换过路由，这条失败是旧路由遗留」。temporary 的
 * 一次性消费天然免疫陈旧失败。
 *
 * ★ 2026-10-16 抽成纯函数（真因修复的配套）：判据必须能吃 `role` 并**按该角色取键**——
 * 研究角色恒读 worker 键就会把「换了 worker 的模型」误判成「research 这条失败已过时」，
 * 于是 research 的模型不可用永不弹面板。角色 `'worker'` 与 `'research'` 写的是预设里
 * 不同的键（`subagentModel` / `researchModel`），判据必须在同一维度上比较。
 *
 * @param state - 会话级覆盖面（角色感知）。
 * @param sessionId - 父（委派方）会话 id。
 * @param role - 本次失败的角色（读**该角色**的覆盖）。
 * @param configured - 本次失败声称的「配置模型」。
 * @returns `stale=true` ⇒ 调用方按原样把失败交回主 Agent（**不重跑、不弹框**）；
 *   `effective` 供日志说明「现在是什么」。
 */
export function corumModelFailureIsStale(
  state: CorumDelegationPolicyState,
  sessionId: string,
  role: 'worker' | 'research',
  configured: { provider: string; model: string },
): { stale: boolean, effective: CorumRoute | typeof FOLLOW_MAIN | undefined } {
  // ⚠️ 必须传 role：这是 2026-10-16 缺陷的全部要害（见本函数头注释与 state 工厂的注释）。
  const effectiveNow = state.modelOverrideOf(sessionId, role)
  const staleBecauseFollowMain = effectiveNow === FOLLOW_MAIN
  if (staleBecauseFollowMain
    || (effectiveNow !== undefined
      && (effectiveNow.provider !== configured.provider || effectiveNow.model !== configured.model))) {
    return { stale: true, effective: effectiveNow }
  }
  return { stale: false, effective: effectiveNow }
}

/** 永久档的写入面（`corumAgent` 服务的窄面；缺失=无法永久写，降级为只报告）。 */
export interface CorumProfileWriteFace {
  /**
   * 写入某角色的子 Agent 模型配置。
   *
   * 三态（2026-10-11，与 `@corum/corum-agent` 的 `ProfileChildModel` 对齐）：
   *   · 具体路由 ⇒ 写该路由；
   *   · `'follow-main'` ⇒ 写**显式跟随主 Agent**哨兵（跳过全局兜底档）；
   *   · `undefined` ⇒ **删除键**（= 不覆盖，走全局档）。
   *
   * ⚠️ 「永久跟随主 Agent」必须传 `'follow-main'` 而**不是** `undefined`：后者在只加
   * 全局档的版本里会被全局档接管 ⇒ 用户的「跟随主 Agent」失效；预设本来就没配时更是
   * 空操作 ⇒ 下轮再次命中同一个坏模型 ⇒ 无限弹同一个面板。
   */
  applySubagentModelForSession: (
    sessionId: string,
    role: 'worker' | 'research',
    route: CorumRoute | 'follow-main' | undefined,
  ) => { presetId: string; applied: CorumRoute | 'follow-main' | undefined }
}

/** 提问结果（供调用方记录/测试断言）。 */
export interface CorumModelAskOutcome {
  readonly decision: CorumModelAskDecision
  /**
   * 本次重跑实际要用的路由（调用方就地消费：per-run / per-delivery 的 agentOptions）。
   *
   * 它**不是**一份会话级状态：`retry` / `temporary` 两档都不落盘，`permanent-*` 两档才
   * 另写覆盖与预设。未设置 = 不重跑（调用方按原样把失败交回）。
   */
  readonly override: CorumRoute | undefined
  /** 永久档是否真的写成功（无写入面/写失败=false）。 */
  readonly persisted: boolean
  /** 给用户的可见结论（通知文本用）。 */
  readonly summary: string
}

/**
 * 机制级提问 + 应用答案。
 *
 * **所有失败都必须被吞掉并降级**（返回一个决定而不是抛错）：本函数的调用点是子 Agent 失败
 * 之后的收尾路径，此时再抛错会把「一次委派失败」放大成「父会话这一步崩掉」，
 * 而用户的诉求恰恰是「确保任务完成」。
 *
 * @param deps - 机制依赖（状态面 + 提问通路 + 可选写入面/目录）。
 * @param parent - 委派方 Agent（waterfall 的 scope 载体）。
 * @param facts - 失败事实（label/configured/fallback/cause/role）。
 * @param channel - 独立通路的调用面（缺失=该部署没有 corum-ui-model-ask）。
 * @param signal - 取消信号（父会话取消时提问随之作废）。
 * @param logger - 告警出口。
 * @returns 决定与生效结果；任何异常都被降级为「dismissed + 无改动」。
 */
export async function corumAskAboutModelFailure(
  deps: {
    state: CorumDelegationPolicyState
    channel: CorumModelAskChannel | undefined
    profile?: CorumProfileWriteFace | undefined
    catalog?: CorumModelCatalog | undefined
  },
  parent: Agent,
  facts: CorumModelFailureFacts,
  signal: AbortSignal,
  logger: { warn: (message: string) => void },
): Promise<CorumModelAskOutcome> {
  const fail = (reason: string, decision: CorumModelAskDecision = { kind: 'dismissed' }): CorumModelAskOutcome => ({
    decision,
    override: undefined,
    persisted: false,
    summary: reason,
  })

  const channel = deps.channel
  if (channel === undefined) {
    // 没有作答通道（headless / sdk-minimal 等组合，或 UI 插件未挂）：**保守降级**——
    // 不停用委派、不改配置，明确告诉用户「机制无法询问」，把决定权交回人。绝不替用户选。
    logger.warn(`corum model-ask: no corum/model-ask channel; cannot ask about ${facts.label}`)
    return fail(
      `Subagent model unavailable (${facts.label}) and this deployment has no way to ask you: `
      + `configured ${facts.configured.provider}/${facts.configured.model} failed (${facts.cause}). `
      + `Nothing was changed. Fix the child-Agent model in Settings → Agents to keep delegating.`,
    )
  }

  // 可用模型清单（供展开面板的「永久改指定模型」内嵌选择，同时**它就是**校验 client
  // 回传路由是否存在的唯一依据——下发的那份清单与被校验的那份必须是同一份，否则用户看到的
  // 候选项与实际允许的路由会分叉）。列举失败不阻断提问：没有任何档位**必须**依赖清单才能
  // 落地（`temporary` 的指定路由在清单为空时按「无法确认」退回父路由，见
  // `corumResolveModelAskDecision`）。
  let catalog: readonly {
    provider: string
    label: string
    models: readonly { model: string; label: string }[]
  }[] = []
  if (deps.catalog !== undefined) {
    try {
      catalog = await deps.catalog.listRoutes()
    } catch (error: unknown) {
      logger.warn(`corum model-ask: listing models failed: ${String(error)}`)
    }
  }

  // ── 一次询问：四个档位 + 内嵌模型选择（方案 C：一轮完成，无第二轮问答）──
  let answer: CorumModelAskOutcomeEvent
  try {
    answer = await channel.call(
      {
        agent: parent,
        label: facts.label,
        configured: { ...facts.configured },
        fallback: { ...facts.fallback },
        cause: corumModelAskShortCause(facts.cause),
        role: facts.role,
        options: corumModelAskOptions(),
        catalog,
      },
      // 下游没人应答 ⇒ 视为「没作答」（等价于用户挂起）。绝不抛错——提问失败不该
      // 把一次委派失败放大成父会话崩溃。
      async () => ({ kind: 'dismissed' as const }),
    )
  } catch (error: unknown) {
    // 父会话取消、通路断开、client 抛错都在这里。一律降级为「不改变现状」，
    // 并把原因记进日志——绝不因为问不到就去改用户的配置。
    const detail = error instanceof Error ? error.message : String(error)
    logger.warn(`corum model-ask: could not ask about ${facts.label}: ${detail}`)
    return fail(
      `Subagent model unavailable (${facts.label}): configured ${facts.configured.provider}/${facts.configured.model} `
      + `failed (${facts.cause}). The mechanism could not ask you (${detail}), so nothing was changed.`,
    )
  }

  const decision = corumResolveModelAskDecision(
    answer.kind,
    facts.fallback,
    answer.route,
    // client 指定路由的合法性在此落定（清单是刚下发的那一份）。
    route => corumModelRouteIsAvailable(catalog, route),
  )

  // ── 应用决定 ────────────────────────────────────────────────────────────
  return applyCorumModelDecision(deps, parent, facts, decision, logger)
}

/**
 * 「同一父会话同一角色**只问一次**」的在飞表（2026-09-21 用户实测后定调）。
 *
 * ## 为什么需要它（实机现场）
 *
 * 用户会话 `corum-task-1b927cf3` 的 step 27 里，主 Agent 在**同一条消息**里发了两个并行
 * `subagent` 调用（`:187` / `:188`）。用户配置的 `deepseek-v4.1-flash` 不可用，于是：
 *
 * | seq | 事实 |
 * |---|---|
 * | 190 | 「Your Agent preset was updated permanently… now **localhost/glm-5.3-flash**」——用户答了第 1 个 |
 * | 191 | 「Subagent model unavailable (模型卡片纵向布局) … **No choice was made**」——第 2 个兄弟**又问了**一遍 |
 *
 * 两个子 Agent 都在决定落地**之前**就已用旧模型起跑，于是各自失败、各自弹窗；用户被同一个
 * 根因连问两次（且他的永久设置对**已在跑的**那个兄弟无效 —— 那是必然的，它早已起跑）。
 *
 * ## 语义
 *
 * 同一 `(父会话, 角色)` 在前一次询问**尚未落地**期间，后续失败者**共享那一个决定**，
 * 不再另起一问。落地后锁即刻释放 ⇒ 之后新起的失败仍然可以问（不是「一次会话只问一次」）。
 *
 * ⚠️ 刻意**不**按 label/委派批次分键：用户面对的是「我这个会话的子 Agent 模型坏了」这一件
 * 事，按批次分会把同一件事拆成多个弹窗 —— 那正是本条要消灭的形态。
 *
 * 键含角色（`worker` / `research`）：两者写的是预设里**不同的键**
 * （`subagentModel` / `researchModel`），把它们并成一次询问会答非所问。
 */
const inFlightAsks = new Map<string, Promise<CorumModelAskOutcome>>()

/** 在飞表的键（父会话 + 角色；角色不同 ⇒ 写的是不同预设键，不能并）。 */
function askKeyOf(parent: Agent, role: 'worker' | 'research'): string {
  return `${String(parent.session.id)}::${role}`
}

/**
 * 清空在飞表（**仅供测试**）。
 *
 * 为什么需要显式清理：本表是模块级状态（跨测试用例存活），若不在用例间清，第二条用例会
 * 拿到第一条遗留的 promise ⇒ 假绿。生产代码不需要调它（键随会话结束自然失效，
 * 且表只在「有询问在飞」期间有条目）。
 */
export function corumResetModelAskLocks(): void {
  inFlightAsks.clear()
}

/**
 * 至多一次询问的入口：同一「父会话 × 角色」已有询问在飞时**共享**它，否则发起一次。
 *
 * @param deps - 同 {@link corumAskAboutModelFailure}。
 * @param parent - 委派方 Agent（键的会话来源）。
 * @param facts - 失败事实（`role` 进键）。
 * @param signal - 取消信号。
 * @param logger - 告警出口。
 * @returns 决定与生效结果（共享者拿到的是**同一个**结果）。
 */
export function corumAskAboutModelOnce(
  deps: Parameters<typeof corumAskAboutModelFailure>[0],
  parent: Agent,
  facts: CorumModelFailureFacts,
  signal: AbortSignal,
  logger: { warn: (message: string) => void, info?: (message: string) => void },
): Promise<CorumModelAskOutcome> {
  const key = askKeyOf(parent, facts.role)
  const existing = inFlightAsks.get(key)
  if (existing !== undefined) {
    // 共享而不是再问：用户被同一个根因连问两次是实机报障的形态。
    logger.info?.(`corum model-ask: sharing the in-flight decision for ${key} instead of asking again`)
    return existing
  }
  const ask = corumAskAboutModelFailure(deps, parent, facts, signal, logger)
  inFlightAsks.set(key, ask)
  // 落地即释放锁（`.finally` 保证异常路径也释放，否则一次抛错会把该会话永久锁死）。
  void ask.finally(() => {
    if (inFlightAsks.get(key) === ask) inFlightAsks.delete(key)
  })
  return ask
}

/**
 * 生产链路入口：**陈旧闸门 → 至多一次询问**（`index.ts` 的 `corumAskAboutModel` 用的就是它）。
 *
 * ## 为什么把两步合成一个导出函数（★ 2026-10-16）
 *
 * 「模型不可用时会不会弹面板」这件事的全部逻辑就是「闸门 + 询问」这两步的**组合**：
 * 闸门单独看没错（判据写法逐字正确）、询问单独看也没错（有通道就派发），而 2026-10-16 的
 * 缺陷恰好只在这两步的**接缝**上暴露——闸门**读错了角色的键** ⇒ 恒判陈旧 ⇒ 询问这一步
 * 永不执行 ⇒ 只读调研的模型不可用静默失败，用户看不到面板。两步分开摆时，回归测试只能
 * 各自断言一段（于是都绿），合成一个导出函数后测试才能直接驱动真链路、并复现真症状。
 *
 * @param deps - 同 {@link corumAskAboutModelFailure}。
 * @param parent - 委派方 Agent（键的会话来源）。
 * @param facts - 失败事实（`role` 同时进**判据的角色键**与在飞表的键）。
 * @param signal - 取消信号。
 * @param logger - 告警/说明出口（`info` 记「陈旧失败已跳过」）。
 * @returns 陈旧 ⇒ `dismissed` + 空 `summary`（调用方按原样把失败交回主 Agent，**不重跑**：
 *   这次失败本身没有用户许可）；否则 = {@link corumAskAboutModelOnce} 的结果。
 */
export async function corumAskAboutModelUnlessStale(
  deps: Parameters<typeof corumAskAboutModelFailure>[0],
  parent: Agent,
  facts: CorumModelFailureFacts,
  signal: AbortSignal,
  logger: { warn: (message: string) => void, info?: (message: string) => void },
): Promise<CorumModelAskOutcome> {
  const verdict = corumModelFailureIsStale(deps.state, String(parent.session.id), facts.role, facts.configured)
  if (!verdict.stale) return corumAskAboutModelOnce(deps, parent, facts, signal, logger)
  const effectiveNow = verdict.effective
  logger.info?.(
    `subagent (${facts.label}): stale model failure ignored — configured ${facts.configured.provider}/${facts.configured.model} `
    + `is no longer this session's ${facts.role} child route (now ${effectiveNow === FOLLOW_MAIN ? 'follows the main Agent' : `${effectiveNow?.provider}/${effectiveNow?.model}`})`,
  )
  // 不得伪造一个路由：伪造等于替用户同意重跑（旧的「自动回退」正是被用户否掉的形态）。
  return { decision: { kind: 'dismissed' }, override: undefined, persisted: false, summary: '' }
}

/**
 * 把机制决定落到状态/配置上（纯副作用；与「问」分离以便单测直接驱动）。
 *
 * @param deps - 同 {@link corumAskAboutModelFailure}。
 * @param parent - 委派方 Agent。
 * @param facts - 失败事实。
 * @param decision - 已解析的决定。
 * @param logger - 告警出口。
 * @returns 生效结果。
 */
export function applyCorumModelDecision(
  deps: {
    state: CorumDelegationPolicyState
    profile?: CorumProfileWriteFace | undefined
  },
  parent: Agent,
  facts: CorumModelFailureFacts,
  decision: CorumModelAskDecision,
  logger: { warn: (message: string) => void },
): CorumModelAskOutcome {
  const sessionId = String(parent.session.id)
  const base = { decision, persisted: false, override: undefined }

  switch (decision.kind) {
    case 'retry': {
      // 原路由重派：**不写任何状态**（不写会话覆盖、不写预设、不记忆），
      // 只把「当初那条路由」作为本次重跑的路由交回调用方。
      //
      // 为什么返回值里必须带上路由：调用方的 `asked.route === undefined` 就是「不重跑、
      // 把失败原样交回」的判据。这里要的正是重跑，故路由照给——但给的是**用户原来的**
      // 路由，不是主 Agent 的：一次限流/超时不等于他的配置坏了。
      return {
        ...base,
        override: { ...facts.configured },
        summary:
          `You chose to retry the delegation on the same route ${facts.configured.provider}/${facts.configured.model} `
          + `(nothing was changed: no session override, no preset edit — the retry is a one-shot redispatch on the route `
          + `you had configured). If it fails again for the same reason, the model itself is the problem, `
          + `not a transient error.`,
      }
    }
    case 'temporary': {
      // ★ 2026-10-04 裁决「方案A：一次性消费」（用户实测后拍板）：
      // 旧实现把临时选择写进会话级 modelOverrides Map（无 TTL / 无任务边界清理），
      // 而每次 spawn 的路由解析 `corumSessionOverride ?? config.model` 都会读到它 ⇒
      // 后续所有新派发也被污染，与 UI 承诺的「仅本次任务」语义相悖。
      // 裁决定性：temporary **不落任何跨委派状态**——不调用 setModelOverride，
      // 只把生效路由作为返回值交给调用方就地消费（前台 attempt 重跑用它做 per-run
      // agentOptions，continuable 续跑用它做 per-delivery agentOptions，见 index.ts）。
      //
      // ★ 2026-11（issue #166）：本档可以**指定模型**——`decision.route` 可能是用户在面板里
      // 挑的那条（已由 host 用可用清单校验过），也可能仍是父路由。两种情况都只是一次性
      // 消费，任务结束即恢复，故这里的状态面一个字都不用改。回落（用户挑的模型不在清单里）
      // 必须说出来：静默换成主模型等于替用户改了主意。
      const fellBack = decision.fellBackFrom
      return {
        ...base,
        override: decision.route,
        summary: fellBack === undefined
          ? `You chose to run THIS retry on ${decision.route.provider}/${decision.route.model} `
            + `(one-shot — it applies only to this delegation retry; your saved configuration is untouched `
            + `and the next new delegation will use ${facts.configured.provider}/${facts.configured.model} again).`
          : `You picked ${fellBack.provider}/${fellBack.model} for this retry, but that route is not in the available `
            + `model list (it could not be confirmed), so THIS retry runs on ${decision.route.provider}/${decision.route.model} `
            + `instead (one-shot — your saved configuration is untouched and the next new delegation will use `
            + `${facts.configured.provider}/${facts.configured.model} again).`,
      }
    }
    case 'permanent-follow': {
      // ⚠️ 写 `'follow-main'` 哨兵，**不是** `undefined`（2026-10-11 三档修正）：
      // `undefined` 的语义是「不覆盖」⇒ 会被全局兜底档接管 ⇒ 用户选的「跟随主 Agent」
      // 失效；且预设本来就没配时（只有全局配了坏模型）那更是空操作 ⇒ 下一轮再次命中
      // 同一个坏模型 ⇒ **无限弹同一个面板**。哨兵让运行期跳过全局档。
      const result = persistCorumModelChoice(deps.profile, sessionId, facts, FOLLOW_MAIN, logger)
      // ★ 永久档必须**同时**写会话级覆盖（2026-09-19 实机：只写预设 ⇒ 第二次委派照旧
      // 拿坏模型、照旧提问）。根因：预设经 compilePreset 注入 corum-tool-subagent 的
      // `config.model`/`modelFollowMain`，而那是**插件实例创建时**的静态值——
      // `persistProfileAndRecompile` 清了 corum-agent 侧的 Agent 缓存并重编译产物，
      // 但**早已在跑的插件实例不会重建**，于是本进程内
      // `corumEffectiveModel = corumSessionOverride ?? config.model` 仍落回那个坏模型。
      // 会话级覆盖是当前进程里唯一能立即生效的通路；预设负责新会话。
      if (result.ok) deps.state.setModelOverride(sessionId, { ...facts.fallback }, facts.role)
      else deps.state.clearModelOverride(sessionId)
      return {
        ...base,
        persisted: result.ok,
        // 让调用方拿到生效路由（重跑要用它；永久档此前返回 undefined ⇒ 上游不重跑）。
        ...result.ok ? { override: { ...facts.fallback } } : {},
        summary: result.ok
          ? `Your Agent preset was updated permanently: its ${facts.role} child-Agent model now follows the main Agent (this overrides the unavailable ${facts.configured.provider}/${facts.configured.model}). `
            + `This session now runs on ${facts.fallback.provider}/${facts.fallback.model}; new sessions keep the preset change.`
          : `You chose to make the child Agent follow the main Agent, but the mechanism could NOT save it — reason: ${result.reason}. Change it manually in Settings → Agents.`,
      }
    }
    case 'permanent-route': {
      const result = persistCorumModelChoice(deps.profile, sessionId, facts, decision.route, logger)
      // ★ 同 permanent-follow：写预设只对新会话生效，当前进程必须补会话级覆盖。
      if (result.ok) deps.state.setModelOverride(sessionId, { ...decision.route }, facts.role)
      else deps.state.clearModelOverride(sessionId)
      return {
        ...base,
        persisted: result.ok,
        ...result.ok ? { override: { ...decision.route } } : {},
        summary: result.ok
          ? `Your Agent preset was updated permanently: its ${facts.role} child-Agent model is now ${decision.route.provider}/${decision.route.model} (replacing the unavailable ${facts.configured.provider}/${facts.configured.model}). `
            + `This session now runs on that model; new sessions keep the preset change.`
          : `You chose ${decision.route.provider}/${decision.route.model} permanently, but the mechanism could NOT save it — reason: ${result.reason}. Change it manually in Settings → Agents.`,
      }
    }
    case 'decline': {
      // ★ 2026-09-19 用户实测纠正：这一档**只表示「不要再用那个坏模型重试」**，
       // **不是**把会话的委派能力关掉。前一版在此注册 tools.guard 硬禁用整个会话，
       // 结果主 Agent 连「换个模型重派」「用 subagent_research 调研」都做不到，还在
       // 通知里读到「delegation is DISABLED for this session」，索性把所有活（含本该
       // 委派的）都自己干了。会话的委派能力不因此改变：之后主动要派就派。
      deps.state.clearModelOverride(sessionId)
      return {
        ...base,
        summary:
          `You chose not to retry the delegation: the configured child-Agent model ${facts.configured.provider}/${facts.configured.model} `
          + `is unavailable. The mechanism will NOT re-issue that delegation automatically — the failure is handed back to you as-is. `
          + `The session's delegation capability is UNCHANGED: you may still delegate (for example after switching to a working model, `
          + `or for work that does not need the unavailable one). Nothing was changed about your saved configuration.`,
      }
    }
    case 'dismissed':
    default: {
      return {
        ...base,
        summary:
          `Subagent model unavailable (${facts.label}): configured ${facts.configured.provider}/${facts.configured.model} failed (${facts.cause}). `
          + `No choice was made, so nothing changed — delegation still uses your configured model. If it keeps failing, change the child-Agent model in Settings → Agents.`,
      }
    }
  }
}

/**
 * 写预设（永久档）。返回**失败原因**而不是裸 boolean。
 *
 * 为什么要带原因（2026-09-18 实机教训）：第一版只返回 `false`，于是把「服务取不到」
 * 与「服务取到了但写盘抛错」渲染成同一句 "could not save it (no writable profile)"——
 * 实机那次真因是**服务查找方式写错**（`ctx.root.get` 取不到），却被文案误导成
 * "没有可写的 profile"，排查方向直接跑偏。错误信息必须说真话。
 */
function persistCorumModelChoice(
  profile: CorumProfileWriteFace | undefined,
  sessionId: string,
  facts: CorumModelFailureFacts,
  route: CorumRoute | typeof FOLLOW_MAIN | undefined,
  logger: { warn: (message: string) => void },
): { ok: true } | { ok: false; reason: string } {
  if (profile === undefined) {
    logger.warn('corum model-ask: the corumAgent service is unreachable; cannot persist the permanent choice')
    return { ok: false, reason: 'the profile-write capability (corumAgent) was unreachable from the delegation mechanism' }
  }
  try {
    profile.applySubagentModelForSession(sessionId, facts.role, route)
    return { ok: true }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    logger.warn(`corum model-ask: persisting the permanent choice failed: ${detail}`)
    return { ok: false, reason: detail }
  }
}
