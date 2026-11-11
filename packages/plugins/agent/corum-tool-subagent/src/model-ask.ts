/**
 * fork（corum）2026-09-18：**子 Agent 指定模型不可用 ⇒ 机制问用户**的策略核。
 *
 * ## 与上一版（自动重试）的区别
 *
 * 上一版是「机制自动退回主路由重跑一次 + 事后通知」。用户 2026-09-18 改为**先问用户**，
 * 并按任务形态分两条规则：
 *
 *   1. **前台或后台任务且能 continue 的**：主 Agent 直接询问用户是否回退继续；选「是」则
 *      **临时**更换为主 Agent 的模型完成任务；选「否」则报告子 Agent 配置模型不可用，
 *      后续**主 Agent 不再派遣子 Agent**，所有工作由主 Agent 继续。
 *   2. **一次性任务**：失败后由主 Agent 提醒用户子 Agent 配置的 LLM 当前无法使用，询问是否
 *      同意后续临时切换为主 Agent 模型；选「是」则由主 Agent **重新指派**子 Agent 并使用与
 *      主 Agent 一致的模型完成任务；选「否」则主 Agent 不再指派任何任务，由其全权承担开发
 *      直到任务完成。
 *
 * ## 用户的补充约束（决定了本文件的形状）
 *
 * · **全权由机制保证，不给 LLM 开改模型的口子**——用户原话：「第一个注入的活是机制来干？
 *   如果同意了，还需要 LLM 调用工具更改子 Agent 的模型，这无疑给 LLM 开了一个坏口子。应该
 *   新增机制，全权由机制保证」。故**一切都在机制里做**：问用户、解析答案、改路由、
 *   停用委派，全是本模块的代码，**不新增任何 LLM 可调用的工具或参数**。
 * · **临时生效，不覆盖用户的设置**——用户原话：「并且是临时生效，不覆盖用户的设置，即用户
 *   新建对话，如果用户还配置了原来不可用的大模型，仍然会调用失败，触发这个机制」。故「临时」
 *   只写进会话级内存（`corumOrchestration` 的 `modelOverrides`），**绝不写 settings.yaml /
 *   预设**；新会话照旧用用户配的模型，照旧失败、照旧问。
 * · **提问卡要给永久入口**——用户：「当然在新建的 UI 给用户一个永久更改配置的入口，快捷的
 *   处理这个隐患」，并进一步明确「要用户既能选永久跟随主 Agent 也能选别的模型这才对」。
 *   故永久档有两个选项：永久跟随主 Agent、永久改为**指定的另一个模型**。
 *
 * ## 为什么走自己的 host 通路，而不是借 userQuestions
 *
 * 本机制**不**复用 `ctx.userQuestions`。提问是机制级的、由失败事件驱动，与 LLM 主动调用
 * `ask_user_question` 工具是两码事：共用一个 waterfall 会让模型的提问和机制的提问在同一条
 * 通路里互相影响（谁先应答、谁被 delegate、超时归谁），而两者的生命周期、取消语义、文案
 * 归属都不同。故本机制在 host 侧起一条**独立通路** `corum/model-ask/request`（waterfall，
 * 见 corum-api-remotes 的转发白名单），由 `corum-ui-model-ask` 这个 client 插件应答。
 *
 * 顺带（这也是当初考虑 userQuestions 的原因）：`approval.request()` 语义是「允许/拒绝**
 * 本次工具调用**」且要求会话有 open turn，本场景的失败可能来自**后台 job 在工具早已返回
 * 之后**才 settle，approval 那条路先天不可用；而自有 waterfall 没有 turn 门禁。
 */

/**
 * 档位的**机制词汇表**（`kind` 即协议）。
 *
 * 协议走 `kind`（稳定标识）而不是选项 label：label 是给人看的文案，会随 UI 改版与本地化
 * 变动，把它当协议键会让「用户选了哪一档」随文案漂移。label/description 只作呈现，由
 * {@link corumModelAskOptions} 下发（host 是词汇表的唯一事实源，client 只渲染）。
 */
