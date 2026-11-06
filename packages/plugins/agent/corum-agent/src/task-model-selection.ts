/**
 * fork（corum）：task 会话的模型绑定安装——官方 `installModelSelection` 的
 * 「用户显式选择优先」变体。
 *
 * 背景（2026-09-09 用户实测，PROGRESS 第 57 轮）：corum 在 `createAgentForTask`
 * 的 setup 里就把自己的选择装进 Agent 作用域；官方 session-controller 的 ref
 * 直到首次 `session/prompt` 才装、且注册在**更内层**。cordis waterfall 里
 * 先注册的监听是外层（拿到 next() 的最终返回值后再覆盖），于是用户在 composer
 * 里换模型（`session/selectModel` 成功、事件也落了盘）会被外层 corum 选择静默
 * 盖回创建时的模型：用户选了 deepseek-official，实际请求仍打 localhost/kimi-k3-1。
 *
 * 会话投影 pending > lastUsed > 安装时的选择，统一装配与请求的完整路由。
 * 创建/复用也写本会话 metadata，因此不依赖官方 Controller 的内存选择缓存。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { VISION_CAPABILITY, VISION_SECTION } from './vision.ts'

/** 会话级模型选择投影里本文件用到的最小形状（官方 api-session-controller 注册）。 */
interface ModelSelectionProjectionLike {
  /** 尚未被请求消费的显式选择（用户刚选的模型）。 */
  pending?: ModelSelection | null
  /** 最近一次实际请求用的模型。 */
  lastUsed?: ModelSelection | null
}

/** `sessionProjections` 服务的最小能力面（避免耦合官方包的类型增强）。 */
interface ProjectionReader {
  stateOf: (session: Session, key: 'modelSelection') => unknown
}

/** 读取本会话持久化的待用路由；消费后沿用 lastUsed（含 effort）。 */
export function taskModelSelectionOf(ctx: Context, session: Session): ModelSelection | undefined {
  const projections = ctx.get('sessionProjections') as ProjectionReader | undefined
  const state = projections?.stateOf(session, 'modelSelection') as ModelSelectionProjectionLike | undefined
  return state?.pending ?? state?.lastUsed ?? undefined
}

/**
 * 装配返回的段形状（只声明本文件用到的两个字段）。
 *
 * 之所以在本地收窄而不是 import 官方类型：本文件只**搬运** `assembled.sections`，
 * 对段的其余字段（order 等）一无所知，也必须原样透传。
 */
interface AssembledSection {
  readonly name: string
  readonly text: string
}

/**
 * 把视觉能力段**恰好放一份**进本次装配（`enabled === false` 时一份都不放）。
 *
 * ## 为什么不能直接 append（2026-09-21 实机缺陷）
 *
 * 本函数所在的 acceptor 是 `system-prompt/assemble` 的**一层**。该事件是 cordis
 * **waterfall**：每层 `await next()` 拿到的都是**外层已完成**的装配，于是「直接 append」
 * 在**装了两层**时就写出两份段 —— 实测用户会话 `corum-task-5b48662f` 的 system prompt 里
 * 「You can see images in this conversation…」**逐字节重复两遍**。
 *
 * ## 为什么不靠「重装前先撤销上一次监听」来修（我第一版就是这么写的，已撤回）
 *
 * 那种改法动的是**监听器的生死**，而本文件的 acceptor 与 `agent/request` 的模型绑定同属
 * 一次 install —— 撤销语义一改，模型绑定的 waterfall 行为随之改变
 * （下游注释明写「创建时的外层监听会兜住后装的」）。**那是另一个关注点，不该被这条修动到。**
 *
 * ## 现在这个改法
 *
 * 幂等性放在**装配层**（语义真正发生的地方）：先剔除同名的 `VISION_SECTION` 段，再按需插入
 * 一份 ⇒ 无论本 acceptor 被装几层、谁先谁后，最终**恰好一份**。于是：
 *   · 不碰 disposer / 监听数量；模型绑定语义逐字不变；
 *   · 将来再多一处 install 也不会重现（幂等是结构性的，不是调用方纪律）。
 *
 * ## 哨兵为什么是**段名**而不是内容
 *
 * cordis 的段名本就唯一，且名称是唯一标识；**按内容比对会引入一个真 bug**：
 * 模型换掉后视觉能力可能由「支持」变「不支持」（或反之），内容比对会把该**更新**误判成
 * 「重复」而不刷新，于是模型能力换了、提示词却留在旧状态。
 *
 * ## 顺序
 *
 * 与旧行为一致：有该段时它排在**末尾**（旧代码就是 append 到末尾）。
 *
 * @param sections - 外层装配给出的段列表（**原样保留**除视觉段外的所有段及顺序）。
 * @param enabled - 目标模型是否确认支持图片输入。
 * @returns 新段列表。
 */
