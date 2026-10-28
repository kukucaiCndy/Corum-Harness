/**
 * v4-migration-repair.spec.mjs —— 修复模块 fixture 测试。
 *
 * 覆盖：
 *   1. fork descriptor kind/personaHint/confined 剥离
 *   2. v0 descriptor version 2→3
 *   3. unresolved tool calls 合成中断结果
 *   4. 损坏 turn/start quarantine
 *   5. v0 hash 正则覆盖
 *   6. 源不变（修复不碰源文件）
 *
 * 运行：node scripts/lib/v4-migration-repair.spec.mjs
 */

import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile, cp, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import {
  scanZstdFrames,
  decodeSessionFile,
  encodeSessionFile,
  detectRepairNeeds,
  repairSessionFile,
  repairSessions,
  sha256File,
  RepairType,
} from './v4-migration-repair.mjs'

const ZSTD_C_CHECKSUM_FLAG = 201

let passed = 0
let failed = 0

function assert(condition, message) {
  if (condition) {
    passed++
    console.log(`  ✓ ${message}`)
  } else {
    failed++
    console.error(`  ✗ ${message}`)
  }
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
}

async function createTempSessionFile(dir, events, filename = 'session.v2.jsonl.zstd') {
  const filePath = join(dir, filename)
  await encodeSessionFile(filePath, events)
  return filePath
}

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), 'v4-repair-test-'))
}

// ── 测试 fixture ──────────────────────────────────────────────────────

/** 构造一个带 fork 扩展字段的 v2 会话。 */
function makeForkDescriptorSession() {
  return [
    {
      type: 'session',
      version: 2,
      id: 'test-fork-desc',
      createdAt: 1790000000000,
      cwd: '/test',
      parentSession: 'parent-1',
      isSeeded: false,
      origin: 'subagent',
      delegationDepth: 1,
      agentPreset: 'conductor-lead',
    },
    { type: 'turn/start', seq: 0, time: 1790000000000, data: { turn: 0 } },
    { type: 'step/start', seq: 1, time: 1790000000000, data: { turn: 0, step: 1 } },
    {
      type: 'subagent/descriptor',
      seq: 2,
      time: 1790000000000,
      data: {
        version: 3,
        mode: 'continuable',
        provider: 'corum-spawn',
        label: 'Test Worker',
        agentProvider: 'localhost',
        agentModel: 'test-model',
        kind: 'worker',
        personaHint: 'test-persona',
        confined: true,
      },
    },
    { type: 'step/end', seq: 3, time: 1790000000000, data: { turn: 0, step: 1 } },
    { type: 'turn/end', seq: 4, time: 1790000000000, data: { turn: 0, reason: { kind: 'normal' } } },
  ]
}

/** 构造一个 v0 descriptor version=2 的会话。 */
function makeV0DescriptorVersion2Session() {
  return [
    {
      type: 'session',
      version: 0,
      id: 'test-v0-desc-v2',
      createdAt: 1790000000000,
      cwd: '/test',
      origin: 'standalone',
      delegationDepth: 0,
    },
    { type: 'turn/start', seq: 0, time: 1790000000000, data: { turn: 0 } },
    { type: 'step/start', seq: 1, time: 1790000000000, data: { turn: 0, step: 1 } },
    {
      type: 'subagent/descriptor',
      seq: 2,
      time: 1790000000000,
      data: {
        version: 2,
        mode: 'one-shot',
        provider: 'spawn',
        label: 'Test One-Shot',
      },
    },
    { type: 'step/end', seq: 3, time: 1790000000000, data: { turn: 0, step: 1 } },
    { type: 'turn/end', seq: 4, time: 1790000000000, data: { turn: 0, reason: { kind: 'normal' } } },
  ]
}

