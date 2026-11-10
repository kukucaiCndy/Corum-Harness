/**
 * fork（corum）2026-10-28：**动态用户预设注册**（0.2.1-rc.3 preset 专项 §4.5(c)）。
 *
 * rc3 的 `agent-preset-registry` 不扫描目录——preset 定义只能来自 bundle patch 的
 * `dsh-agent-preset` 行。corum 的用户自建 Agent（`~/.corum/.agent-presets/<id>/`）
 * 不在 bundle patch 里，故必须显式调 `ctx.agentPresets.register()` 把它们注册进
 * registry，否则设置页的新建 Agent 不会出现在 `ctx.agentPresets.list()` 里。
 *
 * ## 机制
 *
 * 1. 读 `<home>/.agent-presets/<id>/agent.cordis.yml`（由 `profile-compiler.ts`
 *    在保存/编译时落盘）与 `<id>/preset.yml`（元数据）；
 * 2. 算**内容指纹**（两份文件原文的 sha256，见 {@link readPresetSource}）；
 * 3. 指纹与上次注册的相同 ⇒ **不动 registry**（0 次注册）；不同才
 *    dispose 旧定义 + `register()` 新定义；
 * 4. 解析为 entry list，前置 `entryListProblem` 校验（从 registry 包值导入）。
 *
 * ## 自愈（2026-11-01 P1）
 *
 * 旧实现的三个缺陷（都被本轮修掉，测试逐条锁住）：
 *
 * ① **只认「显式调用」**：preset 文件在进程外被改（重新编译、模块安装、手工编辑），
 *    registry 里的定义不会跟着变 ⇒ 设置页看到的还是旧组合。现在
 *    `refreshChanged()` 在 `listProfiles/createAgent/createAgentForTask` 等入口
 *    （`presetRegistrationReady()` 之后）扫盘比对指纹，变了才重挂。
 * ② **重挂无条件先 dispose**：解析失败/非原子写（半份 YAML）时旧定义被删、新定义
 *    注册不上 ⇒ preset 直接在 registry 里消失。现在**解析先于 dispose**：
 *    读失败（ENOENT / EACCES）、解析失败、校验失败一律**保留旧注册**，只 warn。
 * ③ **瞬时 mount 失败没有第二次机会**：register 失败后该 preset 就永久坏了。现在
 *    同一内容指纹最多自动重试 {@link MAX_AUTO_RETRIES} 次（内容变化重置预算），
 *    预算用尽后仍坏则保持 broken，由显式 `retryPreset` Remote 兜底（磁盘未变的
 *    瞬时失败无法用「内容变化」表达）。
 *
 * ## 「挂上了」怎么判定（2026-11-01 验收纠正，别退回只看 resolve）
 *
 * 上游 `register()` 对 **mount 失败不 reject**：`activate()` 把异常 `catch` 住写进
 * `record.broken`，`register()` 照常返回 disposer。所以「resolve 了」只说明定义**进了
 * registry**（`list()` 会带 `broken`），**不说明能挂**。本模块因此在 resolve 之后用
 * 上游公开的 `resolve(id)` 复核本次 id 的诊断：
 *
 * | 实际形态 | status | 记账 |
 * |---|---|---|
 * | resolve + 无 broken | `registered` | `mounted = 指纹`（真挂上） |
 * | resolve + 有 broken（上游 mount 失败） | `mount-broken` | `mounted = undefined`，预算 +1 |
 * | reject（Duplicate id / 空 id 等） | `mount-failed` | `mounted = undefined`，预算 +1 |
 * | 服务没有 `resolve` 面（老版本/窄 mock） | `registered` | 复核降级为「无法判断」⇒ 按挂上记 |
 *
 * 「保持 broken」= 定义留在 registry（`list()` 带 broken，UI 看得见）但记账不认为
 * 已挂载：同一内容最多再自动重试 1 次，之后只能靠内容变化或显式 `retryPreset`。
 *
 * 指纹用**原文 sha256**而不是 mtime：mtime 精度/时钟回拨会让「刚写完就 refresh」
 * 漏挂，而内容相同（比如只 touch 了一下）也不该白重挂一次。
 *
 * ## 并发
 *
 * 每条 preset 一条**串行队列**（{@link PresetRegistrationState} 的 `queues`）：
 * `Promise.all` 并发调 `registerUserPreset` 时同一 id 的 dispose/register 不会交错，
 * 否则 registry 的 `Duplicate agent preset` 会在「两个调用都判定要重挂」时炸。
 *
 * ## 错误策略
 *
 * 单个坏用户 preset **不拖垮全部**：解析失败/校验失败/注册失败的 preset 只进
 * warn 日志（带 preset id 和原因 + `error.code` 分类），其余照常注册。这与官方
 * registry 的行为一致——activation 失败的 preset 仍留在 registry 里、`list()` 返回它
 * 并带 `broken` 诊断（本模块的「保持 broken」指的就是不再自动重试）。
 *
 * ## 何时调用
 *
 * - 服务启动时（constructor 后、list/mount/select 前）一次性注册全部已有用户 preset；
 * - 保存/编译/删除 preset 后由 agent-service 调 `registerUserPreset(id)` /
 *   `unregisterUserPreset(id)` 同步 registry；
 * - 每次 list/create/task-create 入口经 `refreshChanged()` 自愈扫盘；
 * - 显式 `retryPreset` Remote（`retryPreset(id)`）处理磁盘未变的瞬时 mount 失败。
 *
 * ## 服务生命周期
 *
 * `registerAllUserPresets` 返回一个 Promise（`ready`），在 registry 服务
 * inject 可用后 await 完成。agent-service 持有此 `ready` 并在所有 list/mount/
 * select/create 任务相关入口 await 同一 ready，避免重复注册前读到空列表。
 *
 * ## disposer 所有权
 *
 * disposer / 指纹簿 / 队列三张表由 {@link PresetRegistrationState} 实例持有（由
 * corum-agent 服务实例拥有），随 `ctx.effect` dispose 清理。不用模块级可变 Map
 * （AGENTS 红线 1：跨 bundle shared state 必须是 cordis service）。
 *
 * @module @corum/corum-agent/preset-registration
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parse as parseYaml } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import { entryListProblem } from '@deepseek-ai/dsh-agent-preset-registry'
import { isValidProfileId } from './profile.ts'
import { listProfiles } from './profile-store.ts'

/**
 * fork（corum）2026-11-11：**`!!js` 方言** —— 用户 preset 的 `agent.cordis.yml` 是
 * 官方 entry-list 方言写的（`disabled: !!js process.platform === 'win32'`、
 * `cwd: !!js process.env.DSH_CWD ?? process.cwd()`）。本模块原先用裸 `parseYaml`
 * 读回来，而 `!!js` 是 `tag:yaml.org,2002:js` 标签、裸解析器不认识 ⇒ 该节点降级成
 * **字符串**（日志里的 `TAG_RESOLVE_FAILED … Unresolved tag`）：
 *
 * · `disabled` 成了非空字符串 ⇒ **真值** ⇒ 这一行被当成 disabled；
 * · config 值成了 `"process.env.DSH_CWD ?? process.cwd()"` 字面量。
 *
 * 实测后果（会话 `corum-task-201d5795` / `corum-task-3eb0c476` / `corum-task-e4e9b1d1`，
 * :9333）：**每一个 corum 自建 Agent 都拿不到 shell** —— 工具目录里既没有 `bash`
 * 也没有 `pwsh`，模型只能退化成 write/read（用户口径：「标准模式没有 bash 是很离谱的
 * 一个 BUG」）；而官方 `standard` preset（走 bundle 的 `dsh-agent-preset` 行，由
 * app-boot 的同一方言读入）**有** bash。对照证据见
 * `tests/preset-js-expr-dialect.spec.ts` 头部。
 *
 * 修法：解析时挂上与官方**同一个** `!!js` 标签，产出 loader 认的表达式标记
 * `{ __jsExpr }`（`@deepseek-ai/cordis-plugin-loader` 的 `isJsExpr` 只判这个字段），
 * 由 loader 在**行激活时**求值 —— 与官方 patch / preset 完全同语义，本模块不 eval。
 */
