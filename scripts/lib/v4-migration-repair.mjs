/**
 * v4-migration-repair.mjs —— V2→V3→V4 迁移预处理修复模块。
 *
 * 在临时副本的压缩 jsonl 文件上执行**仅预处理修复**，不修改官方迁移包。
 * 修复分为三类，均基于官方 rc3 的诚实修复语义：
 *
 *   1. **FORK_DESCRIPTOR_FIELDS** — v2/v0 会话的 `subagent/descriptor` 携带 fork
 *      扩展字段 `kind`/`personaHint`/`confined`，官方 v2→v3 迁移器的
 *      `assertReleasedV0Keys` 不接受这些字段。剥离它们安全：这些字段仅用于
 *      cold-resume 时重放角色契约，当前旧会话仅历史展示，不重启旧 activation。
 *      逐字段记录值与是否同构（官方字段优先映射，fork 专属字段剥离）。
 *
 *   2. **V0_DESCRIPTOR_VERSION** — v0 会话的 `subagent/descriptor` version=2，
 *      rc3 要求 version=3。v3 仅新增可选 `agentReasoningEffort`，v2 one-shot
 *      descriptor 只有 base keys (version/mode/provider/label)，结构同构。
 *      仅改 version 值；若同时含 fork 扩展字段，一并剥离。
 *
 *   3. **UNRESOLVED_TOOL_CALLS** — v3 会话的 step/end 后有未关闭的工具调用。
 *      用官方 `ToolCallRecovery` 的 `results()` 格式合成 `tool/result` 事件
 *      (isError:true, TOOL_OUTCOME_UNKNOWN)，插入到 step/end 之前。
 *      不伪造成功；严格保留 source seq 与 canonical repair 要求。
 *
 *   4. **QUARANTINE** — turn/start 结构损坏的会话不手术修复，标记隔离。
 *      单会话失败不阻塞其他全部。
 *
 * ## 安全约束
 *
 * - 只作用于临时副本的压缩 jsonl 文件。
 * - 绝不修改源 `~/.corum`。
 * - 不修改官方迁移包（rc3）。
 * - 每个修复记录 before/after hash、修复类型/数量。
 * - `--repair` 显式启用，默认只读。
 *
 * @module scripts/lib/v4-migration-repair
 */

import { createHash } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

// ── 常量 ──────────────────────────────────────────────────────────────

const ZSTD_MAGIC = 4247762216
const ZSTD_C_CHECKSUM_FLAG = 201

/** fork 扩展字段——官方 schema 不接受，剥离安全（仅 cold-resume 用）。 */
const FORK_DESCRIPTOR_FIELDS = ['kind', 'personaHint', 'confined']

/** 判断值是否为普通对象（非数组、非 null）。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 官方 v3 descriptor 允许的字段（不含 fork 扩展）。 */
const OFFICIAL_DESCRIPTOR_KEYS = new Set([
  'version', 'mode', 'provider', 'label',
  'agentProvider', 'agentModel', 'agentReasoningEffort', 'persona', 'toolFilter',
])

/** 修复类型分类。 */
export const RepairType = {
  FORK_DESCRIPTOR_FIELDS: 'FORK_DESCRIPTOR_FIELDS',
  V0_DESCRIPTOR_VERSION: 'V0_DESCRIPTOR_VERSION',
  UNRESOLVED_TOOL_CALLS: 'UNRESOLVED_TOOL_CALLS',
  QUARANTINE: 'QUARANTINE',
}

// ── zstd 帧扫描与编解码 ────────────────────────────────────────────────

/**
 * 扫描 concat-frame zstd 缓冲区的完整帧边界。
 * 直接复刻官方 `scanZstdFrames`（worker.cjs:13141）的逻辑，保证帧边界精确。
 * @param {Buffer} buffer - concat-frame zstd 缓冲区。
 * @returns {{ start: number, end: number }[]} 完整帧范围列表。
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) break
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) break
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * 解码 concat-frame zstd 文件为 JSON 事件数组。
 * 每帧独立解压，帧内可能含多行 JSONL。
 * @param {string} filePath - .jsonl.zstd 文件路径。
 * @returns {Promise<object[]>} 解析后的事件数组（按 seq 排序）。
 */
