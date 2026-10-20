/**
 * fork（corum）：orchestrate 编排卡的数据形与折叠逻辑。
 *
 * 数据源（全部来自父会话自身的事件窗口，无需新宿主通路）：
 * - `tool/call` name='orchestrate' 的 `arguments`：`tasks[]`（label / prompt /
 *   isolation（worktree / main / always / write-tasks / off）/ research /
 *   background）或 scripted 模式（`script` + `meta`）。
 * - `tool/result` 的正文（**2026-10 编排黑盒化后的新契约**，全结构化 JSON）：
 *   ```
 *   { mode, results:[{index,label,ok,aborted,childSessionId,worktreeSlug,branch,output?}],
 *     closer:{scenario,childSessionId,report,reportPath,reportWritten,internalNotes,error},
 *     parentTreeTasks, integration? }
 *   ```
 *   关键变化（本文件据此改造）：
 *   ① `results[]` 只带**任务级引用**（childSessionId / worktreeSlug / branch），自由文本
 *      `output` 已不再回（只透传 `tasks[].schema` 的结构化子结果）；
 *   ② 收尾行为由机制按**隔离实况**自动判定（`closer.scenario` ∈ merge/summarize/research），
 *      模型侧的 `merge` 声明已取消 ⇒ `hasMerge` 对新会话恒 false；
 *   ③ `integration` 只为**历史会话回放**保留（新结果不再产生）。
 *   历史会话仍是旧投影格式（`[task N · label] done` 行 + `[corum integration] …`），
 *   故各解析器都保留「双格式兼容」，解析失败时优雅降级为「运行中/未知」。
 *
 * ⚠️ 为什么不用 `presentCall/presentResult` 的结构化 meta：实测 `tool/result`
 * 的 `meta` 恒为 null（宿主 present* 只喂了通用卡），所以结构化状态只能由本
 * 折叠器从 arguments + 正文重建。
 */

/** 一个编排任务的静态声明（来自 `tasks[i]`）。 */
export interface OrchestrateTask {
  /** 数组下标（宿主结果里 `[task N]` 用的就是它）。 */
  readonly index: number
  /** 展示标签（`tasks[i].label`，缺省回退 `task N`）。 */
  readonly label: string
  /**
   * 隔离策略：worktree=隔离 worktree（机制缺省）；main=父树直跑；
   * always/write-tasks=旧档位（兼容历史会话）；off=旧「不隔离」（机制已废弃，
   * 仅历史会话出现）。
   */
  readonly isolation?: 'worktree' | 'main' | 'always' | 'write-tasks' | 'off'
  /**
   * 任务提示词全文（`tasks[i].prompt`，tool/call arguments 耐久携带，刷新后仍在；
   * 分支卡展开区的任务详情数据源，免去 RPC）。
   */
  readonly prompt?: string
  /** 只读研究任务（无 worktree）。 */
  readonly research?: boolean
  /** 后台运行（continuable，可 send_message 续接）。 */
  readonly background?: boolean
  /**
   * 任务级**机制锁定**的模型（`tasks[i].model`）；缺省时子 Agent 跟随实例/全局
   * 默认，卡片改为读子会话的 modelSelection 投影（见 OrchestrateCard 的模型行）。
   */
  readonly model?: string
}

/** 一个任务的终态（来自工具结果正文）。
 *  `aborted` = 主 Agent 手动终止该分支（宿主渲染串 `aborted:<label>`）。 */
export type OrchestrateTaskOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failed'; readonly error: string }

/** 集成（fan-in）阶段状态。
 *  ⚠️ 2026-10 编排黑盒化后**只为历史会话回放保留**：新结果不再产生 `integration`
 *  （收尾改由 `closer.scenario === 'merge'` 表达）。解析口径不变。 */