export const CORUM_MODEL_ASK_OPTIONS = [
  {
    // 最保守的一档排在最前：它**不写任何状态**（不覆盖、不记忆），只是拿原路由再派一次。
    // 用户 2026-11 的诉求：换模型的重跑一直是**隐式**发生的，缺一个「就用原来那个再试一次」
    // 的显式按钮——限流/超时这类瞬时故障本来就不该被当成「配置坏了」。
    kind: 'retry',
    label: '再试一次',
    description: '不换模型 · 用原路由重新派发，不写任何覆盖、不记忆',
  },
  {
    kind: 'temporary',
    label: '临时用主模型',
    // 「可指定模型」不是文案粉饰：面板选中本档时会展开模型选择，用户挑的那条路由只用于
    // 这一次重跑（host 校验其合法性，见 `corumResolveModelAskDecision`）。
    description: '仅本次任务 · 任务结束即恢复，可选指定模型',
  },
  {
    kind: 'permanent-route',
    label: '永久改指定模型',
    // 2026-11 用户裁定（issue #166 第 2 项）：**不再有单独的「永久跟随主 Agent」档**。
    // 想跟着主 Agent 就在这里直接把主 Agent 那条路由选上（可选范围本来就是全部模型）；
    // 机制不必替用户再发明一个「跟随」语义 —— 它只会让「跟随」与「钉住」两种意思
    // 在预设里长得一样、行为却不同（FOLLOW_MAIN 哨兵 vs 具体路由）。
    description: '从下方选择并记住（可选主 Agent 用着的那条）',
  },
  {
    kind: 'cancel',
    label: '取消本次委派',
    // issue #166 第 4 项。语义边界与 2026-09-19 的实测纠正一致：取消的是**这一次**派发，
    // 不是会话的委派能力 —— 那一版把「停止委派」实现成会话级硬禁用，用户实测后撤回。
    description: '不重试、不改配置；这次委派作废，会话仍可继续派别的任务',
  },
] as const satisfies readonly CorumModelAskOption[]

/** 一个档位的呈现数据（`kind` 是协议，label/description 是文案）。 */
export interface CorumModelAskOption {
  readonly kind: CorumModelAskDecision['kind']
  readonly label: string
  readonly description: string
}

/**
 * 下发档位清单（host → client）。
 *
 * 为什么由 host 下发而不是 client 里硬编码：档位与「机制接受哪些 kind」必须同源，否则
 * client 多画一个没有对应处置的档位，用户点了会静默落进 dismissed。
 * @returns 四个档位的呈现数据（顺序即 UI 顺序）。
 */
export function corumModelAskOptions(): readonly CorumModelAskOption[] {
  return CORUM_MODEL_ASK_OPTIONS
}

/** 用户在提问卡上作答后的**机制决定**（答案被解析成这个联合，而不是字符串散落各处）。 */
export type CorumModelAskDecision =
  /**
   * 再试一次：用**原路由**（当初为他配置的那个）重新派发一次。
   *
   * 为什么不复用 `temporary`：temporary 的语义是「换成另一条路由跑一次」，而这里要的是
   * 「什么配置都不动，就照原样再试」。两者在状态面上都无副作用，但对用户的承诺不同——
   * 「重试」不能顺手把他的路由改成主 Agent 的（那会让一次限流变成一次配置变更）。
   */
  | { readonly kind: 'retry' }
  /**
   * 临时改用给定路由（本次任务有效，不落盘、不写会话覆盖）。
   *
   * `route` 是**实际要用的**路由：client 在面板上指定的路由只有在 host 确认它真实存在
   * 于可用模型清单后才取用它；确认不了就退回父路由，并把用户原本指定的那条记在
   * `fellBackFrom` 里——文案必须据此如实说明回落（静默换模型是本仓明令禁止的形态）。
   */
  | {
    readonly kind: 'temporary'
    readonly route: { provider: string; model: string; reasoningEffort?: string }
    /** client 指定过、但 host 判为不可用（或无法确认）的那条路由。 */
    readonly fellBackFrom?: { provider: string; model: string; reasoningEffort?: string }
  }
  /** 永久改为指定路由（写预设）。 */
  | { readonly kind: 'permanent-route'; readonly route: { provider: string; model: string; reasoningEffort?: string } }
  /** 拒绝：不再委派，主 Agent 自己做。 */
  /** 取消本次委派：不重试、不改配置、不碰会话委派能力（issue #166 第 4 项）。 */
  | { readonly kind: 'cancel' }
  /** 用户放弃/关掉了问题（或没有作答通道）——机制按「保守=不改变现状且继续」处理。 */
  | { readonly kind: 'dismissed' }

/** 一次失败的两个关键事实（提问文案与后续动作都要用）。 */
export interface CorumModelFailureFacts {
  /** 哪个子 Agent（label，给人话上下文）。 */
  readonly label: string
  /** 用户为该角色配置的模型路由（不可用的那个）。 */
  readonly configured: { provider: string; model: string }
  /** 机制将采用的回退路由（主 Agent 的真实路由）。 */
  readonly fallback: { provider: string; model: string }
  /** 失败原因原文（子 Agent 的报错）。 */
  readonly cause: string
  /** 该角色（决定永久档写 subagentModel 还是 researchModel）。 */
  readonly role: 'worker' | 'research'
}