/** 构造一个 step/end 后有未关闭 tool call 的 v3 会话。 */
function makeUnresolvedToolCallSession() {
  return [
    {
      type: 'session',
      version: 3,
      id: 'test-unresolved-tool',
      createdAt: 1790000000000,
      cwd: '/test',
      origin: 'standalone',
      delegationDepth: 0,
    },
    { type: 'turn/start', seq: 0, time: 1790000000000, data: { turn: 0 } },
    { type: 'step/start', seq: 1, time: 1790000000000, data: { turn: 0, step: 1 } },
    {
      type: 'assistant/message',
      seq: 2,
      time: 1790000000000,
      data: {
        turn: 0, step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_test_123', name: 'bash', arguments: '{}' }],
        },
        stream: [],
        usage: {},
      },
    },
    { type: 'tool/call', seq: 3, time: 1790000000000, data: { turn: 0, step: 1, callId: 'call_test_123', name: 'bash', arguments: '{}' } },
    // step/end WITHOUT tool/result — this is the problem
    { type: 'step/end', seq: 4, time: 1790000000000, data: { turn: 0, step: 1 } },
    { type: 'turn/end', seq: 5, time: 1790000000000, data: { turn: 0, reason: { kind: 'error', error: { message: 'crash', code: 'UNKNOWN' } } } },
  ]
}

/** 构造一个 turn/start 结构损坏的会话（turn 未关闭就开新 turn）。 */
function makeCorruptedTurnStartSession() {
  return [
    {
      type: 'session',
      version: 2,
      id: 'test-corrupted-turn',
      createdAt: 1790000000000,
      cwd: '/test',
      origin: 'standalone',
      delegationDepth: 0,
    },
    { type: 'turn/start', seq: 0, time: 1790000000000, data: { turn: 0 } },
    { type: 'step/start', seq: 1, time: 1790000000000, data: { turn: 0, step: 1 } },
    { type: 'step/end', seq: 2, time: 1790000000000, data: { turn: 0, step: 1 } },
    // No turn/end for turn 0 — directly starts turn 1 without splice restart
    { type: 'turn/start', seq: 3, time: 1790000000000, data: { turn: 1 } },
    { type: 'step/start', seq: 4, time: 1790000000000, data: { turn: 1, step: 1 } },
    { type: 'step/end', seq: 5, time: 1790000000000, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: 1790000000000, data: { turn: 1, reason: { kind: 'normal' } } },
  ]
}

/** 构造一个无修复需要的正常 v3 会话。 */
function makeNormalSession() {
  return [
    {
      type: 'session',
      version: 3,
      id: 'test-normal',
      createdAt: 1790000000000,
      cwd: '/test',
      origin: 'standalone',
      delegationDepth: 0,
    },
    { type: 'turn/start', seq: 0, time: 1790000000000, data: { turn: 0 } },
    { type: 'step/start', seq: 1, time: 1790000000000, data: { turn: 0, step: 1 } },
    {
      type: 'assistant/message',
      seq: 2,
      time: 1790000000000,
      data: {
        turn: 0, step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
        stream: [],
        usage: {},
      },
    },
    { type: 'step/end', seq: 3, time: 1790000000000, data: { turn: 0, step: 1 } },
    { type: 'turn/end', seq: 4, time: 1790000000000, data: { turn: 0, reason: { kind: 'normal' } } },
  ]
}

/** 构造一个 v3 会话，其 session/title messageSeqs 含非法引用。 */
function makeTitleInvalidSeqsSession() {
  return [
    {
      type: 'session',
      version: 3,
      id: 'test-title-invalid',
      createdAt: 1790000000000,
      cwd: '/test',
      origin: 'standalone',
      delegationDepth: 0,
    },
    { type: 'turn/start', seq: 0, time: 1790000000000, data: { turn: 0 } },
    { type: 'step/start', seq: 1, time: 1790000000000, data: { turn: 0, step: 1 } },
    {
      type: 'user/message',
      seq: 2,
      time: 1790000000000,
      data: {
        turn: 0, step: 1,
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'hello world' }],
      },
    },
    {
      type: 'assistant/message',
      seq: 3,
      time: 1790000000000,
      data: {
        turn: 0, step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'response' }] },
        stream: [],
        usage: {},
      },
    },
    { type: 'step/end', seq: 4, time: 1790000000000, data: { turn: 0, step: 1 } },
    { type: 'turn/end', seq: 5, time: 1790000000000, data: { turn: 0, reason: { kind: 'normal' } } },
    // session/title with invalid messageSeqs:
    // - seq 2 is valid (user/message with source.kind=user, earlier than title)
    // - seq 3 is invalid (assistant/message, not user/message)
    // - seq 99 is invalid (doesn't exist / not earlier)
    // - seq 2 duplicate is invalid
    {
      type: 'session/title',
      seq: 6,
      time: 1790000000000,
      data: {
        title: 'Test Title',
        messageSeqs: [2, 3, 99, 2],
        source: { kind: 'fallback' },
      },
    },
  ]
}