export type OrchestrateIntegration =
  /** 声明了 `merge` → 机制在所有任务 settle 后跑集成者（merge + verify + commit）。 */
  | {
      readonly kind: 'integrated'
      /**
       * 集成者子会话 id（宿主写进结果正文 `· child <id>`，durable）。
       * 编排卡的「进入会话」按钮用它——运行期另有 `corum/subagent/child` 帧
       * （label `integrate`），但推送帧不重放，刷新后只有这里能给出入口。
       */
      readonly childSessionId?: string
    }
  /** 集成者未跑（有任务失败而中止；或本次调用未声明 `merge`——那要主 Agent 自己 `subagent { integrate: true }`）。 */
  | { readonly kind: 'pending'; readonly reason: string; readonly branches: readonly string[] }

/**
 * 收尾节点（closer）的场景——机制**自动判定**，模型不再传任何开关。
 *
 * - `merge`：台账里有待集成的隔离分支 ⇒ 合并回主 + 探测式 verify + 汇总；
 * - `summarize`：有写任务但全在 main（无分支）⇒ 只汇总，不合并；
 * - `research`：全 research ⇒ 只把各结论汇成核查报告。
 */
export type OrchestrateCloserScenario = 'merge' | 'summarize' | 'research'

/**
 * 收尾节点（closer）的结果——整次编排唯一结算的那一份（`tool/result` 的 `closer`）。
 *
 * 这是编排黑盒化的**主交付**：各任务正文不再进 `results[]`，而是由 closer 汇总成
 * `report`（同一份也落盘在 `reportPath`）。`error` 在场 = closer 自身失败（此时
 * `report` 可能缺省，但 `results[]` 的任务级引用照旧可用——损失面可见）。
 */
export interface OrchestrateCloser {
  readonly scenario: OrchestrateCloserScenario
  /** closer 子会话 id（编排卡「进入会话」按钮的 durable 来源）。 */
  readonly childSessionId?: string
  /** 收尾报告正文（主 Agent 读的就是它）。 */
  readonly report?: string
  /** 报告落盘路径（CORUM_HOME 临时路径，阅后即焚的过程产物）。 */
  readonly reportPath?: string
  /** 报告是否真的写盘成功（失败不影响正文返回）。 */
  readonly reportWritten?: boolean
  /** 机制在编排期间收拢的内部说明（原本会以 notice 注入父会话的那些）。 */
  readonly internalNotes?: readonly string[]
  /** closer 自身失败的原因。 */
  readonly error?: string
}

/** 编排调用的整体模式。 */
export type OrchestrateMode = 'tasks' | 'script'

/** 一张编排卡的完整折叠结果。 */
export interface OrchestrateChatData {
  /** 声明式任务清单（scripted 模式为空数组）。 */
  readonly tasks: readonly OrchestrateTask[]
  readonly mode: OrchestrateMode
  /** scripted 模式的工作流名（`meta.name`）。 */
  readonly scriptName?: string
  /**
   * 是否声明了 `merge`（旧契约，决定要不要画「集成者」节点）。
   * ⚠️ **@deprecated 2026-10 编排黑盒化后恒 false**：`merge` 字段已从工具入参取消，
   * 收尾行为由机制按隔离实况判定。结尾节点的渲染门与三态改读 `closer`（见 OrchestrateCard）。
   * 字段保留只为历史会话回放不炸（旧 `tool/call.arguments` 里确实还有它）。
   */
  readonly hasMerge: boolean
  /** 父侧 `tool/call` id（子会话广播按它 + label 关联）。 */
  readonly callId: string
  /** 锚定卡片位置的父事件 seq。 */
  readonly anchorSeq: number
  /** 父侧调用时间。 */
  readonly time: number
  /** 任务终态（下标 → 结果）；工具未返回时为空 Map（= 全部运行中）。 */
  readonly outcomes: ReadonlyMap<number, OrchestrateTaskOutcome>
  /** 工具是否已返回（false = 进行中）。 */
  readonly settled: boolean
  /** 工具本身是否报错（isError，例如 orchestrate 整体抛错）。 */
  readonly errored: boolean
  /**
   * 收尾节点（closer）的结果（`tool/result.closer`）。
   *
   * undefined 有两种含义，由 `settled` 区分：
   * - `!settled` → closer **还在跑**（机制在任务全 settle 后串行派发它），
   *   结尾节点显示「队列中 / 收尾中」；
   * - `settled` → 结果里没有 closer（历史会话 / 旧投影 / 工具报错），结尾节点按
   *   工具是否报错落到「收尾失败」或「未收尾」。
   */
  readonly closer?: OrchestrateCloser
  /**
   * 集成阶段状态。
   * ⚠️ **@deprecated 2026-10**：新结果不再产生（只为历史会话回放解析）。
   */
  readonly integration?: OrchestrateIntegration
  /**
   * 逐任务的子会话 id（下标 → childSessionId，undefined = 未关联）。
   *
   * 三层来源：① 结果里的 `results[].childSessionId`（**durable**，2026-10 新增）；
   * ② 运行期宿主 spawn 广播（'corum/subagent/child'）精确给出；③ 历史回放（页面刷新后
   * 无广播帧且结果无该字段）退化为 session/list 的 origin='subagent' 时间就近匹配
   * ——与 `conversation-nodes/subagent.ts` 的 correlateChild 同口径。
   */
  readonly childSessionIds?: readonly (string | undefined)[]
  /**
   * 逐任务的隔离 worktree slug（下标 → slug）。
   * 实时台账（'corum/worktree-ledger' 推送帧）优先，本字段是刷新后的耐久兜底
   * （2026-10 起来自 `results[].worktreeSlug`，不再从自由文本 `output` 里抠路径）。
   */
  readonly worktreeSlugs?: ReadonlyMap<number, string>
  /**
   * 逐任务的隔离分支名（下标 → branch，2026-10 起来自 `results[].branch`）。
   * 分支副行与「改动」区在台账缺失时用它。
   */
  readonly worktreeBranches?: ReadonlyMap<number, string>
}