const JS_EXPRESSION_TAG = 'tag:yaml.org,2002:js'

/** `yaml` 的自定义标签表：把 `!!js <expr>` 解成 loader 的表达式标记。 */
const JS_EXPRESSION_TAGS = [{
  tag: JS_EXPRESSION_TAG,
  resolve: (value: unknown): { __jsExpr: string } => ({ __jsExpr: String(value) }),
}]

/**
 * 按官方 entry-list 方言解析一份 `agent.cordis.yml` / `preset.yml` 原文。
 * @param text - 文件原文。
 * @returns 解析结果（`!!js` 标量已成为 `{ __jsExpr }` 标记，交给 loader 求值）。
 */
export function parsePresetYaml(text: string): unknown {
  return parseYaml(text, { customTags: JS_EXPRESSION_TAGS })
}

/** 组合文件（registry `register()` 的 `plugins` 来源）。 */
const AGENT_CORDIS_FILE = 'agent.cordis.yml'
/** 元数据文件（name/description/order）。 */
const PRESET_META_FILE = 'preset.yml'

/**
 * 同一内容指纹下允许的**自动**重试次数（首次尝试之外）。
 * 内容变化 ⇒ 指纹变 ⇒ 预算重置；显式 `retryPreset` 不受此限。
 */
const MAX_AUTO_RETRIES = 1

