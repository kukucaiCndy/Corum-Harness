/**
 * The durable subagent-child descriptor: the versioned, model-hidden
 * `subagent/descriptor` session event that identifies every session-backed
 * subagent, including historical one-shot records. The manager appends each
 * continuable child's descriptor inside its initial turn, preserving the
 * declared composition required for cold resume.
 *
 * The descriptor deliberately snapshots explicit fields rather than the
 * merge-extensible `AgentOptions` object: an unrelated extension value cannot
 * make continuation fail merely because it is not JSON, and later composition
 * inputs require a deliberate {@link SUBAGENT_DESCRIPTOR_VERSION} change. It
 * omits `subagentDepth` — cold resume trusts the persisted header's
 * `delegationDepth` as the monotone floor — and `outputSchema`, which belongs
 * to one activation's result contract rather than durable child composition.
 * Per-activation knobs such as `maxTokens` are omitted for the same reason as
 * `outputSchema`: they budget one activation. Cold resume requires the exact
 * live parent for authorization but reconstructs child options only from the
 * durable descriptor, so it neither restores the prior budget nor inherits
 * the parent's current one; the resumed route's defaults apply instead.
 *
 * @module @deepseek-ai/dsh-subagent/descriptor
 */

import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { ChildKind } from './child-agent.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable identity and lifecycle mode of a session-backed subagent child,
     * appended once inside the child's initial turn, before its first
     * request. Continuable records also carry their
     * resumable composition. Log-only: it carries no `surfaceOp`, never enters
     * model history, and survives compaction.
     *
     * fork（corum）2026-10-28：fork 扩展字段（kind/personaHint/confined）不再写入
     * 官方 descriptor 事件——它们通过紧随其后的 `corum-subagent/descriptor`
     * 扩展事件（`ignorable: true`）持久化，官方 v4 admission 接受 ignorable 事件。
     * 旧会话（官方 descriptor 内含三字段）仍向后兼容读取。
     */
    'subagent/descriptor': SubagentDescriptorData
  }
}

// ── corum 扩展事件 ────────────────────────────────────────────────────

/**
 * corum 自有 session 扩展事件：保存 fork 专属的 descriptor 字段
 * （kind/personaHint/confined），不污染官方 `subagent/descriptor` schema。
 *
 * 事件类型为 `plugin:corum-subagent/descriptor`——符合官方 plugin record 语法
 * （`/^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u`），
 * 通过 `appendPluginRecord(session, type, data)` 写入，自动携带 `ignorable: true` 标记。
 * 官方 v4 admission 接受 ignorable 事件（`validateStoredEvents`：unknown type +
 * `ignorable===true` → 跳过不抛）。官方读取路径将其视为 opaque metadata，不解释 data 内容。
 *
 * 事件顺序：紧跟官方 `subagent/descriptor` 之后（seq 由 append 自动分配）。
 *
 * 向后兼容：旧会话的官方 descriptor 内含 kind/personaHint/confined 字段，
 * `foldSubagentDescriptor` 仍从官方 descriptor 读回这些字段——优先取扩展事件值，
 * 扩展事件不存在时回退到官方 descriptor 内的旧值。
 */
export const CORUM_SUBAGENT_DESCRIPTOR_EVENT_TYPE = 'plugin:corum-subagent/descriptor'
export const CORUM_SUBAGENT_DESCRIPTOR_VERSION = 1

/** corum 扩展 descriptor 事件的 data 载荷。 */
export interface CorumSubagentDescriptorData {
  /** corum 扩展事件格式版本。 */
  readonly version: number
  /** fork：子 Agent 种类——resume 时据此重放同一套角色契约。 */
  readonly kind?: ChildKind
  /** fork：主 Agent 注入的叠加层人格——resume 时一并还原。 */
  readonly personaHint?: string
  /** fork：隔离子会话的写边界门禁标记——不落盘则冷恢复丢防御层。 */
  readonly confined?: boolean
}

/** Inputs for the corum extension descriptor snapshot. */
export type CorumSubagentDescriptorInput = Omit<CorumSubagentDescriptorData, 'version'>

// 声明 corum 的 plugin record 类型到官方 PluginRecordMap，使 appendPluginRecord
// 的泛型约束接受 'plugin:corum-subagent/descriptor' 类型 + 关联 data 形状。
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:corum-subagent/descriptor': CorumSubagentDescriptorData
  }
}

