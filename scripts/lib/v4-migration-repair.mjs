/**
 * v4-migration-repair.mjs —— V2→V3→V4 迁移预处理修复模块。
 *
 * 在临时副本的压缩 jsonl 文件上执行**仅预处理修复**，不修改官方迁移包。
 * 修复分为五类，均基于官方 rc3 的诚实修复语义：
 *
 *   1. **FORK_DESCRIPTOR_FIELDS** — v2/v0/v3 会话的 `subagent/descriptor` 携带 fork
 *      扩展字段 `kind`/`personaHint`/`confined`，官方 schema 不接受这些字段。
 *      代际裁决（brief §1）：
 *      - v0/v2：**只剥离，不插扩展**——官方 v2→v3 迁移器拒绝 unclassified 事件
 *        （RELEASED_V2_EVENT_DISPOSITIONS 不含 plugin:corum-subagent/descriptor），
 *        故 fork 字段值丢失但迁移能通过（低风险路径）。
 *      - v3：剥离后插入 `plugin:corum-subagent/descriptor` 扩展事件（`ignorable:true`），
 *        因为 assertV3Event 将未知 type 视为 opaque/ignorable；cold-resume 时
 *        foldSubagentDescriptor 合并官方 descriptor + corum 扩展事件恢复原值。
 *
 *   2. **V0_DESCRIPTOR_VERSION** — v0 会话的 `subagent/descriptor` version=2，
 *      rc3 要求 version=3。v3 仅新增可选 `agentReasoningEffort`，v2 one-shot
 *      descriptor 只有 base keys (version/mode/provider/label)，结构同构。
 *      仅改 version 值；若同时含 fork 扩展字段，一并剥离。
 *
 *   3. **TITLE_MESSAGE_SEQS** — v3 会话的 `session/title` messageSeqs 含非法引用
 *      （指向非 user/message、非人类 source、重复 seq、或 seq >= title.seq）。
 *      官方 v3→v4 titleSources 要求每个 seq 指向更早的 human user/message 事件。
 *      修复策略：只删引用、不移动事件、不重编号；user-title 的 messageSeqs 设空。
 *
 *   4. **UNRESOLVED_TOOL_CALLS** — v3 会话的 step/end 后有未关闭的工具调用。
 *      用官方 `ToolCallRecovery` 的 `results()` 格式合成 `tool/result` 事件
 *      (isError:true, TOOL_OUTCOME_UNKNOWN)，插入到 step/end 之前。
 *      不伪造成功；严格保留 source seq 与 canonical repair 要求。
 *
 *   5. **QUARANTINE** — turn/start 结构损坏的会话不手术修复，标记隔离。
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
  TITLE_MESSAGE_SEQS: 'TITLE_MESSAGE_SEQS',
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
        reason: 'fork 扩展字段，官方 v2→v3 schema 不接受；剥离后通过 plugin:corum-subagent/descriptor 扩展事件保留',
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

  // 构建审计 changes：必须在消费 insertions（shift）之前收集，
  // 否则对已空数组做 map 审计永远返回 []（确证 bug fix）。
  const changes = insertions.map((ins) => ({
    type: 'synthesize-tool-result',
    beforeSeq: ins.beforeSeq,
    count: ins.events.length,
    toolCalls: ins.events.map((e) => ({
      callId: e.data.message.source?.callId,
      started: e.data.error?.code === 'TOOL_OUTCOME_UNKNOWN',
    })),
  }))

  // 构建新事件数组，在指定 seq 前插入合成事件
  // 注意：插入后需要重新编号 seq（官方迁移器在 v3→v4 转换时会重新编号）
  // 但 v2→v3 的迁移器要求 source events dense from 0
  // 我们在原始 seq 空间插入，让迁移器处理重编号
  const repairedEvents = []
  for (const event of events) {
    // 检查是否需要在当前 event 前插入
    while (insertions.length > 0 && insertions[0].beforeSeq === event.seq) {
      const insertion = insertions.shift()
      for (const synthEvent of insertion.events) {
        repairedEvents.push(synthEvent)
      }
    }
    repairedEvents.push(event)
  }

  // 重新编号 seq（从 0 开始密集）
  // header 事件（type=session）没有 seq 字段，跳过
  let nextSeq = 0
  for (let i = 0; i < repairedEvents.length; i++) {
    if (repairedEvents[i].type === 'session') continue
    repairedEvents[i].seq = nextSeq++
  }

  // 断言审计完整性：changes 必须非空且每条有 callId/beforeSeq
  if (changes.length === 0) {
    throw new Error('repairUnresolvedToolCalls: changes audit is empty but insertions were non-empty — logic error')
  }
  for (const change of changes) {
    if (change.beforeSeq === undefined) {
      throw new Error('repairUnresolvedToolCalls: change missing beforeSeq')
    }
    for (const tc of change.toolCalls) {
      if (tc.callId === undefined) {
        throw new Error('repairUnresolvedToolCalls: toolCall missing callId in changes audit')
      }
      if (tc.started === undefined) {
        throw new Error('repairUnresolvedToolCalls: toolCall missing started flag in changes audit')
      }
    }
  }

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
    titleMessageSeqs: [],
    quarantine: [],
  }

  // 构建事件索引（seq -> event），用于 title messageSeqs 检测
  const eventBySeq = new Map()
  for (const e of events) {
    if (typeof e.seq === 'number') eventBySeq.set(e.seq, e)
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

  // 检查 session/title messageSeqs 非法引用
  // 官方 v3→v4 titleSources 要求：每个 seq 指向更早的 user/message 事件，
  // 且该 user/message 的 source.kind === "user"，且无重复。
  // 若 source.kind === "user" 则 messageSeqs 必须为空数组。
  for (const event of events) {
    if (event.type !== 'session/title') continue
    const data = event.data
    if (!isRecord(data)) continue
    const seqs = data.messageSeqs
    if (!Array.isArray(seqs)) continue
    const titleSeq = event.seq
    const source = data.source
    const titleSourceKind = isRecord(source) ? source.kind : undefined
    const seen = new Set()
    const invalidSeqs = []
    for (const seq of seqs) {
      if (typeof seq !== 'number') { invalidSeqs.push({ seq, reason: 'not-a-number' }); continue }
      if (seq >= titleSeq) { invalidSeqs.push({ seq, reason: 'not-earlier' }); continue }
      if (seen.has(seq)) { invalidSeqs.push({ seq, reason: 'duplicate' }); continue }
      seen.add(seq)
      const cited = eventBySeq.get(seq)
      if (!cited || cited.type !== 'user/message') {
        invalidSeqs.push({ seq, reason: 'not-user-message' })
        continue
      }
      const citedData = cited.data
      const citedSource = isRecord(citedData) ? citedData.source : undefined
      if (!isRecord(citedSource) || citedSource.kind !== 'user') {
        invalidSeqs.push({ seq, reason: 'not-human-source' })
        continue
      }
    }
    // 若 user-title 但 messageSeqs 非空，也需修复（清空）
    if (titleSourceKind === 'user' && seqs.length > 0) {
      invalidSeqs.push({ reason: 'user-title-must-have-empty-seqs', all: true })
    }
    if (invalidSeqs.length > 0) {
      types.push(RepairType.TITLE_MESSAGE_SEQS)
      details.titleMessageSeqs.push({
        seq: titleSeq,
        titleSourceKind,
        originalCount: seqs.length,
        invalidSeqs,
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
 * 修复 session/title 事件的 messageSeqs 非法引用。
 *
 * 官方 v3→v4 titleSources 要求：
 *   - 每个 seq 必须指向更早（seq < title.seq）的 user/message 事件
 *   - 该 user/message 的 data.source.kind === "user"（人类消息）
 *   - 无重复 seq
 *   - 若 title.source.kind === "user" 则 messageSeqs 必须为空数组
 *
 * 修复策略（brief §3）：
 *   - 只删引用、不移动事件、不重编号 seq
 *   - 过滤掉无效引用（not-earlier / not-user-message / not-human-source / duplicate）
 *   - 若 title.source.kind === "user"，messageSeqs 设为空数组（user title 不引用消息）
 *   - 若过滤后为空且 source.kind !== "user"，保留空数组（schema 允许）
 *   - 审计 before/after 引用，保留 title 文本和其他有效字段
 *
 * @param {object[]} events - 事件数组。
 * @param {object[]} titleIssues - detectRepairNeeds 返回的 titleMessageSeqs 详情。
 * @returns {{ repairedEvents: object[], changes: object[] } | null}
 */