/** agent-presets 的存储根（= ~/.corum/.agent-presets）。 */
function agentsRoot(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum'
  return join(resolveDshHome(configured), '.agent-presets')
}

/**
 * registry 服务上本模块用到的能力面（只登记用到的方法/字段）。
 */
export interface AgentPresetRegistryFace {
  /** 注册一个 preset 定义；返回 disposer。 */
  register: (definition: {
    readonly id: string
    readonly name?: string
    readonly description?: string
    readonly order?: number
    readonly plugins: readonly unknown[]
  }) => Promise<() => Promise<void>>
  /**
   * 复核**一个**定义此刻是否真的可用（可选能力面；对应上游 `AgentPresetRegistry.resolve`）。
   *
   * 为什么非要有这一条：上游 `register()` 对 **mount 失败不 reject**。它的 `activate()`
   * 把 mount 异常 `catch` 住、写进 `record.broken = error.message`，然后 `register()`
   * 照常返回 disposer。也就是说「register resolve」只证明定义**进了 registry**，
   * 不证明它能挂——只看 resolve 就会把坏 preset 记成「已挂载」。
   *
   * 上游 `resolve(id)` 的实现是 `await record.ready` + `diagnostic(record)`：broken 的
   * 定义 O(1) 直接返回 `record.broken`，健康的定义跑一次 mount 树审计。这是**单条**
   * 定义的低成本读法；`list()` 会对**全部**定义各审计一遍（不合适在每轮 refresh 里用），
   * 而 `diagnostic()` 在类型上是 private（还要求内部 record，外部拿不到）。
   *
   * 服务未提供该方法（老版本/窄面 mock）⇒ 复核降级为「无法判断」，见
   * {@link readPresetBroken}。
   */
  resolve?: (id: string) => Promise<{ readonly id: string; readonly broken?: string }>
}

/**
 * 取 registry 能力面（服务未挂载 ⇒ undefined）。
 */
export function agentPresetRegistryFace(ctx: Context): AgentPresetRegistryFace | undefined {
  const service: unknown = ctx.get('agentPresets')
  if (service === undefined || service === null || typeof service !== 'object') return undefined
  const candidate = service as AgentPresetRegistryFace
  return typeof candidate.register === 'function' ? candidate : undefined
}

/** 一次同步的结果（`retryPreset` 的返回值，也是测试的观测面）。 */
export type PresetSyncStatus =
  /** 真挂上了（首次注册 / 内容变化 / 显式重试），且 registry 的诊断面确认可用。 */
  | 'registered'
  /** 内容指纹与已挂载定义相同 ⇒ 0 次注册（好 preset 反复 refresh 不重挂）。 */
  | 'unchanged'
  /** 同一指纹的自动重试预算已用尽 ⇒ 本次没有尝试（保持 broken，等显式 retry）。 */
  | 'budget-exhausted'
  /** `agent.cordis.yml` 不存在（ENOENT）⇒ 旧注册原样保留。 */
  | 'missing'
  /** 读文件失败（EACCES/EISDIR/…）⇒ 旧注册原样保留（可能是非原子写的瞬时窗口）。 */
  | 'read-error'
  /** 解析/校验失败 ⇒ 旧注册原样保留（绝不 dispose）。 */
  | 'invalid'
  /** preset id 不是合法 slug（拒绝路径穿越）。 */
  | 'invalid-id'
  /** registry 服务未挂载。 */
  | 'registry-unavailable'
  /** `register()` 抛错（旧定义已移除；同一指纹仍有一次自动重试）。 */
  | 'mount-failed'
  /**
   * `register()` **resolve 但定义是坏的**：上游把 mount 失败写进 `record.broken` 后
   * 正常返回 disposer ⇒ 定义留在 registry（`list()` 里带 broken），但**不算挂载成功**。
   * 与 `mount-failed` 共用同一套重试预算（同一内容最多自动重试 1 次）。
   */
  | 'mount-broken'

