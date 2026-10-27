/**
 * Delegation-depth accounting: the recursion budget a parent passes to its
 * children. Kept apart from the service so composition helpers can read it
 * without importing the registry.
 *
 * @module @deepseek-ai/dsh-subagent/depth
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { SubagentError } from './error.ts'

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Delegation depth: zero for a top-level agent and parent depth + 1 for a child. */
    subagentDepth?: number
  }
}

/**
 * Read an agent's delegation depth, treating absence as top-level depth zero.
 * The persisted session header is authoritative and monotone: runtime
 * `AgentOptions.subagentDepth` may DEEPEN the count but can never lower it —
 * a resumed child arrives with fresh options, and counting it from zero would
 * let it delegate as if it were top-level.
 * @param agent - the agent whose header and options carry the depth.
 * @returns its non-negative safe-integer depth.
 * @throws if the runtime `AgentOptions.subagentDepth` is not a non-negative safe integer.
 */
export function delegationDepthOf(agent: Agent): number {
  const runtime = agent.options.subagentDepth
  if (runtime !== undefined && (!Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0))) {
    throw new TypeError('agent subagentDepth must be a non-negative safe integer')
  }
  // The header value was validated at the session boundary (creation and
  // persistence load both construct through the store).
  return Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0)
}

/**
 * Reject a recursion cap that cannot represent an exact delegation depth.
 * @param maxDepth - the optional runtime value to validate.
 */
export function assertSubagentMaxDepth(maxDepth: unknown): void {
  if (maxDepth !== undefined && (
    typeof maxDepth !== 'number'
    || !Number.isSafeInteger(maxDepth)
    || maxDepth < 0
    || Object.is(maxDepth, -0)
  )) {
    throw new TypeError('subagent maxDepth must be a non-negative safe integer')
  }
}

/**
 * fork（corum）：校验子 Agent 显式 cwd（隔离 confine 补充）。
 *
 * 官方 rc3 已有 ResolvedSubagentStartRequest.cwd（由 manager.resolveDirectory 解析为绝对路径）。
 * corum 保留此函数用于隔离 confine 路径补充校验：显式 cwd 必须是绝对路径且已存在。
 * @param cwd - 子 Agent 工作目录（可选）。
 * @throws {SubagentError} 当 cwd 非空但不是绝对路径或目录不存在。
 */
export function assertChildCwd(cwd: string | undefined): void {
  if (cwd === undefined) return
  if (!isAbsolute(cwd)) {
    throw new SubagentError(`subagent cwd must be an absolute path: ${cwd}`, 'INVALID_CWD')
  }
  if (!existsSync(cwd)) {
    throw new SubagentError(`subagent cwd does not exist: ${cwd}`, 'INVALID_CWD')
  }
}