/** `[task N · label] done|failed: msg | aborted: msg` 行（label 可缺省）。
 *  `aborted` = 主 Agent 手动终止该分支（与 `failed:` 前缀并列，同样解析风格）。 */
const TASK_LINE = /^\[task (\d+)(?: · ([^\]]*))?\] (done|aborted|failed)(?::\s*(.*))?$/u

/** `tool/result` 结构化 JSON 的形状（2026-09-16 起 render 直接回 JSON；2026-10 加
 *  `closer` 与 `results[].childSessionId/worktreeSlug/branch`）。字段一律 unknown，
 *  由各解析器逐个收窄——正文是宿主产出，但历史会话里的形态不可控。 */
interface StructuredResult {
  results?: unknown
  closer?: unknown
  integration?: unknown
}

/**
 * 把 `tool/result` 正文解析成结构化对象（解析不出来 / 不是对象 → undefined）。
 *
 * 为什么单独抽出来：`parseOutcomes` / `parseWorktreeSlugs` / `parseTaskRefs` /
 * `parseIntegration` / `parseCloser` 五处都要先试一次 JSON.parse；各写一份
 * try/catch 只会让「非 JSON 时回落文本」这条分支被改漏一处。
 * @param text - `tool/result` 正文。
 * @returns 结构化对象，或 undefined（非 JSON / 非对象）。
 */
function parseStructured(text: string): StructuredResult | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed as StructuredResult
  } catch {
    return undefined
  }
}

/** 结构化 `results[]` 的每一项（字段全 unknown，由各解析器逐个收窄）。 */
type StructuredResultItem = Record<string, unknown>

/** 从结构化结果的 `results[]` 里取出所有对象项（非对象项直接丢弃）。 */
function resultsOf(parsed: StructuredResult | undefined): readonly StructuredResultItem[] {
  if (parsed === undefined || !Array.isArray(parsed.results)) return []
  return parsed.results.filter((item): item is StructuredResultItem =>
    typeof item === 'object' && item !== null)
}

/**
 * 解析工具结果正文里的任务终态。
 *
 * **双格式兼容（2026-09-16 render 改全结构化 JSON）**：
 * - 优先按**结构化 JSON**解析（新 render：`{mode, results:[{index,ok,aborted,error}], integration}`）；
 * - 回落**正则文本行**（旧 render / 历史会话的 `[task N · label] done|failed` 投影）。
 * 旧会话的 `failed:` 结果仍可解析。
 * @param text - `tool/result` 的正文（宿主 render 的输出）。
 * @returns 下标 → 终态。
 */
