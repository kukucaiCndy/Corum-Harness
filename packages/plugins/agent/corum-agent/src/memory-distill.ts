/**
 * fork（corum）：**经验沉淀**——把会话内容提炼成记忆。
 *
 * ## 为什么独立成文件
 *
 * 沉淀是耗时操作（LLM 调用 + 会话树枚举 + 回放拉取），与 agent 生命周期/权限/泳道
 * 编排**零耦合**。照 `polish-service.ts` 的拆分理由：独立成文件方便维护。
 *
 * ## 两种触发模式
 *
 * - **自动沉淀**：压缩完成时（`compaction/end` 无 error），自动提炼被压缩内容写记忆。
 *   fire-and-forget 到独立队列，不阻塞压缩。
 * - **手动沉淀**：侧栏「提炼经验」菜单触发，对整棵会话树回放做沉淀。
 *
 * ## 模块边界
 *
 * - **进**：`Context`（`ctx.get('llm')` / `ctx.memory` / `ctx.sessionPersistence`）、
 *   `PolishConfig`（模型路由）。
 * - **出**：提炼出的事实写入记忆底座（`ctx.memory.putFact`）。
 * - **不碰**：会话创建、Agent、沙箱、权限、profile 编译。
 *
 * @module @corum/corum-agent/memory-distill
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadPolishConfig } from './profile-store.ts'
import { loadProfile } from './profile-store.ts'
import { findSession } from './session-index.ts'
import { corumHome } from './home.ts'
import type { ProfileModel } from './profile.ts'

// ── 类型 ──────────────────────────────────────────────────────────────────────

/** 自动沉淀的入参：压缩完成后从 compaction 事件提取。 */
export interface AutoDistillInput {
  /** 发生压缩的会话 id。 */
  sessionId: string
  /** 被压缩遮蔽的 seq 列表（compaction/summary 事件的 `shadowedSeqs`）。 */
  shadowedSeqs: readonly number[]
  /** 压缩摘要文本（compaction/summary 事件的 summary blocks 文本）。 */
  summary: string
}

/** 手动沉淀的入参：对一棵会话树回放做沉淀。 */
export interface ManualDistillInput {
  /** 会话树的根 sessionId（手动触发的那条会话）。 */
  sessionId: string
}

/** distill 任务状态。 */
export type DistillJobStatus = 'running' | 'done' | 'error' | 'cancelled'

/**
 * 候选事实：LLM 提炼产出但**未经用户确认**的经验条目（与 contract/agent.ts 同步）。
 *
 * - `state='pending'`：等待用户取舍。
 * - `state='committed'`：已 `distillCommit` 写入记忆（幂等：重复 commit 不重写）。
 * - `state='discarded'`：已 `distillDiscard` 标记为丢弃。
 */
export interface DistillCandidate {
  id: string
  fact: string
  importance: number
  retention: 'temporary' | 'short' | 'long' | 'permanent'
  state: 'pending' | 'committed' | 'discarded'
}

/** distill 任务进度/结果。 */
export interface DistillJob {
  jobId: string
  status: DistillJobStatus
  /** 产出的候选条数（完成时为最终值；候选经 commit 确认后才落记忆）。 */
  factCount: number
  /** 当前阶段描述（running 时给 UI 显示）。 */
  phase: string
  /** 失败原因（status='error' 时）。 */
  error?: string
  /** 关联的会话 id（通知跳转/记忆页用）。 */
  sessionId: string
  /** 候选事实列表（status='done' 时填充；含 pending/committed/discarded 全状态）。 */
  candidates?: DistillCandidate[]
  /** 来源：`'auto'` 自动沉淀 / `'manual'` 手动触发。 */
  origin?: 'auto' | 'manual'
}

/** putFact 入参的最小面（与 MemoryService.putFact 同形，窄化避免耦合实现包）。 */
interface MemoryPutFactFace {
  putFact: (input: {
    fact: string
    importance?: number
    source?: string
    agentId?: string
    author: string
    retention?: 'temporary' | 'short' | 'long' | 'permanent'
    evidence?: string[]
  }) => Promise<{ rejected: readonly string[] }>
}

/** memory 服务的能力面。 */
interface MemoryFace extends MemoryPutFactFace {
  deleteBySource: (source: string, agentId?: string) => Promise<number>
}

/** 线上 LLM 服务的能力面。 */
interface LlmFace {
  stream: (request: unknown) => AsyncIterable<unknown>
}

/** sessionPersistence 的能力面（枚举 + 读历史）。 */
interface PersistenceFace {
  list: () => Promise<readonly SessionPersistenceSnapshot[]>
  open: (id: SessionId, mode: 'read') => Promise<{
    read: (offset: number) => Promise<{ events: readonly SessionEvent[] }>
    close: () => Promise<void>
  }>
}

// ── 任务表（照 artgen txt2imgJobs 模式）────────────────────────────────────────

/**
 * 进行中的 distill 任务表（distillStart 创建，distillStatus 轮询，distillCancel 取消）。
 *
 * 完成的任务在 5 分钟后自动清理（与 artgen 同款）。
 */