export async function decodeSessionFile(filePath) {
  const buf = await readFile(filePath)
  const frames = scanZstdFrames(buf)
  const events = []
  for (const frame of frames) {
    const dec = zstdDecompressSync(buf.subarray(frame.start, frame.end))
    const text = dec.toString('utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) events.push(JSON.parse(trimmed))
    }
  }
  return events
}

/**
 * 将事件数组重新编码为 concat-frame zstd 文件。
 * 每行 JSON 独立压缩为一个带 checksum 的 zstd 帧。
 * @param {string} filePath - 目标 .jsonl.zstd 文件路径。
 * @param {object[]} events - 事件数组。
 */
export async function encodeSessionFile(filePath, events) {
  const chunks = []
  for (const event of events) {
    const line = JSON.stringify(event) + '\n'
    const frame = zstdCompressSync(Buffer.from(line, 'utf8'), {
      params: { [ZSTD_C_CHECKSUM_FLAG]: 1 },
    })
    chunks.push(frame)
  }
  await writeFile(filePath, Buffer.concat(chunks))
}

// ── 修复逻辑 ──────────────────────────────────────────────────────────

/**
 * 计算文件 sha256。
 * @param {string} filePath - 文件路径。
 * @returns {Promise<string>} hex 摘要。
 */