export function parseOutcomes(text: string): ReadonlyMap<number, OrchestrateTaskOutcome> {
  const out = new Map<number, OrchestrateTaskOutcome>()
  // ① 结构化 JSON（新 render 全结构化格式）。
  const structured = resultsOf(parseStructured(text))
  if (structured.length > 0) {
    for (const item of structured) {
      const index = typeof item['index'] === 'number' ? item['index'] : NaN
      if (!Number.isSafeInteger(index)) continue
      if (item['aborted'] === true) {
        out.set(index, { kind: 'aborted' })
      } else if (item['ok'] === true) {
        out.set(index, { kind: 'done' })
      } else {
        const error = item['error']
        out.set(index, { kind: 'failed', error: typeof error === 'string' ? error : '' })
      }
    }
    if (out.size > 0) return out
  }
  // ② 正则文本行（旧 render 投影 / 历史会话）。
  for (const rawLine of text.split('\n')) {
    const matched = TASK_LINE.exec(rawLine.trim())
    if (matched === null) continue
    const index = Number(matched[1])
    if (!Number.isSafeInteger(index)) continue
    const kind = matched[3]
    if (kind === 'done') {
      out.set(index, { kind: 'done' })
    } else if (kind === 'aborted') {
      out.set(index, { kind: 'aborted' })
    } else {
      out.set(index, { kind: 'failed', error: matched[4]?.trim() ?? '' })
    }
  }
  return out
}

/**
 * 从工具结果正文里提取隔离 worktree 的 slug（`wt-xxxxxx`）。
 *
 * **2026-10 迁移点（黑盒化后这是主路径）**：新契约的 `results[].worktreeSlug` 是
 * 可寻址字段，直接读即可——**不再**从自由文本 `output` 里抠 `.corum-worktrees/wt-…`
 * 路径（自由文本已不再回，只有 `tasks[].schema` 的结构化子结果才透传 `output`）。
 * 旧路径仍作兜底，因为历史会话的结果里只有正文。
 *
 * 为什么需要这条兜底：`corum/worktree-ledger` 只在**运行期**广播（推送帧），页面刷新后
 * 不重放 → 历史会话的分支副行拿不到 worktree 名。故结果里的 slug 是**耐久兜底**：
 * 实时台账优先，取不到时用这里的值。
 *
 * ⚠️ 文本分段必须**按 `[task N]` 分段**再取 slug，不能全篇收集后按下标对齐：只有隔离
 * 任务的输出才带路径，全篇收集会把 task 2 的 slug 错配到 task 0（本轮实测踩到）。
 * @param text - `tool/result` 正文。
 * @returns 下标 → 该任务的 slug（无则不含该键）。
 */
export function parseWorktreeSlugs(text: string): ReadonlyMap<number, string> {
  const out = new Map<number, string>()
  const parsed = parseStructured(text)
  if (parsed !== undefined) {
    // ① 新契约：`results[].worktreeSlug`（可寻址字段，首选）。
    for (const item of resultsOf(parsed)) {
      const taskIndex = typeof item['index'] === 'number' ? item['index'] : NaN
      if (!Number.isSafeInteger(taskIndex)) continue
      const slug = str(item['worktreeSlug'])
      if (slug !== undefined) out.set(taskIndex, slug)
    }
    if (out.size > 0) return out
    // ② 旧结构化兜底：`results[].output` 里回显的路径（历史会话 + schema 子结果）。
    for (const item of resultsOf(parsed)) {
      const taskIndex = typeof item['index'] === 'number' ? item['index'] : NaN
      if (!Number.isSafeInteger(taskIndex)) continue
      const output = item['output']
      if (typeof output !== 'string') continue
      const matched = /\.corum-worktrees\/(wt-[0-9a-z]+)/u.exec(output)
      if (matched !== null) out.set(taskIndex, matched[1])
    }
    if (out.size > 0) return out
  }
  // ③ 文本分段（旧 render 投影 / 历史会话）：按 `[task N …]` 分段。
  const parts = text.split(/\[task (\d+)(?: · [^\]]*)?\]/u)
  for (let index = 1; index + 1 < parts.length; index += 2) {
    const taskIndex = Number(parts[index])
    if (!Number.isSafeInteger(taskIndex)) continue
    const matched = /\.corum-worktrees\/(wt-[0-9a-z]+)/u.exec(parts[index + 1])
    if (matched !== null) out.set(taskIndex, matched[1])
  }
  return out
}