/** 构造一个 v3 会话，其 session/title source.kind=user 但 messageSeqs 非空。 */
function makeUserTitleWithSeqsSession() {
  return [
    {
      type: 'session',
      version: 3,
      id: 'test-user-title-seqs',
      createdAt: 1790000000000,
      cwd: '/test',
      origin: 'standalone',
      delegationDepth: 0,
    },
    { type: 'turn/start', seq: 0, time: 1790000000000, data: { turn: 0 } },
    { type: 'step/start', seq: 1, time: 1790000000000, data: { turn: 0, step: 1 } },
    {
      type: 'user/message',
      seq: 2,
      time: 1790000000000,
      data: {
        turn: 0, step: 1,
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'hello world' }],
      },
    },
    { type: 'step/end', seq: 3, time: 1790000000000, data: { turn: 0, step: 1 } },
    { type: 'turn/end', seq: 4, time: 1790000000000, data: { turn: 0, reason: { kind: 'normal' } } },
    // user title must have empty messageSeqs — but here it's [2]
    {
      type: 'session/title',
      seq: 5,
      time: 1790000000000,
      data: {
        title: 'User Title',
        messageSeqs: [2],
        source: { kind: 'user' },
      },
    },
  ]
}

// ── 测试 ──────────────────────────────────────────────────────────────

async function testForkDescriptorStrip() {
  console.log('\n=== Test: v2 fork descriptor kind/personaHint/confined 剥离（不插扩展） ===')
  const dir = await makeTempDir()
  const events = makeForkDescriptorSession()
  const filePath = await createTempSessionFile(dir, events)

  const { types, details } = detectRepairNeeds(events)
  assert(types.includes(RepairType.FORK_DESCRIPTOR_FIELDS), '检测到 FORK_DESCRIPTOR_FIELDS')
  assert(details.forkDescriptors.length === 1, '1 个 descriptor 需修复')
  assert(details.forkDescriptors[0].fields.length === 3, '3 个 fork 字段')

  const result = await repairSessionFile(filePath)
  assert(result.repaired === true, '修复成功')
  assert(result.types.includes(RepairType.FORK_DESCRIPTOR_FIELDS), '修复类型包含 FORK_DESCRIPTOR_FIELDS')
  assert(result.beforeHash !== result.afterHash, 'hash 变化')

  const repairedEvents = await decodeSessionFile(filePath)
  const desc = repairedEvents.find((e) => e.type === 'subagent/descriptor')
  assert(!Object.hasOwn(desc.data, 'kind'), 'kind 字段已剥离')
  assert(!Object.hasOwn(desc.data, 'personaHint'), 'personaHint 字段已剥离')
  assert(!Object.hasOwn(desc.data, 'confined'), 'confined 字段已剥离')
  assert(desc.data.version === 3, 'version 保持 3')
  assert(desc.data.mode === 'continuable', 'mode 保持 continuable')
  assert(desc.data.provider === 'corum-spawn', 'provider 保持')
  assert(desc.data.agentModel === 'test-model', 'agentModel 保持')

  // v2 代际裁决：不插入 plugin:corum-subagent/descriptor（v2→v3 拒绝 unclassified）
  const corumExt = repairedEvents.find((e) => e.type === 'plugin:corum-subagent/descriptor')
  assert(corumExt === undefined, 'v2 不插入 corum 扩展事件（代际裁决：v2→v3 拒绝 unclassified）')

  // 审计记录：有 fork-fields-dropped 记录
  const descChange = result.changes.find((c) => c.type === 'descriptor-repair')
  assert(descChange !== undefined, '有 descriptor-repair 变更记录')
  assert(descChange.changes[0].changes.length === 3, '记录 3 个字段剥离')
  const dropped = descChange.changes.find((c) => c.type === 'fork-fields-dropped')
  assert(dropped !== undefined, '记录 fork-fields-dropped（v0/v2 不插扩展）')
  const extInsert = descChange.changes.find((c) => c.type === 'corum-extension-inserted')
  assert(extInsert === undefined, 'v2 无 corum-extension-inserted 记录')

  await rm(dir, { recursive: true, force: true })
}

