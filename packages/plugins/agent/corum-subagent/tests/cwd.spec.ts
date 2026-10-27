/**
 * fork（corum）cwd 透传单测：
 *   1. childSessionMeta — cwd 显式值优先、缺省继承父、父子皆无则不带键；
 *   2. assertChildCwd — 相对路径/不存在目录抛 INVALID_CWD，undefined 放行。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { childSessionMeta } from '../src/child-agent.ts'
import { assertChildCwd } from '../src/depth.ts'
import { SubagentError } from '../src/error.ts'

function parentAgent(cwd?: string): Agent {
  const id = SessionId('parent')
  const session = Session.create(id)
  if (cwd !== undefined) {
    // Session.create 的 header 只带 id/createdAt——直接构造 header 形态。
    ;(session as { header: unknown }).header = { ...session.header, cwd }
  }
  // childSessionMeta 读 parent.ctx.get('agentPresets')——桩一个无 preset 的 ctx。
  const ctx = { get: () => undefined }
  return { id, options: {}, session, ctx } as unknown as Agent
}

const scratch = mkdtempSync(join(tmpdir(), 'corum-subagent-cwd-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

describe('childSessionMeta — fork（corum）cwd 透传', () => {
  it('缺省继承父会话 cwd（官方行为不变；cwd 由 manager.resolveDirectory 处理）', () => {
    const meta = childSessionMeta(parentAgent('/parent/dir'), 1, false)
    expect(meta.cwd).toBe('/parent/dir')
    expect(meta.parentSession).toBe('parent')
    expect(meta.delegationDepth).toBe(1)
  })

  it('父子皆无 cwd 时 meta 不带 cwd 键', () => {
    const meta = childSessionMeta(parentAgent(), 1, false)
    expect('cwd' in meta).toBe(false)
  })
})

describe('assertChildCwd — fork（corum）校验', () => {
  it('undefined 放行', () => {
    expect(() => assertChildCwd(undefined)).not.toThrow()
  })

  it('相对路径抛 INVALID_CWD', () => {
    expect(() => assertChildCwd('relative/dir')).toThrowError(SubagentError)
    expect(() => assertChildCwd('relative/dir')).toThrowError(/absolute path/)
  })

  it('不存在的绝对路径抛 INVALID_CWD', () => {
    const missing = join(scratch, 'no-such-dir')
    expect(() => assertChildCwd(missing)).toThrowError(SubagentError)
    expect(() => assertChildCwd(missing)).toThrowError(/does not exist/)
  })

  it('已存在的绝对路径放行', () => {
    expect(() => assertChildCwd(scratch)).not.toThrow()
  })
})