/**
 * The current descriptor format version, stamped into every appended
 * `subagent/descriptor` event and required verbatim by {@link foldSubagentDescriptor}.
 * Supporting another composition input is a deliberate version change, never
 * an implicit extra field.
 */
export const SUBAGENT_DESCRIPTOR_VERSION = 3

/** Fields shared by every supported `subagent/descriptor` payload. */
interface SubagentDescriptorBase {
  /** Descriptor format version ({@link SUBAGENT_DESCRIPTOR_VERSION}). */
  readonly version: number
  /** Whether the child is a terminal one-shot run or a resumable conversation. */
  readonly mode: 'one-shot' | 'continuable'
  /** The `ctx.subagents` provider name that established the child. */
  readonly provider: string
}

/** A session-backed subagent that cannot be cold-resumed after its run. */
export interface OneShotSubagentDescriptorData extends SubagentDescriptorBase {
  readonly mode: 'one-shot'
  /**
   * The initial delegation's short `description`, kept as the child's durable
   * creation label so enumeration can identify the conversation without
   * replaying parent tool results or exposing the child prompt.
   */
  readonly label?: string
}

/** A session-backed subagent whose declared composition supports cold resume. */
export interface ContinuableSubagentDescriptorData extends SubagentDescriptorBase {
  readonly mode: 'continuable'
  /** The initial delegation's short `description`, used for durable enumeration. */
  readonly label: string
  /** Resolved child `agentOptions.provider`, when one was declared. */
  readonly agentProvider?: string
  /** Resolved child `agentOptions.model`, when one was declared. */
  readonly agentModel?: string
  /** Resolved child `agentOptions.reasoningEffort`, when one was declared. */
  readonly agentReasoningEffort?: ReasoningEffortId
  /** Per-child persona that shadows the deployment persona on resume. */
  readonly persona?: string
  /** fork（corum）：子 Agent 种类——resume 时据此重放同一套角色契约。 */
  readonly kind?: ChildKind
  /** fork（corum）：主 Agent 注入的叠加层人格——resume 时一并还原。 */
  readonly personaHint?: string
  /**
   * fork（corum）2026-09-22：隔离子会话的写边界门禁标记——必须 durable。
   * 不落盘则冷恢复丢防御层。
   */
  readonly confined?: boolean
  /** Child tool scoping reapplied on resume. */
  readonly toolFilter?: ToolRestriction
}

/** The supported durable subagent identity and optional continuation composition. */
export type SubagentDescriptorData =
  | OneShotSubagentDescriptorData
  | ContinuableSubagentDescriptorData

/** One-shot composition fields before the snapshot stamps their format version. */
export type OneShotSubagentDescriptorInput = Omit<OneShotSubagentDescriptorData, 'version'>

/** Continuable composition fields before the snapshot stamps their format version. */
export type ContinuableSubagentDescriptorInput = Omit<ContinuableSubagentDescriptorData, 'version'>

/** Inputs snapshotSubagentDescriptor validates and detaches. */
export type SubagentDescriptorInput = OneShotSubagentDescriptorInput | ContinuableSubagentDescriptorInput

const DESCRIPTOR_BASE_KEYS = [
  'version',
  'mode',
  'provider',
  'label',
] as const
const ONE_SHOT_DESCRIPTOR_KEYS = new Set(DESCRIPTOR_BASE_KEYS)
const CONTINUABLE_DESCRIPTOR_KEYS = new Set([
  ...DESCRIPTOR_BASE_KEYS,
  'agentProvider',
  'agentModel',
  'agentReasoningEffort',
  'persona',
  // fork（corum）2026-10-28：kind/personaHint/confined 已迁移到 corum 扩展事件
  // （corum-subagent/descriptor, ignorable:true）。此处保留是为了向后兼容
  // 旧会话（官方 descriptor 内含三字段）——parseSubagentDescriptor 仍读取它们。
  'kind',
  'personaHint',
  'confined',
  'toolFilter',
])
const TOOL_FILTER_KEYS = new Set(['allow', 'deny'])

/** corum 扩展事件允许的字段。 */
const CORUM_DESCRIPTOR_KEYS = new Set(['version', 'kind', 'personaHint', 'confined'])

/** Whether a persisted JSON value is an object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reject fields outside one versioned record's declared schema. */
function assertKnownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, path: string): void {
  const unknown = Object.keys(value).find(key => !keys.has(key))
  if (unknown !== undefined) {
    throw new Error(`persisted subagent descriptor ${path} has unknown field "${unknown}"`)
  }
}