/**
 * 从工具结果正文里提取**逐任务的 durable 引用**（2026-10 新契约）。
 *
 * 三个字段都来自 `results[]` 的可寻址引用，是编排卡在**页面刷新后**唯一还活着的
 * 跳转/隔离信息（spawn 广播与 worktree 台账都是推送帧，不重放）：
 * - `childSessionId`：分支行「进入会话」按钮（此前刷新后没有入口）；
 * - `worktreeSlug` / `branch`：分支副行的 `worktree · wt-…` 与改动区的分支名。
 *
 * 历史会话（旧投影 / 无这些字段）一律返回空 Map，调用方按旧路径兜底。
 * @param text - `tool/result` 正文。
 * @returns 逐任务的引用字段（各 Map 只含解析到的下标）。
 */
export function parseTaskRefs(text: string): {
  childSessionIds: ReadonlyMap<number, string>
  worktreeSlugs: ReadonlyMap<number, string>
  branches: ReadonlyMap<number, string>
} {
  const childSessionIds = new Map<number, string>()
  const worktreeSlugs = new Map<number, string>()
  const branches = new Map<number, string>()
  for (const item of resultsOf(parseStructured(text))) {
    const taskIndex = typeof item['index'] === 'number' ? item['index'] : NaN
    if (!Number.isSafeInteger(taskIndex)) continue
    const child = str(item['childSessionId'])
    if (child !== undefined) childSessionIds.set(taskIndex, child)
    const slug = str(item['worktreeSlug'])
    if (slug !== undefined) worktreeSlugs.set(taskIndex, slug)
    const branch = str(item['branch'])
    if (branch !== undefined) branches.set(taskIndex, branch)
  }
  return { childSessionIds, worktreeSlugs, branches }
}

/**
 * 解析收尾节点（closer）的结果——编排黑盒化后的**主交付**。
 *
 * 机制按隔离实况自动判定场景（`merge` / `summarize` / `research`），把各任务正文
 * 汇总成 `report`（同一份落盘在 `reportPath`）。UI 侧据此渲染结尾节点的三态，
 * 并给出 closer 子会话的「进入会话」入口（`childSessionId`，durable）。
 *
 * `scenario` 是唯一必填字段；非法/缺省时整体返回 undefined（调用方按「结果里没有
 * closer」处理 = 结尾节点显示失败态，而不是编一个场景出来）。
 * @param text - `tool/result` 正文。
 * @returns closer 结果，无该对象时 undefined。
 */
export function parseCloser(text: string): OrchestrateCloser | undefined {
  const parsed = parseStructured(text)
  const raw = parsed?.closer
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const scenario = record['scenario']
  if (scenario !== 'merge' && scenario !== 'summarize' && scenario !== 'research') return undefined
  const childSessionId = str(record['childSessionId'])
  const report = str(record['report'])
  const reportPath = str(record['reportPath'])
  const reportWritten = bool(record['reportWritten'])
  const error = str(record['error'])
  const notes = Array.isArray(record['internalNotes'])
    ? record['internalNotes'].filter((note): note is string => typeof note === 'string')
    : undefined
  return {
    scenario,
    ...childSessionId === undefined ? {} : { childSessionId },
    ...report === undefined ? {} : { report },
    ...reportPath === undefined ? {} : { reportPath },
    ...reportWritten === undefined ? {} : { reportWritten },
    ...notes === undefined || notes.length === 0 ? {} : { internalNotes: notes },
    ...error === undefined ? {} : { error },
  }
}