export async function sha256File(filePath) {
  const buf = await readFile(filePath)
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 从事件数组中找到所有 `subagent/descriptor` 事件。
 * @param {object[]} events - 事件数组。
 * @returns {object[]} descriptor 事件列表。
 */
function findDescriptorEvents(events) {
  return events.filter((e) => e.type === 'subagent/descriptor')
}

/**
 * 剥离 fork 扩展字段（kind/personaHint/confined），记录每字段值。
 * @param {object} descriptorData - descriptor 事件的 data 对象。
 * @returns {{ stripped: object, isomorphic: boolean }} 剥离的字段值 + 是否同构。
 */
function stripForkDescriptorFields(descriptorData) {
  const stripped = {}
  let isomorphic = true
  for (const field of FORK_DESCRIPTOR_FIELDS) {
    if (Object.hasOwn(descriptorData, field)) {
      stripped[field] = descriptorData[field]
      // 判断是否同构：fork 专属字段无法映射到官方字段，故不同构
      isomorphic = false
    }
  }
  return { stripped, isomorphic }
}

/**
 * 修复单个 descriptor 事件的 data：
 * - 剥离 fork 扩展字段（kind/personaHint/confined）
 * - 若 version=2，改为 version=3（仅当结构同构时）
 * @param {object} descriptorData - descriptor 事件的 data。
 * @param {string} fileVersion - 文件版本（'v0'|'v2'）。
 * @returns {{ repaired: object, changes: object[] } | null} 修复后的 data + 变更记录，或 null（无需修复）。
 */
function repairDescriptor(descriptorData, fileVersion) {
  const changes = []
  const repaired = { ...descriptorData }

  // 剥离 fork 扩展字段
  const { stripped, isomorphic } = stripForkDescriptorFields(descriptorData)
  for (const field of FORK_DESCRIPTOR_FIELDS) {
    if (Object.hasOwn(repaired, field)) {
      delete repaired[field]
      changes.push({
        type: 'strip-field',
        field,
        value: stripped[field],
        isomorphic,
        reason: 'fork 扩展字段，官方 v2→v3 schema 不接受；仅 cold-resume 用，当前旧会话仅历史展示',
      })
    }
  }

  // v0 descriptor version 2→3
  if (fileVersion === 'v0' && repaired.version === 2) {
    // v3 仅新增可选 agentReasoningEffort；v2 one-shot 只有 base keys，结构同构
    const hasOnlyOfficialKeys = Object.keys(repaired).every((k) => OFFICIAL_DESCRIPTOR_KEYS.has(k))
    if (hasOnlyOfficialKeys) {
      repaired.version = 3
      changes.push({
        type: 'version-bump',
        from: 2,
        to: 3,
        isomorphic: true,
        reason: 'v3 仅新增可选 agentReasoningEffort，v2 one-shot base keys 结构同构',
      })
    } else {
      // 有无法映射的字段——quarantine
      changes.push({
        type: 'version-bump-blocked',
        from: 2,
        to: 3,
        isomorphic: false,
        reason: '含无法映射到官方 schema 的字段，结构不同构',
      })
      return null
    }
  }

  return changes.length > 0 ? { repaired, changes } : null
}

/**
 * 修复未关闭的工具调用：在 step/end 之前插入合成的 tool/result。
 *
 * 使用官方 ToolCallRecovery 的 results() 格式合成 isError:true 的结果。
 * 对于 started 的 tool call（有 tool/call 记录），使用 TOOL_OUTCOME_UNKNOWN。
 * 对于 not-started 的（只有 assistant/message 广告），使用 TOOL_NOT_STARTED + canonical repair 格式。
 *
 * @param {object[]} events - 事件数组。
 * @returns {{ repairedEvents: object[], changes: object[] } | null} 修复后的事件 + 变更记录，或 null（无法修复）。
 */
function repairUnresolvedToolCalls(events) {
  // 跟踪每个 step 中未关闭的 tool calls
  const tools = new Map() // callId -> { turn, step, callSeq, started, name, arguments }
  let openStep = null
  let openTurn = null
  const insertions = [] // { beforeSeq: number, events: object[] }

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        tools.clear()
        break
      case 'turn/end':
        // turn/end 也调用 closeTools，但通常 step/end 已先关闭
        if (tools.size > 0) {
          // 在 turn/end 之前插入 tool/result
          const synthEvents = synthesizeToolResults(tools, event.seq, event.time)
          insertions.push({ beforeSeq: event.seq, events: synthEvents })
          tools.clear()
        }
        openTurn = null
        openStep = null
        break
      case 'step/start':
        openStep = event.data.step
        tools.clear()
        break
      case 'step/end':
        if (tools.size > 0) {
          // 在 step/end 之前插入 tool/result
          const synthEvents = synthesizeToolResults(tools, event.seq, event.time)
          insertions.push({ beforeSeq: event.seq, events: synthEvents })
          tools.clear()
        }
        openStep = null
        break
      case 'assistant/message': {
        const content = event.data?.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool-call') {
              tools.set(block.id, {
                turn: event.data.turn,
                step: event.data.step,
                callSeq: undefined, // not yet started
                started: false,
                name: block.name,
                arguments: block.arguments,
              })
            }
          }
        }
        break
      }
      case 'tool/call': {
        const entry = tools.get(event.data.callId)
        if (entry) {
          entry.callSeq = event.seq
          entry.started = true
        }
        break
      }
      case 'tool/result': {
        // v3 格式：callId 在 message.source.callId（非 message.toolCallId）
        // v3→v4 迁移器在 transform 时把 source.callId 转成 message.toolCallId
        const source = event.data?.message?.source
        const callId = (isRecord(source) ? source.callId : undefined) ?? event.data?.message?.toolCallId ?? event.data?.callId
        if (callId) tools.delete(callId)
        break
      }
      default:
        break
    }
  }

  if (insertions.length === 0) return null

  // 按 beforeSeq 升序排列，逐个插入
  insertions.sort((a, b) => a.beforeSeq - b.beforeSeq)

  // 构建新事件数组，在指定 seq 前插入合成事件
  // 注意：插入后需要重新编号 seq（官方迁移器在 v3→v4 转换时会重新编号）
  // 但 v2→v3 的迁移器要求 source events dense from 0
  // 我们在原始 seq 空间插入，让迁移器处理重编号
  const repairedEvents = []
  let seqOffset = 0
  for (const event of events) {
    // 检查是否需要在当前 event 前插入
    while (insertions.length > 0 && insertions[0].beforeSeq === event.seq) {
      const insertion = insertions.shift()
      for (const synthEvent of insertion.events) {
        // 使用负 seq 或小数 seq 避免冲突——不行，seq 必须是整数
        // 实际上 v2/v3 jsonl 中 seq 是从 0 开始的密集整数
        // 我们需要在原始事件之间插入，这会打乱 seq 连续性
        // 解决方案：重新编号整个事件流
        repairedEvents.push(synthEvent)
      }
    }
    repairedEvents.push(event)
  }

  // 重新编号 seq（从 0 开始密集）
  // header 事件（type=session）没有 seq 字段，跳过
  let nextSeq = 0
  const hasHeader = repairedEvents[0]?.type === 'session'
  for (let i = 0; i < repairedEvents.length; i++) {
    if (repairedEvents[i].type === 'session') continue
    repairedEvents[i].seq = nextSeq++
  }

  const changes = insertions.map((ins) => ({
    type: 'synthesize-tool-result',
    beforeSeq: ins.beforeSeq,
    count: ins.events.length,
    toolCalls: ins.events.map((e) => ({
      callId: e.data.message.source?.callId,
      started: e.data.error?.code === 'TOOL_OUTCOME_UNKNOWN',
    })),
  }))

  return { repairedEvents, changes }
}