/** `preset.yml` 解析出的元数据（缺失/坏文件时全部缺省 = 空对象）。 */
export interface PresetMetadata {
  readonly name?: string
  readonly description?: string
  readonly order?: number
}

/**
 * 一次「读两份源文件 + 算指纹（+ 解析）」的结果。
 *
 * `invalid` 也带指纹：内容已变但解析不了时仍要记账，否则「同一份坏内容」会被
 * 每次 refresh 当成新内容反复解析/告警。
 */
type PresetRead =
  | { readonly kind: 'missing'; readonly detail: string }
  | { readonly kind: 'read-error'; readonly code: string; readonly detail: string }
  | { readonly kind: 'invalid'; readonly fingerprint: string; readonly detail: string }
  | {
    readonly kind: 'ready'
    readonly fingerprint: string
    readonly plugins: readonly unknown[]
    readonly metadata: PresetMetadata
  }

/** 一个 preset 的注册记账。 */
interface PresetStamp {
  /** 最近一次**成功注册**的内容指纹（undefined = 当前没有本模块注册的定义）。 */
  readonly mounted: string | undefined
  /** 最近一次**尝试挂载**的内容指纹 + 该指纹下已消耗的自动重试次数。 */
  readonly attempt: { readonly fingerprint: string; readonly retryUsed: number } | undefined
}

/** 取 `error.code`（Node 的 fs/registry 错误都带）；无则 `UNKNOWN`。 */
function errorCode(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return 'UNKNOWN'
}

/** 日志用的错误描述：带 `code` 分类 + message。 */
function describeError(error: unknown): string {
  const code = errorCode(error)
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return code === 'UNKNOWN' ? detail : `[${code}] ${detail}`
}

/** 一个 preset 的两份源文件的绝对路径（id 已校验为 slug，不含路径分隔符）。 */
function presetFiles(id: string): { readonly cordis: string; readonly meta: string } {
  const dir = join(agentsRoot(), id)
  return { cordis: join(dir, AGENT_CORDIS_FILE), meta: join(dir, PRESET_META_FILE) }
}

/**
 * 复核刚注册的定义**是否真的可用**：返回 `broken` 诊断文案（undefined = 可用）。
 *
 * 上游 `register()` 对 mount 失败**不 reject**——它把异常塞进 `record.broken` 后照常
 * 返回 disposer。所以「register resolve」必须再复核一次，否则坏 preset 会被记成
 * 「已挂载」，而「同 stamp mount 失败自动重试 1 次」对真实 broken 永远不触发。
 *
 * 复核手段是上游公开的 `resolve(id)`（broken ⇒ O(1) 返回 `record.broken`；健康 ⇒
 * 一次 mount 树审计，只 await 已有 fiber、不 import 模块，故便宜），单条定义、不进
 * `list()` 的全量审计路径。
 *
 * ⚠️ 上游 `diagnostic()` 的注释警告「别在 Host 行自身的激活里调用」（扫到 pending 行
 * 时会 `await loader.await()`）。本模块的调用点都不在激活的等待链上：RPC 入口
 * （list/create）在 boot 之后，`registerAllUserPresets` 是构造器里的 fire-and-forget
 * （激活不等它），保存后的重注册也是 fire-and-forget。
 *
 * @param face - registry 能力面。
 * @param id - 刚注册的 preset id。
 * @param ctx - 宿主上下文（warn 日志）。
 * @returns `broken` 文案；undefined = 可用，**或**该服务没有复核面（无法判断）。
 */
async function readPresetBroken(
  face: AgentPresetRegistryFace,
  id: string,
  ctx: Context,
): Promise<string | undefined> {
  const resolve = face.resolve
  if (typeof resolve !== 'function') return undefined
  try {
    const resolved = await resolve.call(face, id)
    return resolved.broken
  } catch (error: unknown) {
    // 复核本身失败不能反推「坏」（那会把健康 preset 误标 broken，害它被反复重挂）。
    // 只记日志：此时按「register 已 resolve，无坏诊断」处理。
    ctx.logger.warn(`corum-agent: preset "${id}" registered but its diagnostic could not be read: ${describeError(error)}`)
    return undefined
  }
}

/**
 * 解析 `preset.yml` 的元数据。坏文件**不致命**：warn 后按空元数据注册
 * （旧行为保持；指纹仍含原文，故修好后会被判为「内容变化」重挂）。
 */