async function testV3ForkDescriptorSplit() {
  console.log('\n=== Test: v3 fork descriptor 剥离 + 扩展事件追加 ===')
  const dir = await makeTempDir()
  const events = makeForkDescriptorSession()
  // 改为 v3
  events[0].version = 3
  const filePath = await createTempSessionFile(dir, events, 'session.v3.jsonl.zstd')

  const { types, details } = detectRepairNeeds(events)
  assert(types.includes(RepairType.FORK_DESCRIPTOR_FIELDS), '检测到 FORK_DESCRIPTOR_FIELDS')
  assert(details.forkDescriptors.length === 1, '1 个 descriptor 需修复')

  const result = await repairSessionFile(filePath)
  assert(result.repaired === true, '修复成功')
  assert(result.beforeHash !== result.afterHash, 'hash 变化')

  const repairedEvents = await decodeSessionFile(filePath)
  const desc = repairedEvents.find((e) => e.type === 'subagent/descriptor')
  assert(!Object.hasOwn(desc.data, 'kind'), 'kind 字段已剥离')
  assert(!Object.hasOwn(desc.data, 'personaHint'), 'personaHint 字段已剥离')
  assert(!Object.hasOwn(desc.data, 'confined'), 'confined 字段已剥离')

  // v3 代际裁决：追加 plugin:corum-subagent/descriptor（assertV3Event 允许 opaque/ignorable）
  const corumExt = repairedEvents.find((e) => e.type === 'plugin:corum-subagent/descriptor')
  assert(corumExt !== undefined, 'v3 追加 corum 扩展事件')
  assert(corumExt.ignorable === true, 'corum 扩展事件 ignorable:true')
  assert(corumExt.data.version === 1, 'corum 扩展 version=1')
  assert(corumExt.data.kind === 'worker', 'corum 扩展 kind=worker')
  assert(corumExt.data.personaHint === 'test-persona', 'corum 扩展 personaHint=test-persona')
  assert(corumExt.data.confined === true, 'corum 扩展 confined=true')

  // 验证 corum 扩展事件在末尾（不插入到 descriptor 之后，保留所有 seq 引用）
  const corumIdx = repairedEvents.findIndex((e) => e.type === 'plugin:corum-subagent/descriptor')
  assert(corumIdx === repairedEvents.length - 1, 'corum 扩展事件在末尾')

  // 验证现有事件的 seq 未被重编号（保留 messageSeqs/shadowedSeqs/surfaceOp 引用）
  for (let i = 0; i < repairedEvents.length - 1; i++) {
    const orig = events[i]
    const repaired = repairedEvents[i]
    if (orig.seq !== undefined && repaired.seq !== undefined) {
      assertEqual(repaired.seq, orig.seq, `seq ${orig.seq} 未被重编号`)
    }
  }

  // 审计记录
  const descChange = result.changes.find((c) => c.type === 'descriptor-repair')
  assert(descChange !== undefined, '有 descriptor-repair 变更记录')
  const extAppend = descChange.changes.find((c) => c.type === 'corum-extension-appended')
  assert(extAppend !== undefined, '记录 corum-extension-appended')
  assert(extAppend.count === 1, '追加 1 个 corum 扩展事件')

  await rm(dir, { recursive: true, force: true })
}