/** Read one optional string field from a persisted descriptor record. */
function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(value, key)) return undefined
  const field = value[key]
  if (typeof field !== 'string') {
    throw new Error(`persisted subagent descriptor ${key} must be a string`)
  }
  return field
}

/** Read one optional string-array field from a persisted tool restriction. */
function optionalStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  if (!Object.hasOwn(value, key)) return undefined
  const field = value[key]
  if (!Array.isArray(field)) {
    throw new Error(`persisted subagent descriptor toolFilter.${key} must be an array of strings`)
  }
  const items: unknown[] = field
  if (items.some(item => typeof item !== 'string')) {
    throw new Error(`persisted subagent descriptor toolFilter.${key} must be an array of strings`)
  }
  return items as string[]
}

/** fork（corum）：Read one optional boolean field from a persisted descriptor record. */
function optionalBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(value, key)) return undefined
  const field = value[key]
  if (typeof field !== 'boolean') {
    throw new Error(`persisted subagent descriptor ${key} must be a boolean`)
  }
  return field
}

/** Validate and reconstruct a persisted tool restriction. */
function parseToolFilter(value: unknown): ToolRestriction {
  if (!isRecord(value)) {
    throw new Error('persisted subagent descriptor toolFilter must be an object')
  }
  assertKnownKeys(value, TOOL_FILTER_KEYS, 'toolFilter')
  const allow = optionalStringArray(value, 'allow')
  const deny = optionalStringArray(value, 'deny')
  if (allow === undefined && deny === undefined) {
    throw new Error('persisted subagent descriptor toolFilter must declare allow and/or deny')
  }
  return {
    ...allow !== undefined ? { allow } : {},
    ...deny !== undefined ? { deny } : {},
  }
}

/** Validate one persisted descriptor payload for the current runtime. */
function parseSubagentDescriptor(value: unknown): SubagentDescriptorData | undefined {
  if (!isRecord(value)) {
    throw new Error('persisted subagent descriptor payload must be an object')
  }
  const version = value['version']
  if (typeof version !== 'number') {
    throw new Error('persisted subagent descriptor version must be a number')
  }
  if (version !== SUBAGENT_DESCRIPTOR_VERSION) return undefined

  const mode = value['mode']
  if (mode !== 'one-shot' && mode !== 'continuable') {
    throw new Error('persisted subagent descriptor mode must be "one-shot" or "continuable"')
  }
  assertKnownKeys(
    value,
    mode === 'one-shot' ? ONE_SHOT_DESCRIPTOR_KEYS : CONTINUABLE_DESCRIPTOR_KEYS,
    'payload',
  )
  const provider = value['provider']
  if (typeof provider !== 'string') {
    throw new Error('persisted subagent descriptor provider must be a string')
  }
  if (mode === 'one-shot') {
    const label = optionalString(value, 'label')
    return {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode,
      provider,
      ...label !== undefined ? { label } : {},
    }
  }
  const label = value['label']
  if (typeof label !== 'string') {
    throw new Error('persisted subagent descriptor label must be a string')
  }
  const agentProvider = optionalString(value, 'agentProvider')
  const agentModel = optionalString(value, 'agentModel')
  const agentReasoningEffort = optionalString(value, 'agentReasoningEffort') as ReasoningEffortId | undefined
  const persona = optionalString(value, 'persona')
  // fork（corum）2026-09-20：种类与注入层同样从持久化描述符读回（否则 resume 后人格漂移）。
  const kind = optionalString(value, 'kind') as ChildKind | undefined
  const personaHint = optionalString(value, 'personaHint')
  // fork（corum）2026-09-22：隔离写边界标记（不落盘则冷恢复丢防御层）。
  const confined = optionalBoolean(value, 'confined')
  const toolFilter = Object.hasOwn(value, 'toolFilter')
    ? parseToolFilter(value['toolFilter'])
    : undefined
  return {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode,
    provider,
    label,
    ...agentProvider !== undefined ? { agentProvider } : {},
    ...agentModel !== undefined ? { agentModel } : {},
    ...agentReasoningEffort !== undefined ? { agentReasoningEffort } : {},
    ...persona !== undefined ? { persona } : {},
    ...kind !== undefined ? { kind } : {},
    ...personaHint !== undefined ? { personaHint } : {},
    ...confined !== undefined ? { confined } : {},
    ...toolFilter !== undefined ? { toolFilter } : {},
  }
}