function parseMetadata(raw: Buffer | undefined, id: string, ctx: Context): PresetMetadata {
  if (raw === undefined) return {}
  try {
    const parsed = parsePresetYaml(raw.toString('utf8')) as { name?: unknown; description?: unknown; order?: unknown } | null
    if (parsed === null || typeof parsed !== 'object') {
      ctx.logger.warn(`corum-agent: preset "${id}" preset.yml parsed to non-object (${typeof parsed}) — using empty metadata`)
      return {}
    }
    return {
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
      ...(typeof parsed.order === 'number' ? { order: parsed.order } : {}),
    }
  } catch (error: unknown) {
    ctx.logger.warn(`corum-agent: preset "${id}" preset.yml parse failed: ${describeError(error)} — using empty metadata`)
    return {}
  }
}

/**
 * 读一个 preset 的两份源文件、算内容指纹、解析出 `plugins` 与元数据。
 *
 * **指纹** = `sha256(agent.cordis.yml 原文 ‖ preset.yml 原文或「缺席」标记)`。
 * 刻意不用 mtime：mtime 精度/时钟回拨会漏掉「刚写完立刻 refresh」，而内容没变
 * （touch 一下）也不该白重挂一次。
 *
 * **顺序很关键**：解析在返回结果里一次做完，调用方拿到 `ready` 才 dispose 旧定义——
 * 于是「读/解析失败 ⇒ 旧注册不动」是结构性保证，而不是靠调用方记得先解析。
 *
 * @param id - preset id（调用方已校验 slug）。
 * @param ctx - 宿主上下文（warn 日志）。
 */
function readPresetSource(id: string, ctx: Context): PresetRead {
  const files = presetFiles(id)
  let cordisRaw: Buffer
  try {
    cordisRaw = readFileSync(files.cordis)
  } catch (error: unknown) {
    const code = errorCode(error)
    if (code === 'ENOENT') return { kind: 'missing', detail: `${AGENT_CORDIS_FILE} not found` }
    return {
      kind: 'read-error',
      code,
      detail: `${AGENT_CORDIS_FILE} read failed: ${describeError(error)}`,
    }
  }
  let metaRaw: Buffer | undefined
  try {
    metaRaw = readFileSync(files.meta)
  } catch (error: unknown) {
    const code = errorCode(error)
    if (code !== 'ENOENT') {
      return {
        kind: 'read-error',
        code,
        detail: `${PRESET_META_FILE} read failed: ${describeError(error)}`,
      }
    }
  }
  const hash = createHash('sha256')
  hash.update(AGENT_CORDIS_FILE)
  hash.update('\0')
  hash.update(cordisRaw)
  hash.update('\0')
  hash.update(PRESET_META_FILE)
  hash.update('\0')
  if (metaRaw === undefined) {
    hash.update('absent')
  } else {
    hash.update('present\0')
    hash.update(metaRaw)
  }
  const fingerprint = hash.digest('hex')

  let plugins: unknown[]
  try {
    // `!!js` 必须按官方方言解成 `{ __jsExpr }`，否则 `disabled: !!js …` 会变成
    // 非空字符串（真值）⇒ 整行被判 disabled ⇒ 每个 corum 自建 Agent 都丢 shell。
    // 详见文件顶部 JS_EXPRESSION_TAGS 的说明与 tests/preset-js-expr-dialect.spec.ts。
    const parsed = parsePresetYaml(cordisRaw.toString('utf8'))
    if (!Array.isArray(parsed)) {
      return {
        kind: 'invalid',
        fingerprint,
        detail: `${AGENT_CORDIS_FILE} parsed to non-array (${typeof parsed})`,
      }
    }
    plugins = parsed
  } catch (error: unknown) {
    return {
      kind: 'invalid',
      fingerprint,
      detail: `${AGENT_CORDIS_FILE} parse failed: ${describeError(error)}`,
    }
  }
  const problem = entryListProblem(plugins)
  if (problem !== undefined) {
    return { kind: 'invalid', fingerprint, detail: `entry list rejected: ${problem}` }
  }
  return { kind: 'ready', fingerprint, plugins, metadata: parseMetadata(metaRaw, id, ctx) }
}

/**
 * 已注册的用户 preset id → disposer 的持有者（外加指纹簿与单 id 串行队列）。
 *
 * 由 {@link CorumAgentService} 实例拥有（通过 `new PresetRegistrationState(ctx)`
 * 在构造器里创建），随 `ctx.effect` dispose 清理。不用模块级可变 Map
 * （AGENTS 红线 1）。HMR 重载会重建 service 实例 ⇒ 新 state，旧 disposer
 * 随旧 service 的 effect dispose 清理，不会残留。
 */