async function testV0DescriptorVersionBump() {
  console.log('\n=== Test: v0 descriptor version 2→3 ===')
  const dir = await makeTempDir()
  const events = makeV0DescriptorVersion2Session()
  const filePath = await createTempSessionFile(dir, events, 'session.jsonl.zstd')

  const { types, details } = detectRepairNeeds(events)
  assert(types.includes(RepairType.V0_DESCRIPTOR_VERSION), '检测到 V0_DESCRIPTOR_VERSION')

  const result = await repairSessionFile(filePath)
  assert(result.repaired === true, '修复成功')

  const repairedEvents = await decodeSessionFile(filePath)
  const desc = repairedEvents.find((e) => e.type === 'subagent/descriptor')
  assertEqual(desc.data.version, 3, 'version 从 2 改为 3')
  assert(desc.data.mode === 'one-shot', 'mode 保持 one-shot')
  assert(desc.data.provider === 'spawn', 'provider 保持')
  assert(desc.data.label === 'Test One-Shot', 'label 保持')

  await rm(dir, { recursive: true, force: true })
}

async function testUnresolvedToolCalls() {
  console.log('\n=== Test: unresolved tool calls 合成中断结果 ===')
  const dir = await makeTempDir()
  const events = makeUnresolvedToolCallSession()
  const filePath = await createTempSessionFile(dir, events, 'session.v3.jsonl.zstd')

  const { types, details } = detectRepairNeeds(events)
  assert(types.includes(RepairType.UNRESOLVED_TOOL_CALLS), '检测到 UNRESOLVED_TOOL_CALLS')
  assert(details.unresolvedToolCalls.length === 1, '1 个未关闭 step')
  assert(details.unresolvedToolCalls[0].callIds.includes('call_test_123'), '包含 call_test_123')

  const result = await repairSessionFile(filePath)
  assert(result.repaired === true, '修复成功')

  const repairedEvents = await decodeSessionFile(filePath)
  // 验证插入了 tool/result
  const toolResults = repairedEvents.filter((e) => e.type === 'tool/result')
  assert(toolResults.length === 1, '插入 1 个 tool/result')
  assert(toolResults[0].data.message.content[0].isError === true, 'wrapper isError: true')
  // v3 格式：message 级别无 isError（liftToolResult 在 v3→v4 迁移时从 wrapper 提取到 message）
  // v3 格式：callId 在 message.source.callId
  assert(toolResults[0].data.message.source.callId === 'call_test_123', 'source.callId 匹配')
  assert(toolResults[0].data.message.content[0].toolCallId === 'call_test_123', 'content toolCallId 匹配')
  assert(toolResults[0].data.message.content[0].isError === true, 'content isError: true')
  assert(toolResults[0].data.error.code === 'TOOL_OUTCOME_UNKNOWN', 'error code: TOOL_OUTCOME_UNKNOWN')
  assert(toolResults[0].data.error.name === 'ToolOutcomeUnknownError', 'error name: ToolOutcomeUnknownError')
  assert(Array.isArray(toolResults[0].sourceEventSeqs), 'sourceEventSeqs 存在（started call）')

  // 验证 tool/result 出现在 step/end 之前
  const stepEndIdx = repairedEvents.findIndex((e) => e.type === 'step/end')
  const toolResultIdx = repairedEvents.findIndex((e) => e.type === 'tool/result')
  assert(toolResultIdx < stepEndIdx, 'tool/result 在 step/end 之前')

  // 验证 seq 密集连续
  let expectedSeq = 0
  for (const evt of repairedEvents) {
    if (evt.type === 'session') continue
    assertEqual(evt.seq, expectedSeq, `seq ${expectedSeq} 密集连续`)
    expectedSeq++
  }

  await rm(dir, { recursive: true, force: true })
}