const distillJobs = new Map<string, DistillJob & PersistExtras>()

/**
 * 每个内存热缓存条目**已知与磁盘一致的时点**（磁盘文件 mtimeMs）。
 *
 * 用于 BUG-6 修复（2026-11-19）：`getDistillJob` 命中内存即返回，从不校验磁盘
 * 是否更新 ⇒ 磁盘上被外部改写（另一进程 / 手写 fixture）后，
 * `distillStatus({jobId})` 仍返回旧快照，而同 jobId 的 `distillListPending()`
 * （纯扫盘）返回新快照——同一 job 两个 RPC 不一致。
 *
 * 语义：条目值 = 最近一次「内存与磁盘对齐」时磁盘文件的 mtimeMs；读时若磁盘
 * mtime 更新则磁盘胜出并回填内存。
 * - 新建 job 尚无磁盘文件 ⇒ 记 `Date.now()`（此后任何写盘 mtime 都更大）。
 * - `persistJob` 写盘后记**写后 stat 的 mtimeMs**（亚毫秒精度，避免同一毫秒内
 *   写盘被误判为「不比 stamp 新」）。
 * - 只改内存不改盘的路径（`cancelDistillJob`）不动 stamp ⇒ 磁盘不会被误判更新，
 *   内存里的 cancelled 状态保留。
 */
const distillJobStamps = new Map<string, number>()