/**
 * 合成 tool/result 事件，使用官方 ToolCallRecovery.results() 的精确格式。
 *
 * 合成事件使用 **v3 格式**（修复发生在 v3→v4 迁移之前）：
 * - message.source.callId = callId（v3 格式，非 v4 的 message.toolCallId）
 * - message.content = [{type: "tool-result", toolCallId, content: [{type:"text", text}]}]
 * - message.isError = true
 * - data.error = {name, code}（TOOL_OUTCOME_UNKNOWN 或 TOOL_NOT_STARTED）
 * - sourceEventSeqs: [callSeq]（对于 started call）
 *
 * v3→v4 迁移器会在 transform 时把 source.callId 转成 message.toolCallId。
 *
 * @param {Map<string, object>} tools - 未关闭的 tool calls。
 * @param {number} beforeSeq - 插入位置的 seq。
 * @param {number} time - 时间戳。
 * @returns {object[]} 合成的 tool/result 事件。
 */
function synthesizeToolResults(tools, beforeSeq, time) {
  const results = []
  let seq = beforeSeq
  for (const [callId, info] of tools) {
    const started = info.started
    const text = started
      ? 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'
      : 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.'
    // v3 格式：role="user" + tool-result wrapper（v3→v4 liftToolResult 会转成 role="tool" + 平面 content）
    // isError 在 wrapper 上（v3 验证要求 content[0].isError=true；liftToolResult 从 wrapper 提取到 message）
    const message = {
      id: `interrupted-tool-result-${callId}-${seq}`,
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        isError: true,
        content: [{ type: 'text', text }],
      }],
    }
    results.push({
      type: 'tool/result',
      seq,
      time,
      data: {
        turn: info.turn,
        step: info.step,
        message,
        error: started
          ? { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' }
          : { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
      },
      surfaceOp: 'append',
      ...(started && info.callSeq !== undefined ? { sourceEventSeqs: [info.callSeq] } : {}),
    })
    seq++
  }
  return results
}

// ── 主修复入口 ────────────────────────────────────────────────────────

/**
 * 检测一个 session 文件需要哪种修复。
 * @param {object[]} events - 解码后的事件数组。
 * @returns {{ types: string[], details: object }} 修复类型列表 + 详情。
 */