async function testQuarantineCorruptedTurnStart() {
  console.log('\n=== Test: 损坏 turn/start quarantine ===')
  const dir = await makeTempDir()
  const events = makeCorruptedTurnStartSession()
  const filePath = await createTempSessionFile(dir, events)

  const { types, details } = detectRepairNeeds(events)
  assert(types.includes(RepairType.QUARANTINE), '检测到 QUARANTINE')

  const result = await repairSessionFile(filePath)
  assert(result.quarantined === true, '标记为 quarantine')
  assert(result.repaired === false, '未执行修复')
  assertEqual(result.beforeHash, result.afterHash, 'hash 不变（未修改文件）')

  await rm(dir, { recursive: true, force: true })
}

async function testV0HashRegexCoverage() {
  console.log('\n=== Test: v0 hash 正则覆盖 ===')
  // 验证 scanZstdFrames 能正确处理 v0 文件名（session.jsonl.zstd）
  const dir = await makeTempDir()
  const v0Events = makeV0DescriptorVersion2Session()
  const v2Events = makeForkDescriptorSession() // 不同内容
  const v0Path = await createTempSessionFile(dir, v0Events, 'session.jsonl.zstd')
  const v2Path = await createTempSessionFile(dir, v2Events, 'session.v2.jsonl.zstd')

  // v0 文件能被 decodeSessionFile 正确解码
  const v0Decoded = await decodeSessionFile(v0Path)
  assert(v0Decoded.length === v0Events.length, 'v0 文件解码正确')

  // v2 文件也能正确解码
  const v2Decoded = await decodeSessionFile(v2Path)
  assert(v2Decoded.length === v2Events.length, 'v2 文件解码正确')

  // sha256File 能对两种文件名生成 hash
  const v0Hash = await sha256File(v0Path)
  const v2Hash = await sha256File(v2Path)
  assert(v0Hash !== v2Hash, '不同内容文件 hash 不同')

  // 验证 hash 正则能匹配 v0 文件名（模拟 rehearse 脚本的文件名匹配）
  const v0Filename = 'session.jsonl.zstd'
  const v2Filename = 'session.v2.jsonl.zstd'
  const v3Filename = 'session.v3.jsonl.zstd'
  // 修复后的正则：匹配 v0 (无 .vN) 和 vN 文件
  const fixedRegex = /^session(\.v\d+)?\.jsonl(\.zstd)?$/
  assert(fixedRegex.test(v0Filename), '正则匹配 v0 session.jsonl.zstd')
  assert(fixedRegex.test(v2Filename), '正则匹配 v2 session.v2.jsonl.zstd')
  assert(fixedRegex.test(v3Filename), '正则匹配 v3 session.v3.jsonl.zstd')
  // 不匹配 .bak 文件
  assert(!fixedRegex.test('session.v3.jsonl.zstd.bak-20261021'), '正则不匹配 .bak 文件')

  await rm(dir, { recursive: true, force: true })
}

async function testSourceUnchanged() {
  console.log('\n=== Test: 源不变（修复不碰源文件） ===')
  const sourceDir = await makeTempDir()
  const tempDir = await makeTempDir()

  // 创建源文件
  const events = makeForkDescriptorSession()
  const sourceFile = await createTempSessionFile(sourceDir, events, 'session.v2.jsonl.zstd')
  const sourceHashBefore = await sha256File(sourceFile)

  // 复制到临时目录并修复
  const tempFile = join(tempDir, 'session.v2.jsonl.zstd')
  await cp(sourceFile, tempFile)
  await repairSessionFile(tempFile)

  // 源文件 hash 不变
  const sourceHashAfter = await sha256File(sourceFile)
  assertEqual(sourceHashAfter, sourceHashBefore, '源文件 hash 不变')

  // 临时文件 hash 变化
  const tempHashAfter = await sha256File(tempFile)
  assert(tempHashAfter !== sourceHashBefore, '临时副本 hash 变化（已修复）')

  await rm(sourceDir, { recursive: true, force: true })
  await rm(tempDir, { recursive: true, force: true })
}