export class PresetRegistrationState {
  /** 已注册的用户 preset id → disposer。用于更新/删除时先 dispose 旧定义。 */
  private readonly disposers = new Map<string, () => Promise<void>>()
  /** 已注册/已尝试 preset id → 内容指纹 + 自动重试预算（自愈的「上次看到什么」）。 */
  private readonly stamps = new Map<string, PresetStamp>()
  /** 单 id 串行队列的尾指针（同一 preset 的 dispose/register 不并发交错）。 */
  private readonly queues = new Map<string, Promise<void>>()
  /**
   * 启动注册的 ready Promise。在 `registerAllUserPresets` 调用时赋值，
   * 在所有 list/mount/select/create 任务相关入口 await。
   */
  private readyPromise: Promise<void> | undefined

  constructor(private readonly ctx: Context) {
    // 随 ctx dispose 清理所有 disposer（HMR 重载 / 服务销毁时）。
    ctx.effect(() => () => {
      // 收集所有 disposer 的清理 Promise，确保 context 销毁时等待完成。
      const disposePromises: Promise<void>[] = []
      for (const [id, disposer] of this.disposers) {
        const p = Promise.resolve(disposer()).catch(error => {
          this.ctx.logger.warn(`corum-agent: preset disposer failed for "${id}": ${String(error)}`)
        })
        disposePromises.push(p)
      }
      this.disposers.clear()
      // 指纹簿与队列一并清掉：旧实例的记账对下一个实例毫无意义（generation 不泄漏）。
      this.stamps.clear()
      this.queues.clear()
      // 返回 Promise.all 的 then-chain 使 effect 等待所有 disposer 完成。
      void Promise.all(disposePromises)
    }, 'corum-agent: preset registration disposers')
  }

  /** 启动注册的 ready Promise（undefined = 尚未启动注册）。 */
  get ready(): Promise<void> | undefined { return this.readyPromise }

  /**
   * 当前登记了 disposer 的 preset id 快照（诊断/测试：验证无 generation 泄漏）。
   *
   * ⚠️ 含 `mount-broken` 的 id：定义确实进了 registry（`list()` 带 broken），disposer
   * 留着是为了重挂前能撤掉它。判断「真的挂上了」看状态/`registerUserPreset` 返回值，
   * 不要看这个表。
   */
  get registeredIds(): readonly string[] { return [...this.disposers.keys()] }