/** 生成 jobId。 */
function newJobId(): string {
  return `distill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 校验 sessionId 是**非空字符串**，否则抛可读错误（fail-loud，不建 job）。
 *
 * 动因（2026-11-19）：wire 双层包装（`{input:{sessionId}}`）曾让服务端解出
 * `sessionId === undefined`，旧实现照样建 job 并异步跑，跑到
 * `emitDistillCompleted` 才被 lossless 序列化校验炸掉——错误现场离根因很远。
 * 现在入口即拦：调用方拿到明确报错，无 job/无落盘/无 emit。
 *
 * 导出供 `agent-service.ts` 的 `distillStart` RPC 入口复用（单一判据）。
 *
 * @param sessionId - 待校验的会话 id。
 * @param where - 出错位置（拼进错误消息，便于定位调用点）。
 * @throws Error sessionId 不是非空字符串。
 */
export function assertSessionId(sessionId: unknown, where: string): asserts sessionId is string {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new Error(
      `${where}: sessionId 必须是非空字符串（收到 ${describeWireValue(sessionId)}）`,
    )
  }
}

/** 把非法 wire 值描述成可读短串（不 dump 整个对象，避免日志噪音）。 */
function describeWireValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return '空字符串'
  if (typeof value === 'object') return `对象(${Object.keys(value as object).join(',') || '无键'})`
  return `${typeof value}:${String(value)}`
}

/** 自动清理已完成的任务（5 分钟后）。只清内存热缓存，不删磁盘记录。 */
function scheduleCleanup(jobId: string): void {
  setTimeout(() => {
    distillJobs.delete(jobId)
    distillJobStamps.delete(jobId)
  }, 5 * 60_000)
}

// ── 磁盘持久化 ─────────────────────────────────────────────────────────────────

/**
 * job 记录落盘目录：`<corumHome>/distill-jobs/`。
 *
 * 照仓内 corum-agent 现有磁盘状态先例（skill-catalog 的 `<home>/skills/`、
 * session-index 的 `<home>/sessions.json`），用 `corumHome()` 解析 home，
 * `node:path` join 拼路径、`node:fs/promises` 读写——三平台无隐式假设。
 */
function distillJobsDir(): string {
  return join(corumHome(), 'distill-jobs')
}

/** 单个 job 的磁盘文件路径。 */
function distillJobPath(jobId: string): string {
  return join(distillJobsDir(), `${jobId}.json`)
}

/**
 * 把 job 记录（含 candidates、source、author、agentId、origin）落盘。
 * 写盘失败不阻断提炼（console.warn 后继续）。
 */
async function persistJob(job: DistillJob & PersistExtras): Promise<void> {
  try {
    const dir = distillJobsDir()
    await mkdir(dir, { recursive: true })
    const record: PersistedJobRecord = {
      jobId: job.jobId,
      status: job.status,
      factCount: job.factCount,
      phase: job.phase,
      ...(job.error === undefined ? {} : { error: job.error }),
      sessionId: job.sessionId,
      ...(job.candidates === undefined ? {} : { candidates: job.candidates }),
      ...(job.origin === undefined ? {} : { origin: job.origin }),
      source: job.source,
      author: job.author,
      ...(job.agentId === undefined ? {} : { agentId: job.agentId }),
    }
    await writeFile(distillJobPath(job.jobId), JSON.stringify(record, null, 2), 'utf8')
    // BUG-6：记录写后真实 mtime，作为「内存与磁盘对齐」的时点（见 distillJobStamps）。
    // 用 stat 而非 Date.now()：同一毫秒内写盘时 Date.now() 可能不比文件 mtime 小，
    // 会让后续 checkDiskNewer 误判「磁盘没比内存新」。
    try {
      const st = await stat(distillJobPath(job.jobId))
      distillJobStamps.set(job.jobId, st.mtimeMs)
    } catch {
      distillJobStamps.set(job.jobId, Date.now())
    }
  } catch (e) {
    console.warn(`[corum-agent] distill job 落盘失败（不阻断提炼）: ${job.jobId}`, e)
  }
}

/**
 * 从磁盘读单个 job（含 persist 时存的 source/author/agentId/origin 等扩展字段）。
 * 读不到返回 null（不抛错）。
 */
async function loadJobFromDisk(jobId: string): Promise<(DistillJob & PersistExtras) | null> {
  try {
    const raw = await readFile(distillJobPath(jobId), 'utf8')
    const parsed = JSON.parse(raw) as PersistedJobRecord
    return {
      jobId: parsed.jobId,
      status: parsed.status,
      factCount: parsed.factCount,
      phase: parsed.phase,
      ...(parsed.error === undefined ? {} : { error: parsed.error }),
      sessionId: parsed.sessionId,
      ...(parsed.candidates === undefined ? {} : { candidates: parsed.candidates }),
      ...(parsed.origin === undefined ? {} : { origin: parsed.origin }),
      source: parsed.source,
      author: parsed.author,
      ...(parsed.agentId === undefined ? {} : { agentId: parsed.agentId }),
    }
  } catch {
    return null
  }
}

/**
 * 读磁盘 job + 该文件的 mtimeMs（一次 stat + 一次 read）。
 *
 * 与 {@link loadJobFromDisk} 分开的理由：`getDistillJob` 需要 mtime 判断
 * 「磁盘是否比内存新」（BUG-6），而 `listAllJobsFromDisk` 只要内容。
 *
 * @param jobId - 任务 id。
 * @returns job + mtimeMs；文件不存在/读不动返回 null。
 */
async function loadJobFromDiskWithStat(
  jobId: string,
): Promise<{ job: DistillJob & PersistExtras; mtimeMs: number } | null> {
  let mtimeMs: number
  try {
    mtimeMs = (await stat(distillJobPath(jobId))).mtimeMs
  } catch {
    return null
  }
  const job = await loadJobFromDisk(jobId)
  if (job === null) return null
  return { job, mtimeMs }
}

/**
 * 内存/磁盘取 job 的**唯一入口**（BUG-6 修复点）。
 *
 * 旧实现命中内存即返回、从不看磁盘 ⇒ 磁盘被外部改写后同一 jobId 在
 * `distillStatus`（走内存）与 `distillListPending`（纯扫盘）得到两份不同快照。
 * 现在：内存命中也要 stat 一次磁盘，磁盘更新则**磁盘胜出并回填内存**。
 *
 * 三条边界：
 * - 磁盘没有该文件（job 刚建、尚未落盘）⇒ 内存为准。
 * - 内存无 stamp（老实现留下的条目）⇒ 一律以磁盘为准（保守：磁盘是持久事实）。
 * - 只有内存变、磁盘没变（`cancelDistillJob`）⇒ mtime 不新 ⇒ 内存保留。
 *
 * @param jobId - 任务 id。
 * @returns 内存里的活对象（调用方需自行 `{...}` 拷贝以避免外部改内部状态）；
 *   内存与磁盘都找不到返回 null。
 */
async function resolveJob(jobId: string): Promise<(DistillJob & PersistExtras) | null> {
  const cached = distillJobs.get(jobId)
  const fromDisk = await loadJobFromDiskWithStat(jobId)
  if (cached === undefined) {
    if (fromDisk === null) return null
    distillJobs.set(jobId, fromDisk.job)
    distillJobStamps.set(jobId, fromDisk.mtimeMs)
    return fromDisk.job
  }
  if (fromDisk === null) return cached
  const stamp = distillJobStamps.get(jobId)
  if (stamp === undefined || fromDisk.mtimeMs > stamp) {
    distillJobs.set(jobId, fromDisk.job)
    distillJobStamps.set(jobId, fromDisk.mtimeMs)
    return fromDisk.job
  }
  return cached
}

/**
 * 扫描磁盘 job 目录，返回所有 job 记录（含扩展字段），按 mtime 新→旧排序。
 * 读不到任何文件返回空数组（不抛错）。
 */
async function listAllJobsFromDisk(): Promise<(DistillJob & PersistExtras)[]> {
  try {
    const dir = distillJobsDir()
    const files = await readdir(dir)
    const jobs: (DistillJob & PersistExtras)[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const jobId = file.slice(0, -5)
      const job = await loadJobFromDisk(jobId)
      if (job !== null) jobs.push(job)
    }
    return jobs
  } catch {
    return []
  }
}

// ── persist 时附加的扩展字段（不入 DistillJob wire 类型，只在磁盘存） ────────

/** job 落盘时除 DistillJob 字段外额外存的 source/author/agentId。 */
interface PersistExtras {
  source: string
  author: string
  agentId?: string
}

/** 磁盘上的完整 job 记录形状。 */
interface PersistedJobRecord extends DistillJob {
  source: string
  author: string
  agentId?: string
}

// ── 会话树枚举 ─────────────────────────────────────────────────────────────────

/**
 * 枚举一棵会话树：从根 sessionId 出发，找到它和它所有子孙会话（通过 `parentSession` 关联）。
 *
 * 用 `sessionPersistence.list()` 拿全部 header（只 stat 文件元数据、不读事件日志），
 * 然后按 `parentSession` 字段建父子索引，BFS 遍历。
 *
 * @param persistence - 会话持久化服务。
 * @param rootSessionId - 根会话 id。
 * @returns 该会话树的所有 sessionId 列表（含根）。
 */
async function enumerateSessionTree(
  persistence: PersistenceFace,
  rootSessionId: string,
): Promise<readonly string[]> {
  let snapshots: readonly SessionPersistenceSnapshot[]
  try {
    snapshots = await persistence.list()
  } catch {
    return [rootSessionId]
  }
  // parentSession → children 索引。
  const childrenOf = new Map<string, string[]>()
  for (const { header } of snapshots) {
    const id = String(header.id)
    // header.parentSession 可能是 SessionId 类型（有 .id 属性）或 string。
    const parent = header.parentSession
    const parentId = parent === undefined ? undefined : String(parent)
    if (parentId === undefined) continue
    const list = childrenOf.get(parentId)
    if (list === undefined) {
      childrenOf.set(parentId, [id])
    } else {
      list.push(id)
    }
  }
  // BFS：从根出发收集整棵树。
  const result: string[] = [rootSessionId]
  const queue: string[] = [rootSessionId]
  const seen = new Set<string>([rootSessionId])
  while (queue.length > 0) {
    const current = queue.shift()!
    const children = childrenOf.get(current)
    if (children === undefined) continue
    for (const child of children) {
      if (seen.has(child)) continue
      seen.add(child)
      result.push(child)
      queue.push(child)
    }
  }
  return result
}

/**
 * 读取一个会话的持久化事件（照 agent-service.ts 的 readPersistedEvents helper）。
 */
async function readPersistedEvents(
  persistence: PersistenceFace,
  sessionId: string,
): Promise<readonly SessionEvent[]> {
  const handle = await persistence.open(SessionId(sessionId), 'read')
  try {
    const result = await handle.read(0)
    return result.events
  } finally {
    await handle.close()
  }
}

// ── LLM 调用（照 polish-service.ts 的 generateOnline 范式 + assembler.finish 检查）──────

/**
 * 调用 LLM 提炼经验。
 *
 * 照 `polish-service.ts` 的 `generateOnline` 范式（ctx.llm.stream + BlockAssembler），
 * 但补上 `assembler.finish` 检查：如果 finish 原因是 `max-tokens`，说明输出被截断，
 * 抛错让调用方知道提炼不完整。
 *
 * @param ctx - 承载 `llm` 服务的上下文。
 * @param model - 模型路由（provider / model / reasoningEffort）。
 * @param content - 待提炼的会话内容文本。
 * @returns 提炼出的事实列表（每条一行，JSON 数组）。
 */
async function distillViaLlm(
  ctx: Context,
  model: ProfileModel,
  content: string,
): Promise<readonly string[]> {
  const llm = ctx.get('llm' as never) as unknown as LlmFace | undefined
  if (llm === undefined) throw new Error('llm 服务不可用（无法调用线上模型）')
  const system = [
    'You are an experience distillation assistant. You are given a conversation transcript (or a compaction summary).',
    'Extract reusable facts, lessons learned, preferences, and important decisions from it.',
    'Each fact should be a concise, self-contained statement that would be useful in future sessions.',
    'Output a JSON array of strings, each string is one fact. No markdown code fence, no extra text.',
    'Example output: ["User prefers tabs over spaces for indentation","The project uses pnpm as package manager"]',
    'If there is nothing worth remembering, output an empty array: []',
  ].join(' ')
  const assembler = new BlockAssembler()
  const effort = model.reasoningEffort
  for await (const chunk of llm.stream({
    provider: model.provider,
    model: model.model,
    ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    system,
    messages: [createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'system-prompt' } })],
    temperature: 0.2,
    maxTokens: 2048,
  })) {
    assembler.push(chunk as never)
  }
  // 补上 assembler.finish 检查（polish-service 缺这层）：max-tokens 说明输出被截断。
  const finish = assembler.finish
  if (finish.kind === 'max-tokens') {
    throw new Error('LLM 输出被 max-tokens 截断，提炼结果可能不完整')
  }
  const raw = assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  return parseFactsEnvelope(raw)
}

/**
 * 解析 LLM 返回的事实 JSON 数组。
 * 模型可能把 JSON 包在代码块或前后加解释文字，先抓第一个平衡的 `[...]`。
 * @param raw - 模型原始输出。
 * @returns 事实字符串列表；解析失败返回空数组。
 */
function parseFactsEnvelope(raw: string): readonly string[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map(item => item.trim())
  } catch {
    return []
  }
}

// ── 候选生成 ───────────────────────────────────────────────────────────────────

/**
 * 把 LLM 产出的事实列表转成候选对象。
 *
 * 每条候选 id = `${jobId}:${index}`，默认 importance 5 / retention 'short' / state 'pending'。
 */
function factsToCandidates(jobId: string, facts: readonly string[]): DistillCandidate[] {
  return facts.map((fact, index) => ({
    id: `${jobId}:${index}`,
    fact,
    importance: 5,
    retention: 'short' as const,
    state: 'pending' as const,
  }))
}

// ── 公开 API ───────────────────────────────────────────────────────────────────

/**
 * 自动沉淀：压缩完成时提炼被压缩内容生成候选（不直接写记忆）。
 *
 * fire-and-forget：调用方不 await，内部异步执行，完成后 emit `corum/distill/completed`。
 * 不阻塞压缩流程。候选落盘持久化，用户可经 `distillListPending` / `distillCommit` 取舍。
 *
 * **跳过条件**（2026-11 新增）：`profile.memoryPolicy?.scope === 'none'` 时跳过
 * （chat 模式不产沉淀；判据同 {@link shouldSkipMemory}）。
 *
 * @param ctx - 承载 `llm` / `memory` / `sessionPersistence` 的上下文。
 * @param input - 压缩完成信息（sessionId / shadowedSeqs / summary）。
 */
export function autoDistillOnCompaction(ctx: Context, input: AutoDistillInput): void {
  const { sessionId, summary } = input
  if (summary.trim() === '') return
  // 记忆策略 scope==='none' 的 profile 跳过自动沉淀（chat 模式不产沉淀）。
  // 照 memory-recall.ts shouldSkipMemory 的同款判据读 profile.memoryPolicy?.scope。
  // 通过 sessionId → findSession → profileId → loadProfile 解析 profile
  // （与 isAutoDistillEnabled 读 settings scope 同属「创建前读配置决定是否跳过」的路径）。
  const sessionEntry = findSession(sessionId)
  if (sessionEntry !== undefined) {
    const profile = loadProfile(sessionEntry.profileId)
    if (profile?.memoryPolicy?.scope === 'none') return
  }
  const memory = ctx.get('memory' as never) as unknown as MemoryFace | undefined
  if (memory === undefined) return
  const jobId = newJobId()
  const source = `auto-compress:${sessionId}`
  const author = `agent:${sessionId}`
  // fire-and-forget：不 await，不阻塞压缩。
  void (async () => {
    try {
      // 先清除同来源的旧记忆（避免重复沉淀堆积）。
      await memory.deleteBySource(source)
      // 用压缩摘要作为提炼输入（比读 shadowedSeqs 对应的事件更高效）。
      const facts = await distillViaLlmSafe(ctx, summary)
      const candidates = factsToCandidates(jobId, facts)
      const job: DistillJob & PersistExtras = {
        jobId,
        status: 'done',
        factCount: candidates.length,
        phase: candidates.length > 0 ? `已产出 ${candidates.length} 条候选` : '无可沉淀内容',
        sessionId,
        ...(candidates.length === 0 ? {} : { candidates }),
        origin: 'auto',
        source,
        author,
      }
      distillJobs.set(jobId, job)
      distillJobStamps.set(jobId, Date.now())
      emitDistillCompleted(ctx, { jobId, sessionId, factCount: candidates.length })
      await persistJob(job)
    } catch {
      // 自动沉淀失败静默降级（不阻塞压缩、不弹错——用户没主动触发）。
    }
  })()
}

/**
 * 手动沉淀：对整棵会话树回放做沉淀。
 *
 * 异步 jobId 模式（照 artgen/ollama 的 start/status 拆分）：
 * - `distillStart` 调本函数，立即返回 `{ jobId }`。
 * - `distillStatus({ jobId })` 轮询进度/结果。
 * - `distillCancel({ jobId })` 取消。
 *
 * @param ctx - 承载 `llm` / `memory` / `sessionPersistence` 的上下文。
 * @param input - 手动沉淀入参（sessionId）。
 * @returns jobId。
 */
export function startManualDistill(ctx: Context, input: ManualDistillInput): { jobId: string } {
  // 防御校验（2026-11-19 BUG-5 同批）：RPC 层若把 sessionId 传成 undefined
  // （典型成因：wire 双层包装 `{input:{sessionId}}` → 服务端解出 undefined），
  // 旧实现在这里静默建 job、跑到 emit 才由 lossless 校验炸掉整个 job。
  // 现在入口即 fail-loud：抛可读错误，不建 job、不落盘、不 emit。
  assertSessionId(input?.sessionId, 'distillStart')
  const jobId = newJobId()
  const job: DistillJob & PersistExtras = {
    jobId,
    status: 'running',
    factCount: 0,
    phase: '初始化',
    sessionId: input.sessionId,
    origin: 'manual',
    source: `manual-distill:${input.sessionId}`,
    author: 'user',
  }
  distillJobs.set(jobId, job)
  // 新 job 尚无磁盘文件 ⇒ 用当前时刻作 stamp（此后 persistJob 写盘的 mtime
  // 一定更大，不会被误判为「磁盘没更新」）。见 distillJobStamps。
  distillJobStamps.set(jobId, Date.now())
  void runManualDistill(ctx, job, input)
  return { jobId }
}

/** 手动沉淀的异步执行体。 */
async function runManualDistill(ctx: Context, job: DistillJob & PersistExtras, input: ManualDistillInput): Promise<void> {
  const { sessionId } = input
  const memory = ctx.get('memory' as never) as unknown as MemoryFace | undefined
  if (memory === undefined) {
    job.status = 'error'
    job.error = '记忆服务不可用'
    job.phase = '失败'
    scheduleCleanup(job.jobId)
    await persistJob(job)
    return
  }
  try {
    const persistence = ctx.get('sessionPersistence' as never) as unknown as PersistenceFace | undefined
    if (persistence === undefined) {
      job.status = 'error'
      job.error = '会话持久化服务不可用'
      job.phase = '失败'
      scheduleCleanup(job.jobId)
      await persistJob(job)
      return
    }
    // 1. 枚举会话树。
    job.phase = '枚举会话树'
    // 2. 拉取所有 session 回放，合并内容。
    job.phase = `回放会话树`
    const contents: string[] = []
    for (const sid of await enumerateSessionTree(persistence, sessionId)) {
      if (job.status === 'cancelled') {
        scheduleCleanup(job.jobId)
        return
      }
      try {
        const events = await readPersistedEvents(persistence, sid)
        const text = eventsToText(events)
        if (text.trim() !== '') contents.push(text)
      } catch {
        // 单个会话读失败不中断（照 readPersistedEvents 容错）。
      }
    }
    if (contents.length === 0) {
      job.status = 'done'
      job.factCount = 0
      job.phase = '无可提炼内容'
      emitDistillCompleted(ctx, { jobId: job.jobId, sessionId, factCount: 0 })
      scheduleCleanup(job.jobId)
      await persistJob(job)
      return
    }
    // 3. 合并已自动沉淀内容（同来源旧记忆先清除，避免重复）。
    job.phase = '清除旧沉淀'
    await memory.deleteBySource(job.source)
    // 4. LLM 提炼。
    job.phase = 'AI 提炼中'
    const merged = contents.join('\n\n---\n\n')
    const facts = await distillViaLlmSafe(ctx, merged)
    if (job.status === 'cancelled') {
      scheduleCleanup(job.jobId)
      return
    }
    // 5. 生成候选（不直接写记忆——用户经 distillCommit 确认）。
    const candidates = factsToCandidates(job.jobId, facts)
    job.status = 'done'
    job.factCount = candidates.length
    job.phase = candidates.length > 0 ? `已产出 ${candidates.length} 条候选` : '无可沉淀内容'
    if (candidates.length > 0) job.candidates = candidates
    emitDistillCompleted(ctx, { jobId: job.jobId, sessionId, factCount: candidates.length })
  } catch (e) {
    job.status = 'error'
    job.error = e instanceof Error ? e.message : String(e)
    job.phase = '失败'
  } finally {
    scheduleCleanup(job.jobId)
    await persistJob(job)
  }
}

/**
 * 安全的 LLM 提炼调用：取模型路由（polish 配置 > 全局默认），失败抛错。
 */
async function distillViaLlmSafe(ctx: Context, content: string): Promise<readonly string[]> {
  const polishConfig = loadPolishConfig()
  const model: ProfileModel = polishConfig ?? globalDefaultModelOf(ctx)
  return distillViaLlm(ctx, model, content)
}

/**
 * 取全局默认模型路由（照 polish-service 的回落口径）。
 */
function globalDefaultModelOf(ctx: Context): ProfileModel {
  const sel = (ctx as unknown as { agentDefaultModel?: { currentSelection: () => ProfileModel } }).agentDefaultModel?.currentSelection()
  if (sel !== undefined) return sel
  throw new Error('未配置 AI 模型：请在「设置 → 扩展 → AI 润色」选择模型，或配置全局默认模型')
}

/**
 * 查询 distill 任务状态。
 *
 * 内存 Map 是热缓存；miss 时回读磁盘（getDistillJob miss → loadJobFromDisk）。
 * @param jobId - distillStart 返回的 jobId。
 * @returns 任务快照；内存和磁盘都找不到返回 null。
 */
export async function getDistillJob(jobId: string): Promise<DistillJob | null> {
  // BUG-6 修复：内存命中也要校验磁盘 mtime（resolveJob），否则磁盘被外部改写后
  // 本 RPC 与纯扫盘的 distillListPending 会对同一 job 给出两份不同快照。
  const job = await resolveJob(jobId)
  return job === null ? null : { ...job }
}

/**
 * 取消 distill 任务。
 * @param jobId - 要取消的任务 id。
 * @returns 是否成功标记为取消（任务不存在或已结束返回 false）。
 */
export function cancelDistillJob(jobId: string): boolean {
  const job = distillJobs.get(jobId)
  if (job === undefined) return false
  if (job.status !== 'running') return false
  job.status = 'cancelled'
  job.phase = '已取消'
  return true
}

// ── 候选取舍：commit / discard / replay / listPending ─────────────────────────

/** distillCommit 入参的单条编辑项（与 contract 同步）。 */
interface DistillCommitItem {
  id: string
  fact: string
  importance: number
  retention: 'temporary' | 'short' | 'long' | 'permanent'
}

/**
 * 确认写入候选经验：把用户确认（可编辑）的候选写入记忆底座。
 *
 * - 只写 `state==='pending'` 且 id 在 items 里的候选。
 * - 幂等：重复 commit 不重写（state 已是 committed 的跳过）。
 * - 用 items 里的编辑后值调 `memory.putFact`，source/agentId 用 job 存的，author 统一 'user'。
 * - 成功后候选 state='committed' 并落盘。
 * - 单条失败不中断（逐条 putFact 语义）。
 *
 * @param ctx - 承载 `memory` 服务的上下文。
 * @param input - jobId + 确认的 items。
 * @returns `{ written, failed }`。
 */
export async function distillCommit(
  ctx: Context,
  input: { jobId: string; items: readonly DistillCommitItem[] },
): Promise<{ written: number; failed: number }> {
  const job = await getDistillJobWithExtras(input.jobId)
  if (job === null || job.candidates === undefined) return { written: 0, failed: 0 }
  const memory = ctx.get('memory' as never) as unknown as MemoryFace | undefined
  if (memory === undefined) return { written: 0, failed: input.items.length }
  // 按 id 索引 items（用户编辑后的值）。
  const itemsById = new Map<string, DistillCommitItem>()
  for (const item of input.items) itemsById.set(item.id, item)
  let written = 0
  let failed = 0
  for (const candidate of job.candidates) {
    // 只处理 pending 且 id 在 items 里的。
    if (candidate.state !== 'pending') continue
    const item = itemsById.get(candidate.id)
    if (item === undefined) continue
    try {
      const result = await memory.putFact({
        fact: item.fact,
        importance: item.importance,
        source: job.source,
        ...(job.agentId === undefined ? {} : { agentId: job.agentId }),
        author: 'user',
        retention: item.retention,
      })
      if (result.rejected.length === 0) {
        candidate.state = 'committed'
        // 同步用户编辑后的值（fact/importance/retention 可能在确认时被改）。
        candidate.fact = item.fact
        candidate.importance = item.importance
        candidate.retention = item.retention
        written += 1
      } else {
        failed += 1
      }
    } catch {
      // 单条写入失败不中断后续（逐条 putFact 语义）。
      failed += 1
    }
  }
  await persistJob(job)
  return { written, failed }
}

/**
 * 丢弃候选经验：把候选标记为 discarded（不写入记忆）。
 *
 * - 不传 candidateIds = 全部 pending 候选。
 * - 置 state='discarded' 并落盘。
 *
 * @param input - jobId + 可选的 candidateIds。
 * @returns `{ discarded }` 被标记为 discarded 的条数。
 */
export async function distillDiscard(
  input: { jobId: string; candidateIds?: readonly string[] },
): Promise<{ discarded: number }> {
  const job = await getDistillJobWithExtras(input.jobId)
  if (job === null || job.candidates === undefined) return { discarded: 0 }
  const ids = input.candidateIds === undefined ? undefined : new Set(input.candidateIds)
  let discarded = 0
  for (const candidate of job.candidates) {
    if (candidate.state !== 'pending') continue
    if (ids !== undefined && !ids.has(candidate.id)) continue
    candidate.state = 'discarded'
    discarded += 1
  }
  if (discarded > 0) await persistJob(job)
  return { discarded }
}

/**
 * 回放会话消息：复用 readPersistedEvents + extractMessageText。
 *
 * 只取 user/assistant 非空文本，最多返回最近 500 条。读不到返回空数组不抛错。
 *
 * @param ctx - 承载 `sessionPersistence` 服务的上下文。
 * @param input - sessionId。
 * @returns `{ messages }`。
 */
export async function distillReplay(
  ctx: Context,
  input: { sessionId: string },
): Promise<{ messages: readonly { role: 'user' | 'assistant'; text: string; seq: number }[] }> {
  const persistence = ctx.get('sessionPersistence' as never) as unknown as PersistenceFace | undefined
  if (persistence === undefined) return { messages: [] }
  let events: readonly SessionEvent[]
  try {
    events = await readPersistedEvents(persistence, input.sessionId)
  } catch {
    return { messages: [] }
  }
  const messages: { role: 'user' | 'assistant'; text: string; seq: number }[] = []
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const text = extractMessageText(event.data)
    if (text.trim() === '') continue
    const role = event.type === 'user/message' ? 'user' as const : 'assistant' as const
    const seq = typeof event.seq === 'number' ? event.seq : 0
    messages.push({ role, text, seq })
  }
  // 最近 500 条（按 seq 降序取后反转回升序——保留最后 500 条）。
  const recent = messages.length > 500 ? messages.slice(-500) : messages
  return { messages: recent }
}

/**
 * 列出含 pending 候选的沉淀任务（从磁盘恢复）。
 *
 * 扫磁盘 job 文件，返回含至少一条 pending 候选的 job（新→旧，上限 20）。
 * 注意：此函数扫磁盘，调用方应缓存结果而非高频调用。
 *
 * @returns `{ jobs }`。
 */
export async function distillListPending(): Promise<{ jobs: readonly DistillJob[] }> {
  const all = await listAllJobsFromDisk()
  const withPending = all.filter(
    job => job.candidates !== undefined && job.candidates.some(c => c.state === 'pending'),
  )
  // 新→旧：按 jobId 里的时间戳降序（jobId 形如 `distill-<ts>-<rand>`）。
  withPending.sort((a, b) => b.jobId.localeCompare(a.jobId))
  return { jobs: withPending.slice(0, 20) }
}

/**
 * 内部：取 job（含 source/author/agentId 扩展字段）——内存优先，miss 回读磁盘。
 * commit/discard 需要扩展字段，故不能只用返回 DistillJob 的 getDistillJob。
 */
async function getDistillJobWithExtras(jobId: string): Promise<(DistillJob & PersistExtras) | null> {
  // 与 getDistillJob 同一入口（resolveJob），commit/discard 不得看到与
  // distillStatus 不同的快照（BUG-6：同 job 多 RPC 口径必须一致）。
  return resolveJob(jobId)
}

// ── 辅助：事件 → 文本 ─────────────────────────────────────────────────────────

/**
 * 把会话事件列表转成可读文本（供 LLM 提炼）。
 *
 * 只取 user/message 和 assistant/message 的文本内容（工具调用/系统事件不提取）。
 */
function eventsToText(events: readonly SessionEvent[]): string {
  const lines: string[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = extractMessageText(event.data)
      if (text !== '') lines.push(`用户: ${text}`)
    } else if (event.type === 'assistant/message') {
      const text = extractMessageText(event.data)
      if (text !== '') lines.push(`助手: ${text}`)
    }
  }
  return lines.join('\n')
}

/**
 * 从消息事件 data 里提取文本内容。
 */
function extractMessageText(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const content = (data as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text: string } =>
        typeof block === 'object' && block !== null
        && (block as { type?: string }).type === 'text'
        && typeof (block as { text?: string }).text === 'string')
      .map(block => block.text)
      .join('')
  }
  return ''
}

// ── 事件发射 ───────────────────────────────────────────────────────────────────

/** distill 完成事件的载荷（emit 通道，通知桥用）。 */
export interface DistillCompletedEvent {
  readonly jobId: string
  readonly sessionId: string
  readonly factCount: number
}

/**
 * 校验事件载荷：三字段必须都是合法 JSON 值（jobId / sessionId 非空字符串，
 * factCount 有限数字）。
 *
 * 动因（2026-11-19）：旧实现直接 emit，非法值（典型成因：wire 双层包装让
 * sessionId 成 undefined）会一路穿到 remote 层的 lossless 序列化校验才抛错，
 * 抛在以 `void runManualDistill(...)` 启动的异步体里 ⇒ 连 finally 都过不去，
 * job 永久 running。现在 emit 前就地拦下，跳过 emit + console.warn，job 本身
 * 照常落盘（状态可为 done/error），不让一条通知把任务炸掉。
 *
 * @param payload - 待发的事件载荷。
 * @returns 合法返回 true；非法返回 false（调用方跳过 emit）。
 */
export function isDistillCompletedPayloadValid(payload: unknown): payload is DistillCompletedEvent {
  if (payload === null || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  if (typeof p.jobId !== 'string' || p.jobId.trim() === '') return false
  if (typeof p.sessionId !== 'string' || p.sessionId.trim() === '') return false
  if (typeof p.factCount !== 'number' || !Number.isFinite(p.factCount)) return false
  return true
}

/**
 * 发射 `corum/distill/completed` 事件。
 *
 * 走 `as never` 收窄：`corum/distill/completed` 的 Events 声明在 fork 包
 * `@corum/corum-api-remotes`，本插件不 import 它的运行时声明面（避免「两份模块
 * 实例」红线，与 corum/subagent/progress 同款手法）。
 *
 * 载荷非法时**跳过 emit** 并 console.warn（不把 lossless 校验当兜底——它抛在
 * 异步体里会炸掉整个 job，见 {@link isDistillCompletedPayloadValid}）。
 */
function emitDistillCompleted(ctx: Context, payload: DistillCompletedEvent): void {
  if (!isDistillCompletedPayloadValid(payload)) {
    console.warn(
      '[corum-agent] 跳过 corum/distill/completed emit（载荷非法，避免 lossless 校验炸掉 job）:',
      payload,
    )
    return
  }
  (ctx.emit as never as (event: string, data: unknown) => void)('corum/distill/completed', payload)
}