async function testNormalSessionNoRepair() {
  console.log('\n=== Test: 正常会话无需修复 ===')
  const dir = await makeTempDir()
  const events = makeNormalSession()
  const filePath = await createTempSessionFile(dir, events, 'session.v3.jsonl.zstd')

  const { types } = detectRepairNeeds(events)
  assert(types.length === 0, '无需修复')

  const result = await repairSessionFile(filePath)
  assert(result.repaired === false, '未执行修复')
  assertEqual(result.beforeHash, result.afterHash, 'hash 不变')

  await rm(dir, { recursive: true, force: true })
}

async function testTitleInvalidSeqsFilter() {
  console.log('\n=== Test: session/title messageSeqs 非法引用过滤 ===')
  const dir = await makeTempDir()
  const events = makeTitleInvalidSeqsSession()
  const filePath = await createTempSessionFile(dir, events, 'session.v3.jsonl.zstd')

  const { types, details } = detectRepairNeeds(events)
  assert(types.includes(RepairType.TITLE_MESSAGE_SEQS), '检测到 TITLE_MESSAGE_SEQS')
  assert(details.titleMessageSeqs.length === 1, '1 个 title 需修复')
  assert(details.titleMessageSeqs[0].invalidSeqs.length === 3, '3 个无效引用（seq 3, 99, dup 2）')

  const result = await repairSessionFile(filePath)
  assert(result.repaired === true, '修复成功')
  assert(result.types.includes(RepairType.TITLE_MESSAGE_SEQS), '修复类型包含 TITLE_MESSAGE_SEQS')

  const repairedEvents = await decodeSessionFile(filePath)
  const title = repairedEvents.find((e) => e.type === 'session/title')
  // Only seq 2 should remain (valid user/message, earlier, not duplicate)
  assertEqual(title.data.messageSeqs.length, 1, '过滤后保留 1 个有效引用')
  assertEqual(title.data.messageSeqs[0], 2, '保留 seq 2（有效 user/message）')
  assertEqual(title.data.title, 'Test Title', 'title 文本保留')
  assertEqual(title.data.source.kind, 'fallback', 'source.kind 保留')

  // 审计记录
  const titleChange = result.changes.find((c) => c.type === 'title-messageSeqs-repair')
  assert(titleChange !== undefined, '有 title-messageSeqs-repair 变更记录')
  assert(titleChange.changes.length === 1, '1 个 title 变更记录')
  assert(titleChange.changes[0].removedCount === 3, '移除 3 个无效引用')

  // 验证没有事件被移动或重编号（title.seq 仍为 6）
  assertEqual(title.seq, 6, 'title seq 不变（不移动事件）')

  await rm(dir, { recursive: true, force: true })
}

async function testUserTitleWithSeqsFilter() {
  console.log('\n=== Test: user-title messageSeqs 清空 ===')
  const dir = await makeTempDir()
  const events = makeUserTitleWithSeqsSession()
  const filePath = await createTempSessionFile(dir, events, 'session.v3.jsonl.zstd')

  const { types, details } = detectRepairNeeds(events)
  assert(types.includes(RepairType.TITLE_MESSAGE_SEQS), '检测到 TITLE_MESSAGE_SEQS')
  assert(details.titleMessageSeqs.length === 1, '1 个 title 需修复')

  const result = await repairSessionFile(filePath)
  assert(result.repaired === true, '修复成功')

  const repairedEvents = await decodeSessionFile(filePath)
  const title = repairedEvents.find((e) => e.type === 'session/title')
  // user-title must have empty messageSeqs
  assertEqual(title.data.messageSeqs.length, 0, 'user-title messageSeqs 清空')
  assertEqual(title.data.source.kind, 'user', 'source.kind=user 保留')

  await rm(dir, { recursive: true, force: true })
}