export function detectRepairNeeds(events) {
  const types = []
  const details = {
    forkDescriptors: [],
    v0DescriptorVersion: [],
    unresolvedToolCalls: [],
    quarantine: [],
  }

  // 检查 descriptor 问题
  const descriptors = findDescriptorEvents(events)
  const header = events.find((e) => e.type === 'session')
  const fileVersion = header?.version === 0 ? 'v0' : header?.version === 2 ? 'v2' : header?.version === 3 ? 'v3' : 'unknown'

  for (const desc of descriptors) {
    const data = desc.data
    // fork 扩展字段
    const forkFields = FORK_DESCRIPTOR_FIELDS.filter((f) => Object.hasOwn(data, f))
    if (forkFields.length > 0) {
      types.push(RepairType.FORK_DESCRIPTOR_FIELDS)
      details.forkDescriptors.push({
        seq: desc.seq,
        fields: forkFields.map((f) => ({ field: f, value: data[f] })),
      })
    }
    // v0 descriptor version 2
    if (fileVersion === 'v0' && data.version === 2) {
      types.push(RepairType.V0_DESCRIPTOR_VERSION)
      details.v0DescriptorVersion.push({
        seq: desc.seq,
        currentVersion: 2,
        targetVersion: 3,
      })
    }
  }

  // 检查未关闭的工具调用
  const tools = new Map()
  let openStep = null
  let openTurn = null
  let hasUnresolved = false
  for (const event of events) {
    switch (event.type) {
      case 'turn/start': openTurn = event.data.turn; openStep = null; tools.clear(); break
      case 'turn/end':
        if (tools.size > 0) {
          hasUnresolved = true
          details.unresolvedToolCalls.push({
            atSeq: event.seq,
            turn: openTurn,
            callIds: [...tools.keys()],
          })
        }
        openTurn = null; openStep = null; tools.clear()
        break
      case 'step/start': openStep = event.data.step; tools.clear(); break
      case 'step/end':
        if (tools.size > 0) {
          hasUnresolved = true
          details.unresolvedToolCalls.push({
            atSeq: event.seq,
            turn: openTurn,
            step: openStep,
            callIds: [...tools.keys()],
          })
        }
        openStep = null; tools.clear()
        break
      case 'assistant/message': {
        const content = event.data?.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool-call') {
              tools.set(block.id, { started: false, callSeq: undefined })
            }
          }
        }
        break
      }
      case 'tool/call': {
        const entry = tools.get(event.data.callId)
        if (entry) { entry.started = true; entry.callSeq = event.seq }
        break
      }
      case 'tool/result': {
        // v3 格式：callId 在 message.source.callId（非 message.toolCallId）
        // v3→v4 迁移器在 transform 时把 source.callId 转成 message.toolCallId
        const source = event.data?.message?.source
        const callId = (isRecord(source) ? source.callId : undefined) ?? event.data?.message?.toolCallId ?? event.data?.callId
        if (callId) tools.delete(callId)
        break
      }
      default: break
    }
  }
  if (hasUnresolved) types.push(RepairType.UNRESOLVED_TOOL_CALLS)

  // 检查 turn/start 结构损坏（quarantine）
  // 通过检测是否有未关闭的 turn 后直接开始新 turn（且无 nextTurnSpliced）
  let currentTurn = null
  let stepOpen = false
  let nextTurnSpliced = false
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (currentTurn !== null && !stepOpen && !nextTurnSpliced) {
        // turn 未关闭就开新 turn，且非 splice 重启——结构损坏
        types.push(RepairType.QUARANTINE)
        details.quarantine.push({
          atSeq: event.seq,
          reason: 'turn/start does not open the expected turn (previous turn not closed, no splice restart)',
          openTurn: currentTurn,
          newTurn: event.data.turn,
        })
      }
      currentTurn = event.data.turn
      stepOpen = false
      nextTurnSpliced = false
    } else if (event.type === 'turn/end') {
      currentTurn = null
      stepOpen = false
      nextTurnSpliced = false
    } else if (event.type === 'step/start') {
      stepOpen = true
    } else if (event.type === 'step/end') {
      stepOpen = false
    } else if (event.type === 'agent/inbox/spliced') {
      if (event.data?.target === 'next-turn' && Array.isArray(event.data?.inserted) && event.data.inserted.length > 0) {
        nextTurnSpliced = true
      }
    } else if (event.type !== 'agent/inbox/spliced') {
      // 非 splice 事件重置 splice 标记（与官方 observeRestart 一致）
      if (event.type !== 'turn/start') nextTurnSpliced = false
    }
  }

  return { types: [...new Set(types)], details }
}