/** `[corum integration] …` 行。 */
const INTEGRATION_LINE = /^\[corum integration\] (.+)$/u

/**
 * 解析集成阶段状态。
 *
 * ⚠️ **@deprecated 2026-10 编排黑盒化**：新结果不再产生 `integration`（收尾改由
 * `closer.scenario === 'merge'` 表达），本函数只为**历史会话回放**保留——旧工具结果
 * 里确实还有这个对象与 `[corum integration] …` 行。
 *
 * **双格式兼容（2026-09-16 render 改全结构化 JSON）**：优先读 JSON 的
 * `integration` 对象（`{integrated, childSessionId?, error?, pendingBranches}`），
 * 回落 `[corum integration] …` 文本行（旧投影 / 历史会话）。
 * @param text - `tool/result` 的正文。
 * @returns 集成状态，无该行时 undefined。
 */
export function parseIntegration(text: string): OrchestrateIntegration | undefined {
  // ① 结构化 JSON（旧 render 全结构化格式）。
  const raw = parseStructured(text)?.integration
  if (typeof raw === 'object' && raw !== null) {
    const integration = raw as { integrated?: unknown; childSessionId?: unknown; error?: unknown; pendingBranches?: unknown }
    // error 在场 = 集成失败（Bug B：runIntegrate 不再 throw，错误并入 integration.error）。
    if (typeof integration.error === 'string' && integration.error !== '') {
      const branches = Array.isArray(integration.pendingBranches) ? integration.pendingBranches.filter((b): b is string => typeof b === 'string') : []
      return { kind: 'pending', reason: integration.error, branches }
    }
    if (integration.integrated === true) {
      const child = typeof integration.childSessionId === 'string' ? integration.childSessionId : undefined
      return child === undefined ? { kind: 'integrated' } : { kind: 'integrated', childSessionId: child }
    }
    const branches = Array.isArray(integration.pendingBranches) ? integration.pendingBranches.filter((b): b is string => typeof b === 'string') : []
    return { kind: 'pending', reason: branches.length > 0 ? `${branches.length} 个分支待集成` : '待集成', branches }
  }
  // ② 文本行（旧 render 投影 / 历史会话）。
  for (const rawLine of text.split('\n')) {
    const matched = INTEGRATION_LINE.exec(rawLine.trim())
    if (matched === null) continue
    const body = matched[1]
    if (body.startsWith('merged + committed')) {
      // `… into the main tree · child <sessionId>`（宿主 2026-09-12 起带上）。
      const child = /·\s*child\s+(\S+)/u.exec(body)
      return child === null ? { kind: 'integrated' } : { kind: 'integrated', childSessionId: child[1] }
    }
    // `N branch(es) pending: a, b, c — call ...`
    const pending = /^(\d+) branch\(es\) pending: ([^—]*)/u.exec(body)
    const branches = pending === null
      ? []
      : pending[2].split(',').map(part => part.trim()).filter(part => part !== '')
    return { kind: 'pending', reason: branches.length > 0 ? `${branches.length} 个分支待集成` : '待集成', branches }
  }
  return undefined
}

/** Read a string field off an untrusted value. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read a boolean field off an untrusted value. */
function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * 从 `tool/call` 的 `arguments`（JSON 字符串或已解析对象）折叠静态任务清单。
 * @param args - `tool/call` 的 `arguments` 原值。
 * @returns 任务清单与模式信息；解析不出来时任务清单为空。
 */