function repairTitleMessageSeqs(events, titleIssues) {
  if (titleIssues.length === 0) return null

  // 构建事件索引
  const eventBySeq = new Map()
  for (const e of events) {
    if (typeof e.seq === 'number') eventBySeq.set(e.seq, e)
  }

  const changes = []
  const issueBySeq = new Map()
  for (const issue of titleIssues) {
    issueBySeq.set(issue.seq, issue)
  }

  const repairedEvents = events.map((event) => {
    if (event.type !== 'session/title') return event
    const issue = issueBySeq.get(event.seq)
    if (issue === undefined) return event

    const data = event.data
    const titleSourceKind = issue.titleSourceKind
    const originalSeqs = Array.isArray(data.messageSeqs) ? data.messageSeqs : []
    const originalCount = originalSeqs.length

    // 若 user-title，messageSeqs 必须为空
    if (titleSourceKind === 'user') {
      const newSeqs = []
      changes.push({
        type: 'title-messageSeqs-filtered',
        seq: event.seq,
        titleSourceKind,
        before: originalSeqs,
        after: newSeqs,
        removedCount: originalCount,
        reason: 'user-title must have empty messageSeqs',
      })
      return { ...event, data: { ...data, messageSeqs: newSeqs } }
    }

    // 非 user-title：过滤无效引用
    const seen = new Set()
    const filteredSeqs = []
    for (const seq of originalSeqs) {
      if (typeof seq !== 'number') continue
      if (seq >= event.seq) continue
      if (seen.has(seq)) continue
      const cited = eventBySeq.get(seq)
      if (!cited || cited.type !== 'user/message') continue
      const citedData = cited.data
      const citedSource = isRecord(citedData) ? citedData.source : undefined
      if (!isRecord(citedSource) || citedSource.kind !== 'user') continue
      seen.add(seq)
      filteredSeqs.push(seq)
    }

    if (filteredSeqs.length === originalCount) return event // 无变化

    changes.push({
      type: 'title-messageSeqs-filtered',
      seq: event.seq,
      titleSourceKind,
      before: originalSeqs,
      after: filteredSeqs,
      removedCount: originalCount - filteredSeqs.length,
      reason: 'filtered invalid references (not-earlier/not-user-message/not-human-source/duplicate)',
    })
    return { ...event, data: { ...data, messageSeqs: filteredSeqs } }
  })

  // 断言审计完整性
  if (changes.length === 0) {
    throw new Error('repairTitleMessageSeqs: changes audit is empty but titleIssues were non-empty — logic error')
  }

  return { repairedEvents, changes }
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

  // 1. 修复 descriptor（fork 字段剥离 + v0 version bump + v3 扩展事件插入）
  if (neededTypes.includes(RepairType.FORK_DESCRIPTOR_FIELDS) || neededTypes.includes(RepairType.V0_DESCRIPTOR_VERSION)) {
    const header = repairedEvents.find((e) => e.type === 'session')
    const fileVersion = header?.version === 0 ? 'v0' : header?.version === 2 ? 'v2' : header?.version === 3 ? 'v3' : 'v2'
    // 代际裁决（brief §1）：
    //   v0/v2 — 官方 v2→v3 迁移器拒绝 unclassified 事件（RELEASED_V2_EVENT_DISPOSITIONS
    //            不含 plugin:corum-subagent/descriptor），故**不插入** plugin 扩展。
    //            fork 字段从官方 descriptor 剥离后丢弃（旧 fork 运行时合法值，
    //            迁移后不可恢复，但迁移能通过——低风险路径）。
    //   v3    — assertV3Event 将未知 type 视为 opaque/ignorable，**可以**插入
    //            plugin:corum-subagent/descriptor 扩展事件保留 fork 字段值。
    const canInsertExtension = fileVersion === 'v3'
    const descChanges = []
    const corumExtensions = [] // { afterSeq, corumData } — v3: 在该 seq 的官方 descriptor 之后插入

    // 第一遍：剥离 fork 字段 + version bump，收集 corum 扩展数据
    repairedEvents = repairedEvents.map((event) => {
      if (event.type !== 'subagent/descriptor') return event
      const result = repairDescriptor(event.data, fileVersion)
      if (result) {
        descChanges.push({ seq: event.seq, changes: result.changes })
        // 收集剥离的 fork 字段值（v3 才构造扩展事件）
        if (canInsertExtension) {
          const strippedFields = result.changes
            .filter((c) => c.type === 'strip-field')
            .reduce((acc, c) => { acc[c.field] = c.value; return acc }, {})
          if (Object.keys(strippedFields).length > 0) {
            const corumData = { version: 1 }
            if (strippedFields.kind !== undefined) corumData.kind = strippedFields.kind
            if (strippedFields.personaHint !== undefined) corumData.personaHint = strippedFields.personaHint
            if (strippedFields.confined !== undefined) corumData.confined = strippedFields.confined
            corumExtensions.push({ afterSeq: event.seq, corumData })
          }
        }
        return { ...event, data: result.repaired }
      }
      return event
    })

    // 第二遍（仅 v3）：在事件列表末尾追加 corum 扩展事件
    // 重要：不插入到 descriptor 之后（那样会改变后续所有 seq，
    // 导致 messageSeqs / shadowedSeqs / surfaceOp replace ranges 失效）。
    // foldSubagentDescriptor 用 .find() 搜索整个事件列表找 corum 扩展事件，
    // 不要求紧跟 descriptor——故追加到末尾用新 seq 是安全的。
    if (corumExtensions.length > 0) {
      // 找到当前最大 seq
      let maxSeq = -1
      for (const event of repairedEvents) {
        if (typeof event.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq
      }
      // 在末尾追加 corum 扩展事件（不改变任何现有 seq）
      for (const ext of corumExtensions) {
        maxSeq++
        repairedEvents.push({
          type: 'plugin:corum-subagent/descriptor',
          seq: maxSeq,
          time: Date.now(),
          ignorable: true,
          data: ext.corumData,
        })
      }
      descChanges.push({
        type: 'corum-extension-appended',
        count: corumExtensions.length,
        fields: corumExtensions.map((e) => Object.keys(e.corumData).filter((k) => k !== 'version')),
        reason: 'appended at end (not inserted after descriptor) to preserve all seq references',
      })
    }

    if (fileVersion === 'v0' || fileVersion === 'v2') {
      descChanges.push({
        type: 'fork-fields-dropped',
        reason: 'v0/v2 cannot carry plugin:corum-subagent/descriptor (v2→v3 rejects unclassified); fork fields stripped without extension insertion',
      })
    }

    allChanges.push({ type: 'descriptor-repair', changes: descChanges })
  }

  // 2. 修复 session/title messageSeqs 非法引用
  // 重要：descriptor 修复（v3 扩展事件插入 + 重新编号）会改变 seq，
  // 使原本有效的 messageSeqs 引用变成失效引用。故在 descriptor 修复后
  // 重新检测 title 问题（即使原始检测未发现问题）。
  {
    const reDetected = detectRepairNeeds(repairedEvents)
    const titleIssues = reDetected.details.titleMessageSeqs
    if (titleIssues.length > 0) {
      const result = repairTitleMessageSeqs(repairedEvents, titleIssues)
      if (result) {
        repairedEvents = result.repairedEvents
        allChanges.push({ type: 'title-messageSeqs-repair', changes: result.changes })
      }
    }
  }

  // 3. 修复未关闭的工具调用
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