function withVisionSection(
  sections: readonly AssembledSection[],
  enabled: boolean,
): AssembledSection[] {
  const withoutVision = sections.filter(section => section.name !== VISION_SECTION)
  if (!enabled) return withoutVision
  return [...withoutVision, { name: VISION_SECTION, text: VISION_CAPABILITY }]
}

/** `ctx.llm` 的最小能力面（按需取，避免加载顺序耦合）。 */
interface ModelInfoProbe {
  resolveModelInfo: (provider: string, model: string) => Promise<{ inputModalities?: readonly string[] }>
}

/**
 * 目标模型是否显式支持图片输入。
 *
 * **语义严格对齐官方**（`api-session-controller/commands.ts` 的准入校验）：
 * `inputModalities` 为 `undefined` 表示「未知」，**不当作不支持**——否则本地模型
 * 未声明模态时会被误判为纯文本，视觉提示词永远挂不上。只有显式声明且不含
 * `image` 才算不支持。查询失败同样返回 false（不注入，宁缺勿错）。
 * @param provider - 供应商路由 id。
 * @param model - 模型 id。
 * @returns 是否为已确认的视觉模型。
 */
async function supportsImageModel(ctx: Context, provider: string, model: string): Promise<boolean> {
  try {
    const llm = (ctx as unknown as { llm?: ModelInfoProbe }).llm
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return false
    const info = await llm.resolveModelInfo(provider, model)
    return info.inputModalities !== undefined && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

/**
 * 安装一个「用户显式选择优先」的模型绑定。
 * @param agentCtx - 目标 Agent 的作用域上下文。
 * @param agent - 该作用域归属的 Agent（官方 0.1.5 起由 setup 第二参传入；旧版经
 *   `agentCtx.agent` accessor 取，0.1.5 删除了该 accessor，故改为显式参数）。
 * @param selection - 调用方持有的可变选择（current/assembled）。
 * @returns 两个作用域监听的 disposer。
 */
export function installTaskModelSelection(agentCtx: Context, agent: Agent, selection: ModelSelectionRef): () => void {
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = taskModelSelectionOf(agentCtx, agent.session) ?? selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    // 视觉能力段：目标模型显式声明支持 image 输入时，把「你现在能收图」这一
    // 事实注入本次组装（模型本身不知道会话此刻绑的是哪个模型，部署默认是纯文本时
    // 尤其明显）。能力查询是异步且可能失败——失败即不注入，绝不影响组装。
    const vision = await supportsImageModel(agentCtx, selected.provider, selected.model)
    return {
      ...assembled,
      sections: withVisionSection(assembled.sections, vision),
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model,
      },
    }
  })
  const disposeRequest = agentCtx.on(
    'agent/request',
    async (_payload, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      const selected = selection.assembled
      if (selected === undefined) return resolved
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
      return {
        ...withoutInheritedEffort,
        provider: selected.provider,
        model: selected.model,
        ...selected.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selected.reasoningEffort },
      }
    },
  )
  return () => {
    disposeAssembly()
    disposeRequest()
  }
}