/**
 * Validate and detach a one-shot descriptor input.
 * @param input - the caller-collected one-shot identity fields.
 * @returns the versioned, detached one-shot descriptor payload.
 * @throws when a field is not losslessly JSON-serializable.
 */
export function snapshotSubagentDescriptor(
  input: OneShotSubagentDescriptorInput,
): OneShotSubagentDescriptorData
/**
 * Validate and detach a continuable descriptor input.
 * @param input - the caller-collected continuable composition fields.
 * @returns the versioned, detached continuable descriptor payload.
 * @throws when a field is not losslessly JSON-serializable.
 */
export function snapshotSubagentDescriptor(
  input: ContinuableSubagentDescriptorInput,
): ContinuableSubagentDescriptorData
export function snapshotSubagentDescriptor(input: SubagentDescriptorInput): SubagentDescriptorData {
  const candidate: SubagentDescriptorData = input.mode === 'one-shot'
    ? {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: input.mode,
      provider: input.provider,
      ...input.label !== undefined ? { label: input.label } : {},
    }
    : {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: input.mode,
      provider: input.provider,
      label: input.label,
      ...input.agentProvider !== undefined ? { agentProvider: input.agentProvider } : {},
      ...input.agentModel !== undefined ? { agentModel: input.agentModel } : {},
      ...input.agentReasoningEffort !== undefined ? { agentReasoningEffort: input.agentReasoningEffort } : {},
      ...input.persona !== undefined ? { persona: input.persona } : {},
      ...input.toolFilter !== undefined ? { toolFilter: input.toolFilter } : {},
      // fork（corum）2026-10-28：kind/personaHint/confined 不再写入官方 descriptor。
      // 它们通过 corum-subagent/descriptor 扩展事件持久化（见 snapshotCorumSubagentDescriptor）。
      // ContinuableSubagentDescriptorInput 的 kind/personaHint/confined 字段仍存在
      // （向后兼容输入面），但新写路径忽略它们——用 snapshotCorumSubagentDescriptor。
    }
  const snapshot = snapshotJsonValue(candidate)
  if (snapshot === undefined) {
    throw new Error('subagent descriptor is not losslessly JSON-serializable')
  }
  return snapshot
}

/**
 * Fold a persisted child log to its supported descriptor. The first
 * `subagent/descriptor` event is authoritative — the establishing provider
 * appends exactly one, so a later same-type event cannot rewrite the declared
 * composition.
 *
 * fork（corum）2026-10-28：fold 合并官方 descriptor + corum 扩展事件。
 * 扩展事件（`corum-subagent/descriptor`, `ignorable:true`）携带 kind/personaHint/confined。
 * 旧会话的官方 descriptor 内含这些字段 → 向后兼容读取（扩展事件不存在时回退）。
 * 事件顺序以官方 descriptor 为权威；扩展不能覆盖官方 mode/provider/label。
 *
 * @param events - the loaded child session events.
 * @returns the descriptor, or `undefined` when the log has none or its
 *   version is not {@link SUBAGENT_DESCRIPTOR_VERSION} (the child cannot be
 *   classified by this runtime).
 * @throws when a current-version persisted payload does not match its complete
 *   declared schema.
 */
export function foldSubagentDescriptor(events: readonly SessionEvent[]): SubagentDescriptorData | undefined {
  const event = events.find(
    (candidate): candidate is SessionEvent<'subagent/descriptor'> => candidate.type === 'subagent/descriptor',
  )
  if (event === undefined) return undefined
  const baseDescriptor = parseSubagentDescriptor(event.data)
  if (baseDescriptor === undefined) return undefined

  // fork（corum）2026-10-28：合并 corum 扩展事件（corum-subagent/descriptor）
  const corumExt = parseCorumSubagentDescriptorFromEvents(events)
  if (corumExt === undefined) return baseDescriptor // 无扩展事件 → 旧会话或无 fork 字段

  // 合并：扩展事件的 kind/personaHint/confined 叠加到 baseDescriptor
  // （baseDescriptor 已可能含旧官方 descriptor 内的三字段——扩展事件优先）
  if (baseDescriptor.mode === 'continuable') {
    return {
      ...baseDescriptor,
      ...corumExt.kind !== undefined ? { kind: corumExt.kind } : {},
      ...corumExt.personaHint !== undefined ? { personaHint: corumExt.personaHint } : {},
      ...corumExt.confined !== undefined ? { confined: corumExt.confined } : {},
      // 旧官方 descriptor 内的三字段仍保留（如果扩展事件没覆盖）
      ...baseDescriptor.kind !== undefined && corumExt.kind === undefined ? { kind: baseDescriptor.kind } : {},
      ...baseDescriptor.personaHint !== undefined && corumExt.personaHint === undefined ? { personaHint: baseDescriptor.personaHint } : {},
      ...baseDescriptor.confined !== undefined && corumExt.confined === undefined ? { confined: baseDescriptor.confined } : {},
    }
  }
  return baseDescriptor
}