/**
 * 对一个 session 文件执行修复。
 * @param {string} filePath - 临时副本中的 .jsonl.zstd 文件路径。
 * @returns {Promise<{ repaired: boolean, types: string[], changes: object[], beforeHash: string, afterHash: string }>}
 */
export async function repairSessionFile(filePath) {
  const beforeHash = await sha256File(filePath)
  const events = await decodeSessionFile(filePath)

  const { types: neededTypes, details } = detectRepairNeeds(events)

  if (neededTypes.length === 0) {
    return { repaired: false, types: [], changes: [], beforeHash, afterHash: beforeHash }
  }

  // quarantine 不修复
  if (neededTypes.includes(RepairType.QUARANTINE)) {
    return {
      repaired: false,
      types: [RepairType.QUARANTINE],
      changes: details.quarantine,
      beforeHash,
      afterHash: beforeHash,
      quarantined: true,
    }
  }

  let repairedEvents = events
  const allChanges = []

  // 1. 修复 descriptor（fork 字段剥离 + v0 version bump）
  if (neededTypes.includes(RepairType.FORK_DESCRIPTOR_FIELDS) || neededTypes.includes(RepairType.V0_DESCRIPTOR_VERSION)) {
    const header = repairedEvents.find((e) => e.type === 'session')
    const fileVersion = header?.version === 0 ? 'v0' : header?.version === 2 ? 'v2' : 'v2'
    const descChanges = []
    repairedEvents = repairedEvents.map((event) => {
      if (event.type !== 'subagent/descriptor') return event
      const result = repairDescriptor(event.data, fileVersion)
      if (result) {
        descChanges.push({ seq: event.seq, changes: result.changes })
        return { ...event, data: result.repaired }
      }
      return event
    })
    allChanges.push({ type: 'descriptor-repair', changes: descChanges })
  }

  // 2. 修复未关闭的工具调用
  if (neededTypes.includes(RepairType.UNRESOLVED_TOOL_CALLS)) {
    const result = repairUnresolvedToolCalls(repairedEvents)
    if (result) {
      repairedEvents = result.repairedEvents
      allChanges.push({ type: 'tool-call-repair', changes: result.changes })
    }
  }

  // 重新编码
  await encodeSessionFile(filePath, repairedEvents)
  const afterHash = await sha256File(filePath)

  return {
    repaired: true,
    types: neededTypes,
    changes: allChanges,
    beforeHash,
    afterHash,
  }
}

/**
 * 批量修复临时副本中的 session 文件。
 * @param {string[]} filePaths - 文件路径列表。
 * @returns {Promise<{ results: object[], summary: object }>}
 */
export async function repairSessions(filePaths) {
  const results = []
  const summary = {
    total: filePaths.length,
    repaired: 0,
    quarantined: 0,
    noRepairNeeded: 0,
    failed: 0,
    byType: {},
  }

  for (const filePath of filePaths) {
    try {
      const result = await repairSessionFile(filePath)
      results.push({ filePath, ...result })
      if (result.quarantined) {
        summary.quarantined++
      } else if (result.repaired) {
        summary.repaired++
      } else {
        summary.noRepairNeeded++
      }
      for (const type of result.types) {
        summary.byType[type] = (summary.byType[type] || 0) + 1
      }
    } catch (error) {
      results.push({ filePath, error: error.message, failed: true })
      summary.failed++
    }
  }

  return { results, summary }
}