export function parseCallArguments(args: unknown): {
  tasks: readonly OrchestrateTask[]
  mode: OrchestrateMode
  scriptName?: string
  /**
   * 是否声明了 `merge`。
   * ⚠️ **2026-10 起对新会话恒 false**：`merge` 字段已从工具入参取消（收尾由机制按
   * 隔离实况判定）。这里仍解析它，只为历史会话的 `tool/call` 回放不丢信息。
   */
  hasMerge: boolean
} {
  let parsed: unknown = args
  if (typeof args === 'string') {
    try { parsed = JSON.parse(args) } catch { return { tasks: [], mode: 'tasks', hasMerge: false } }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { tasks: [], mode: 'tasks', hasMerge: false }
  }
  const record = parsed as Record<string, unknown>
  const merge = typeof record['merge'] === 'object' && record['merge'] !== null
    ? record['merge'] as Record<string, unknown>
    : undefined
  const meta = typeof record['meta'] === 'object' && record['meta'] !== null
    ? record['meta'] as Record<string, unknown>
    : undefined
  const rawTasks = Array.isArray(record['tasks']) ? record['tasks'] : []
  const tasks: OrchestrateTask[] = []
  rawTasks.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return
    const task = entry as Record<string, unknown>
    const isolation = str(task['isolation'])
    const prompt = str(task['prompt'])
    const model = typeof task['model'] === 'object' && task['model'] !== null
      ? task['model'] as Record<string, unknown>
      : undefined
    const modelLabel = model === undefined
      ? undefined
      : [str(model['model']), str(model['reasoningEffort'])].filter(part => part !== undefined).join(' · ')
    tasks.push({
      index,
      label: str(task['label']) ?? `task ${index}`,
      ...isolation === 'worktree' || isolation === 'main' || isolation === 'always' || isolation === 'write-tasks' || isolation === 'off' ? { isolation } : {},
      ...prompt === undefined ? {} : { prompt },
      ...bool(task['research']) === true ? { research: true } : {},
      ...bool(task['background']) === true ? { background: true } : {},
      ...modelLabel === undefined || modelLabel === '' ? {} : { model: modelLabel },
    })
  })
  const scripted = str(record['script']) !== undefined
  return {
    tasks,
    mode: scripted ? 'script' : 'tasks',
    ...(scripted ? { scriptName: str(meta?.['name']) ?? '(unnamed)' } : {}),
    hasMerge: merge !== undefined,
  }
}

/** 一张卡片的 head 摘要：标题 + 计数。 */
export interface OrchestrateSummary {
  readonly title: string
  readonly done: number
  readonly aborted: number
  readonly failed: number
  readonly total: number
}

/**
 * 折叠 head 摘要（设计稿 `编排工作流 · 3 任务并行`
 * + 状态 chip `并行执行中 · 0/3` / `3/3 完成` / `1/3 · 1 失败`）。
 *
 * ⚠️ 只有标题 + 计数，**没有副标题**（#96）：原先标题下方还有一行小字
 * （`fan-out 并发 → fan-in 汇合 → 自动集成/分支留待手动集成` 或脚本模式的
 * `脚本编排 · 逐阶段推进`），与「流程图 + 状态 chip」已经表达的信息重复，
 * 用户在卡头只要一眼读出「这是什么 + 到哪一步了」。故该字段与渲染点一并删除；
 * 收尾阶段的差别由结尾节点的 chip 表达（已集成/汇总完成/失败/队列中）。
 *
 * **标题不带场景后缀**（2026-10-20 用户定调）：原先 closer 返回后标题会多一个
 * ` · merge` / ` · summarize` / ` · research`，与设计稿不符——用户走查时明确要求
 * 移除。职责分工改为：**标题只说「这是什么 + 几个任务」**，「这次到底有没有合并」
 * 由结尾节点的 chip（已集成 / 已汇总 / 已核查）回答，信息不丢且标题更干净。
 * @param data - 折叠结果。
 * @returns 摘要文案与计数。
 */
export function summarize(data: OrchestrateChatData): OrchestrateSummary {
  const total = data.tasks.length
  const done = [...data.outcomes.values()].filter(o => o.kind === 'done').length
  const aborted = [...data.outcomes.values()].filter(o => o.kind === 'aborted').length
  const failed = [...data.outcomes.values()].filter(o => o.kind === 'failed').length
  if (data.mode === 'script') {
    return {
      title: `编排工作流 · ${data.scriptName ?? '(unnamed)'}`,
      done, aborted, failed, total,
    }
  }
  return {
    title: `编排工作流 · ${total} 任务并行`,
    done, aborted, failed, total,
  }
}