// ── corum 扩展事件 snapshot/parse/fold ────────────────────────────────

/**
 * Snapshot a corum extension descriptor input into a versioned, detached payload.
 * @param input - the fork-only fields (kind/personaHint/confined).
 * @returns the versioned, detached corum extension descriptor payload.
 * @throws when a field is not losslessly JSON-serializable.
 */
export function snapshotCorumSubagentDescriptor(input: CorumSubagentDescriptorInput): CorumSubagentDescriptorData {
  const candidate: CorumSubagentDescriptorData = {
    version: CORUM_SUBAGENT_DESCRIPTOR_VERSION,
    ...input.kind !== undefined ? { kind: input.kind } : {},
    ...input.personaHint !== undefined ? { personaHint: input.personaHint } : {},
    ...input.confined !== undefined ? { confined: input.confined } : {},
  }
  const snapshot = snapshotJsonValue(candidate)
  if (snapshot === undefined) {
    throw new Error('corum subagent descriptor is not losslessly JSON-serializable')
  }
  return snapshot
}

/**
 * Parse one persisted corum extension descriptor payload.
 * @param value - the raw `data` field of a `corum-subagent/descriptor` event.
 * @returns the parsed corum extension data, or `undefined` when the version
 *   is not {@link CORUM_SUBAGENT_DESCRIPTOR_VERSION}.
 * @throws when the payload shape is invalid.
 */
export function parseCorumSubagentDescriptor(value: unknown): CorumSubagentDescriptorData | undefined {
  if (!isRecord(value)) {
    throw new Error('persisted corum subagent descriptor payload must be an object')
  }
  const version = value['version']
  if (typeof version !== 'number') {
    throw new Error('persisted corum subagent descriptor version must be a number')
  }
  if (version !== CORUM_SUBAGENT_DESCRIPTOR_VERSION) return undefined
  assertKnownKeys(value, CORUM_DESCRIPTOR_KEYS, 'corum payload')
  const kind = optionalString(value, 'kind') as ChildKind | undefined
  const personaHint = optionalString(value, 'personaHint')
  const confined = optionalBoolean(value, 'confined')
  return {
    version: CORUM_SUBAGENT_DESCRIPTOR_VERSION,
    ...kind !== undefined ? { kind } : {},
    ...personaHint !== undefined ? { personaHint } : {},
    ...confined !== undefined ? { confined } : {},
  }
}

/**
 * Parse the first corum extension descriptor event from a child log.
 * @param events - the loaded child session events.
 * @returns the corum extension data, or `undefined` when the log has none.
 * @throws when a current-version corum payload does not match its schema.
 */
function parseCorumSubagentDescriptorFromEvents(events: readonly SessionEvent[]): CorumSubagentDescriptorData | undefined {
  // The corum extension event is a plugin record (`plugin:corum-subagent/descriptor`),
  // not a member of SessionEventMap, so its type string is outside SessionEvent.type's
  // known union. Cast to string for comparison.
  const event = events.find(
    (candidate) => (candidate.type as string) === CORUM_SUBAGENT_DESCRIPTOR_EVENT_TYPE,
  )
  if (event === undefined) return undefined
  return parseCorumSubagentDescriptor(event.data)
}

/**
 * Extract the fork-only fields (kind/personaHint/confined) from a descriptor
 * input, producing the corum extension input that should be persisted as a
 * separate `corum-subagent/descriptor` event.
 *
 * Returns `undefined` when none of the fork fields are present.
 */
export function extractCorumDescriptorInput(
  input: { kind?: ChildKind, personaHint?: string, confined?: boolean },
): CorumSubagentDescriptorInput | undefined {
  if (input.kind === undefined && input.personaHint === undefined && input.confined === undefined) {
    return undefined
  }
  return {
    ...input.kind !== undefined ? { kind: input.kind } : {},
    ...input.personaHint !== undefined ? { personaHint: input.personaHint } : {},
    ...input.confined !== undefined ? { confined: input.confined } : {},
  }
}