  /**
   * 单 id 串行队列：把一次 dispose/register 排到该 preset 已排队的活后面。
   *
   * 为什么必须串行：`Promise.all` 并发调 `registerUserPreset('x')` 时，两个调用可能
   * 同时判定「内容变了要重挂」⇒ 都先 dispose 再 register ⇒ 第二个 register 撞
   * registry 的 `Duplicate agent preset` 而抛错。
   *
   * 队列尾在 settle 后自动出表（`queues` 不随调用次数增长）。
   */
  private enqueue(id: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.then(task, task)
    // 尾指针吞掉失败：前一个任务的异常不该阻断后一个任务。
    const tail = next.then(() => undefined, () => undefined)
    this.queues.set(id, tail)
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id)
    })
    return next
  }

  /**
   * 同步**一个**用户 preset 到 registry（内容未变则 0 次注册）。
   *
   * @param id - preset id（= profile id）。
   * @returns true = 真的挂上了（本次注册且诊断无 broken，或内容未变且上次是好的）；
   *   false = 跳过/失败（文件缺失、读失败、解析失败、mount reject、mount 后仍 broken、
   *   id 非法）。**broken 定义仍在 registry 里**（`list()` 可见），只是不算成功。
   */
  async registerUserPreset(id: string): Promise<boolean> {
    const status = await this.syncPreset(id, false)
    return status === 'registered' || status === 'unchanged'
  }

  /**
   * 显式重挂一个用户 preset（`retryPreset` Remote 的实现面）。
   *
   * 用途：磁盘内容**没变**、但上次 mount 是瞬时失败（registry 刚起、模块加载抖动）
   * ——这种情况「内容变化」永远不会发生，自动自愈没有入口，只能靠用户/UI 显式重试。
   *
   * 与自动路径的差别只有两条：① 忽略「内容未变 ⇒ 不动」的快路径（真的重新 dispose +
   * register）；② 不受自动重试预算限制。输入校验（slug，拒绝路径穿越）与单 id 串行
   * 与自动路径完全一致。
   */
  async retryPreset(id: string): Promise<PresetSyncStatus> {
    return this.syncPreset(id, true)
  }

  /**
   * 注销一个用户 preset（从 registry 移除）。
   *
   * @param id - preset id。
   */
  async unregisterUserPreset(id: string): Promise<void> {
    if (!isValidProfileId(id)) {
      this.ctx.logger.warn(`corum-agent: refusing to unregister preset id "${id}" — not a valid profile slug`)
      return
    }
    await this.enqueue(id, async () => {
      const disposer = this.disposers.get(id)
      // 记账一并清掉：删除后同名目录若又出现，应当被当成「新 preset」重新挂。
      this.disposers.delete(id)
      this.stamps.delete(id)
      if (disposer === undefined) return
      try { await disposer() } catch (error: unknown) {
        this.ctx.logger.warn(`corum-agent: disposer failed during unregister of preset "${id}": ${describeError(error)}`)
      }
    })
  }

  /**
   * 启动时一次性注册全部已有用户 preset。
   *
   * 遍历 `~/.corum/.agent-presets/` 下有 `agent.cordis.yml` 的子目录，逐个注册。
   * 单个坏 preset 不拖垮全部（catch 后继续下一个，warn 带 id 和原因）。
   *
   * 返回的 Promise 也赋值给 `readyPromise`，供 agent-service 的入口 await。
   * 注意：注册成功即写指纹，故**首次** `refreshChanged()` 不会全量重挂。
   */
  async registerAllUserPresets(): Promise<void> {
    const run = this.doRegisterAll()
    this.readyPromise = run
    return run
  }

  private async doRegisterAll(): Promise<void> {
    const face = agentPresetRegistryFace(this.ctx)
    if (face === undefined) return
    await this.refreshPresets()
  }

  /**
   * **自愈扫盘**：比对每个用户 preset 的内容指纹，把变了的重挂、变坏的不动旧注册、
   * 瞬时失败的自动重试一次。供 list/create 等入口在 `presetRegistrationReady()`
   * 之后调用（agent-service 侧接线）。
   *
   * 幂等且便宜：内容没变时每个 preset 只有两次 `readFileSync` + 一次 sha256，
   * registry 一次都不碰。
   */
  async refreshChanged(): Promise<void> {
    const face = agentPresetRegistryFace(this.ctx)
    if (face === undefined) return
    await this.refreshPresets()
  }

  private async refreshPresets(): Promise<void> {
    let profiles: ReturnType<typeof listProfiles>
    try {
      profiles = listProfiles()
    } catch (error: unknown) {
      this.ctx.logger.warn(`corum-agent: preset refresh could not list profiles: ${describeError(error)}`)
      return
    }
    for (const profile of profiles) {
      try {
        await this.registerUserPreset(profile.id)
      } catch (error: unknown) {
        this.ctx.logger.warn(`corum-agent: preset registration failed for "${profile.id}": ${describeError(error)}`)
      }
    }
  }

  /** 校验 id + 排队执行 {@link syncNow}。 */
  private async syncPreset(id: string, force: boolean): Promise<PresetSyncStatus> {
    // 路径穿越护栏：id 直接拼进 join(agentsRoot(), id)，非 slug 的 id（含 `../`）一律拒绝。
    if (!isValidProfileId(id)) {
      this.ctx.logger.warn(`corum-agent: refusing preset id "${id}" — not a valid profile slug`)
      return 'invalid-id'
    }
    let status: PresetSyncStatus = 'registry-unavailable'
    try {
      await this.enqueue(id, async () => {
        status = await this.syncNow(id, force)
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`corum-agent: preset sync for "${id}" threw: ${describeError(error)}`)
      return 'mount-failed'
    }
    return status
  }

  /**
   * 一次同步的全部判断（**已在单 id 队列里**，不会与同 id 的其它同步交错）。
   *
   * 判断顺序（顺序本身是语义，别重排）：
   *   1. 读盘失败（ENOENT/读错）⇒ 什么都不动，旧注册保留；
   *   2. 解析/校验失败 ⇒ 只记账，**不 dispose**（旧定义继续可用）；
   *   3. 内容指纹 == 已挂载指纹且非显式重试 ⇒ 0 次注册；
   *   4. 同一指纹的自动重试预算用尽 ⇒ 不再尝试（保持 broken）；
   *   5. 否则 dispose 旧定义 + register。
   */
  private async syncNow(id: string, force: boolean): Promise<PresetSyncStatus> {
    const face = agentPresetRegistryFace(this.ctx)
    if (face === undefined) return 'registry-unavailable'
    const read = readPresetSource(id, this.ctx)
    const previous = this.stamps.get(id)

    if (read.kind === 'missing') {
      // ENOENT 可能是「删了一半」「还没写完」——**不删旧注册**，也不改记账。
      return 'missing'
    }
    if (read.kind === 'read-error') {
      this.ctx.logger.warn(`corum-agent: preset "${id}" read failed (code ${read.code}) — keeping previous registration: ${read.detail}`)
      return 'read-error'
    }

    const fingerprint = read.fingerprint
    const attempt = previous?.attempt
    const sameAttempt = attempt !== undefined && attempt.fingerprint === fingerprint
    const retryUsed = attempt !== undefined && sameAttempt ? attempt.retryUsed : 0

    if (read.kind === 'invalid') {
      // 解析/校验失败：记账（指纹已变，避免同一份坏内容反复解析），但**绝不 dispose**。
      this.stamps.set(id, { mounted: previous?.mounted, attempt: { fingerprint, retryUsed } })
      this.ctx.logger.warn(`corum-agent: preset "${id}" ${read.detail} — keeping previous registration`)
      return 'invalid'
    }

    // 内容未变且已挂着：0 次注册（好 preset 反复 refresh 不重挂、不泄漏 generation）。
    if (!force && previous?.mounted === fingerprint) {
      this.stamps.set(id, { mounted: fingerprint, attempt: { fingerprint, retryUsed: 0 } })
      return 'unchanged'
    }
    // 同一指纹 mount 失败过且预算用尽：这次不试（显式 retryPreset 才能再试）。
    if (!force && sameAttempt && retryUsed >= MAX_AUTO_RETRIES) {
      return 'budget-exhausted'
    }

    // 走到这里 = 真的要挂：先 dispose 旧定义（registry 对重复 id 会抛 Duplicate）。
    const oldDisposer = this.disposers.get(id)
    if (oldDisposer !== undefined) {
      this.disposers.delete(id)
      try { await oldDisposer() } catch (error: unknown) {
        this.ctx.logger.warn(`corum-agent: disposer for old preset "${id}" failed during re-register: ${describeError(error)}`)
      }
    }
    try {
      const disposer = await face.register({
        id,
        ...read.metadata,
        plugins: read.plugins,
      })
      // 定义确实进了 registry ⇒ disposer 必须留（重挂/注销前得先撤掉它，否则
      // register 会撞 Duplicate）。注意：**「进了 registry」不等于「挂上了」**。
      this.disposers.set(id, disposer)
      // 上游 mount 失败不 reject（`activate()` 把异常写进 `record.broken` 后正常返回），
      // 故 resolve 之后必须复核本次 id 的诊断——否则坏 preset 会被记成「已挂载」，
      // 「同 stamp 自动重试 1 次」对真实 broken 永不触发（只剩内容变化/显式 retry）。
      const broken = await readPresetBroken(face, id, this.ctx)
      if (broken !== undefined) {
        // 仍坏：定义留在 registry（`list()` 带 broken，UI 能看见），但**不写挂载成功假象**。
        // 预算与 reject 路径同一套：同一内容最多再自动重试一次；显式重试失败即用尽。
        const spentOnBroken = force ? MAX_AUTO_RETRIES : (sameAttempt ? retryUsed + 1 : 0)
        this.stamps.set(id, { mounted: undefined, attempt: { fingerprint, retryUsed: spentOnBroken } })
        this.ctx.logger.warn(`corum-agent: preset "${id}" registered but broken (mount failed): ${broken}`)
        return 'mount-broken'
      }
      this.stamps.set(id, { mounted: fingerprint, attempt: { fingerprint, retryUsed: 0 } })
      return 'registered'
    } catch (error: unknown) {
      // register **抛错**（Duplicate id / 空 id / 声明不可注册等）：旧定义已被 dispose
      // 移除，新定义未注册——该 preset 在 registry 里消失。
      // 记账写「未挂载 + 预算」：同一内容最多自动重试一次；显式重试失败即视为预算用尽，
      // 避免「用户点了重试 ⇒ 下一次 list 又自动补一枪」的意外。
      const spentOnFailure = force ? MAX_AUTO_RETRIES : (sameAttempt ? retryUsed + 1 : 0)
      this.stamps.set(id, { mounted: undefined, attempt: { fingerprint, retryUsed: spentOnFailure } })
      // warn 显式说明旧定义已移除，不伪成功。
      this.ctx.logger.warn(`corum-agent: failed to register preset "${id}" (old definition was removed): ${describeError(error)}`)
      return 'mount-failed'
    }
  }
}