/**
 * 通知条的**一行摘要**（收起态第二行：哪个子 Agent + 为什么失败）。
 *
 * 为什么只给一行：通知条停在对话顶部、不阻塞阅读，用户此刻只需要「谁、为什么」就能
 * 决定要不要点「处理」；完整事实在展开面板里。
 * @param facts - 失败事实。
 * @returns 一行摘要文本。
 */
export function corumModelAskSummary(facts: CorumModelFailureFacts): string {
  return `${facts.label} · ${facts.configured.model} ${corumModelAskShortCause(facts.cause)}`
}

/**
 * 把失败原因压成适合一行展示的短语。
 *
 * 为什么需要压缩：`cause` 是子 Agent 的报错原文（可能很长，含堆栈与 JSON），
 * 直接塞进一行会把通知条撑破。这里只取首个句子/片段，完整原文仍进展开面板。
 * @param cause - 失败原因原文。
 * @returns 一行内的短原因。
 */
export function corumModelAskShortCause(cause: string): string {
  const firstLine = cause.split('\n', 1)[0] ?? ''
  const firstSentence = firstLine.split(/(?<=[。.！!？?])\s*/, 1)[0] ?? firstLine
  const trimmed = firstSentence.trim()
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed
}

/**
 * 解析用户的机制决定 → 规范化的 {@link CorumModelAskDecision}。
 *
 * 为什么单独成函数：这段判定是**安全关键**的（错判会把用户的「不要」当成「要」，
 * 或者默默替用户挑一个模型），抽出来才能被单测直接钉住，而不必起一个 UI。
 *
 * ## 为什么 client 传来的路由只当**候选**（`routeIsAvailable` 的由来）
 *
 * client 是呈现层，它肚子里的模型清单也是 host 下发的——但它回传的路由**没有经过任何
 * 校验**：一条早已下架、或清单列举失败时被拼错的路由，若直接拿去重跑，用户会再吃一次
 * 「模型不可用」，并且看不出机制到底用了什么。故 `temporary` 的指定路由必须先在可用清单
 * 里落过实（`routeIsAvailable`），落不实就退回父路由并**如实告知**（`fellBackFrom`）。
 * 判据仍在本文件（纯判定），校验数据由 `model-ask-run.ts` 注入。
 *
 * @param kind - client 回传的档位（协议键；未知/缺失一律视为「没作答」）。
 * @param fallback - 机制提供的回退路由（主 Agent 路由；`temporary` 档未指定模型时取它）。
 * @param pickedRoute - 用户在展开面板里选的模型路由（`temporary` / `permanent-route` 两档可带）。
 * @param routeIsAvailable - 该路由是否真的存在于可用模型清单（缺省=无法确认，按不可用处理）。
 * @returns 规范化决定；无法识别时返回 `dismissed`（保守：不改变现状）。
 */
export function corumResolveModelAskDecision(
  kind: string | undefined,
  fallback: { provider: string; model: string; reasoningEffort?: string },
  pickedRoute: { provider: string; model: string; reasoningEffort?: string } | undefined,
  routeIsAvailable?: (route: { provider: string; model: string }) => boolean,
): CorumModelAskDecision {
  switch (kind) {
    case 'retry':
      // 原路由重派：决定里不带任何路由——由 host 用它已掌握的「配置路由」装配，
      // 这样「重试」永远不会被 client 顺带改成另一条路由。
      return { kind: 'retry' }
    case 'temporary': {
      if (pickedRoute === undefined) {
        // 只点了档位、没挑模型 = 「就用主 Agent 模型」，机制自己解析出的父路由。
        return { kind: 'temporary', route: { ...fallback } }
      }
      const requested = { ...pickedRoute }
      if (routeIsAvailable !== undefined && routeIsAvailable(requested)) {
        return { kind: 'temporary', route: requested }
      }
      // 确认不了（清单空/列举失败）与确认不存在同等处理：退回父路由，并留下回落痕迹，
      // 让通知能说清「你选的 X 不可用，这次跑的是 Y」。
      return { kind: 'temporary', route: { ...fallback }, fellBackFrom: requested }
    }
    case 'permanent-route':
      // 选了「永久改为指定模型」但没带回路由（用户只点档位没选模型）⇒ 保守当作
      // dismissed，绝不默默替用户挑一个模型（那正是用户明确反对的「替我做主」）。
      return pickedRoute === undefined
        ? { kind: 'dismissed' }
        : { kind: 'permanent-route', route: { ...pickedRoute } }
    // 兼容：旧 client / 历史会话仍可能回传 `decline`（2026-11 之前的档位名），
    // 语义与新档 `cancel` 完全一致，映射过去即可，不需要第二条分支。
    case 'cancel':
    case 'decline':
      return { kind: 'cancel' }
    default:
      return { kind: 'dismissed' }
  }
}