async function testHighestGenerationOnly() {
  console.log('\n=== Test: 最高代修复（低代文件不触碰） ===')
  const dir = await makeTempDir()
  const sessionDir = join(dir, 'test-session')
  await mkdir(sessionDir, { recursive: true })

  // v2 文件（低代）
  const v2Events = makeForkDescriptorSession()
  const v2Path = await createTempSessionFile(sessionDir, v2Events, 'session.v2.jsonl.zstd')
  const v2HashBefore = await sha256File(v2Path)

  // v3 文件（最高代，带 fork 字段）
  const v3Events = makeForkDescriptorSession()
  v3Events[0].version = 3
  const v3Path = await createTempSessionFile(sessionDir, v3Events, 'session.v3.jsonl.zstd')
  const v3HashBefore = await sha256File(v3Path)

  // 只修复 v3（最高代）
  const result = await repairSessionFile(v3Path)
  assert(result.repaired === true, 'v3 修复成功')
  const v3HashAfter = await sha256File(v3Path)
  assert(v3HashAfter !== v3HashBefore, 'v3 hash 变化')

  // v2 文件不变
  const v2HashAfter = await sha256File(v2Path)
  assertEqual(v2HashAfter, v2HashBefore, 'v2（低代）文件不变')

  await rm(dir, { recursive: true, force: true })
}

async function testBatchRepair() {
  console.log('\n=== Test: 批量修复 + 单会话失败不阻塞 ===')
  const dir = await makeTempDir()

  // 创建子目录
  await mkdir(join(dir, 'fork'), { recursive: true })
  await mkdir(join(dir, 'v0'), { recursive: true })
  await mkdir(join(dir, 'normal'), { recursive: true })

  // 创建多种会话
  const forkFile = await createTempSessionFile(join(dir, 'fork'), makeForkDescriptorSession(), 'session.v2.jsonl.zstd')
  const v0File = await createTempSessionFile(join(dir, 'v0'), makeV0DescriptorVersion2Session(), 'session.jsonl.zstd')
  const normalFile = await createTempSessionFile(join(dir, 'normal'), makeNormalSession(), 'session.v3.jsonl.zstd')

  const { results, summary } = await repairSessions([forkFile, v0File, normalFile])
  assertEqual(summary.total, 3, '总数 3')
  assertEqual(summary.repaired, 2, '修复 2')
  assertEqual(summary.noRepairNeeded, 1, '无需修复 1')
  assertEqual(summary.quarantined, 0, 'quarantine 0')
  assertEqual(summary.failed, 0, '失败 0')

  await rm(dir, { recursive: true, force: true })
}

async function testZstdRoundtrip() {
  console.log('\n=== Test: zstd 编解码 roundtrip ===')
  const dir = await makeTempDir()
  const events = makeForkDescriptorSession()
  const filePath = await createTempSessionFile(dir, events)

  // 解码后再编码，验证 roundtrip
  const decoded = await decodeSessionFile(filePath)
  assertEqual(decoded.length, events.length, '解码事件数匹配')

  const filePath2 = join(dir, 'roundtrip.zstd')
  await encodeSessionFile(filePath2, decoded)
  const decoded2 = await decodeSessionFile(filePath2)
  assertEqual(decoded2.length, decoded.length, 'roundtrip 后事件数匹配')

  // 验证事件内容一致（忽略 seq 重编号）
  for (let i = 0; i < decoded.length; i++) {
    assertEqual(decoded[i].type, decoded2[i].type, `事件 ${i} type 一致`)
  }

  await rm(dir, { recursive: true, force: true })
}

// ── 运行 ──────────────────────────────────────────────────────────────

async function main() {
  console.log('v4-migration-repair fixture 测试\n')

  await testForkDescriptorStrip()
  await testV3ForkDescriptorSplit()
  await testV0DescriptorVersionBump()
  await testUnresolvedToolCalls()
  await testTitleInvalidSeqsFilter()
  await testUserTitleWithSeqsFilter()
  await testQuarantineCorruptedTurnStart()
  await testV0HashRegexCoverage()
  await testSourceUnchanged()
  await testNormalSessionNoRepair()
  await testHighestGenerationOnly()
  await testBatchRepair()
  await testZstdRoundtrip()

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`)
  process.exit(failed > 0 ? 1 : 0)
}

await main().catch((err) => {
  console.error('测试运行错误:', err)
  process.exit(1)
})
