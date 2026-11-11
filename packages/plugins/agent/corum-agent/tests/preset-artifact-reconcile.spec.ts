/**
 * 启动期产物对账（`reconcileAgentDirs`）——「切换 Agent 失败」的根治面回归网。
 *
 * ## 这个测试钉的是什么事故（2026-11-11，用户报障「切换 Agent 会失败」）
 *
 * 报障原文（真机 :9333 复现，逐字一致）：
 * ```
 * agent-preset/invalid: tool-subagent (@corum/corum-tool-subagent): config.backgroundMode is removed
 *   … tool-subagent-research … workflow-worker-thread: never started
 * ```
 *
 * 根因是**派生数据比编译器旧**：`agent.cordis.yml` 由编译期生成，而编译器随版本演进把
 * `tool-subagent` 的 `config.backgroundMode` 删了（后台统一 `delivery:'parent'`）。老安装盘上
 * 留着的产物仍是旧 schema ⇒ 行构造期抛错 ⇒ 整个 preset 挂不上。registry 注册读的正是盘上
 * 产物，所以启动时不对账就永远坏在那里。
 *
 * 三个判据（对应三条缺陷）：
 *   ① 旧 schema 产物在启动对账后被**当前编译器**的产物替换（不再含 `backgroundMode`）；
 *   ② 产物缺席（只删了 `agent.cordis.yml` / 只有 `agent.json`）也会被补齐；
 *   ③ 内容已一致时**不写盘**（幂等：反复启动不应反复触碰 mtime、不应制造变更噪音）。
 *
 * @module @corum/corum-agent/tests/preset-artifact-reconcile
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compilePreset } from '../src/compile.ts'
import { reconcileAgentDirs } from '../src/profile-compiler.ts'
import type { AgentProfile } from '../src/profile.ts'

/** 造一个最小可编译的 profile（写进临时 home 的 agent.json 时用的是同一份）。 */
function profile(id: string): AgentProfile {
  return {
    id,
    baseMode: 'standard',
    prompt: `Reconcile test agent ${id}`,
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
}

/** 一个 Agent 目录（`<home>/.agent-presets/<id>`）。 */
function agentDir(home: string, id: string): string {
  return join(home, '.agent-presets', id)
}

/** 用指定内容造一个「已存在的 Agent 目录」（`agent.json` 是 profile 的事实源）。 */
function seedAgent(home: string, id: string): string {
  const dir = agentDir(home, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.json'), JSON.stringify(profile(id), null, 2))
  return dir
}

/** 收集 warn 的 logger 桩（reconcile 只用到 warn）。 */
function makeLogger(): { warn: (message: string, ...rest: readonly unknown[]) => void; messages: string[] } {
  const messages: string[] = []
  return {
    messages,
    warn: (message: string): void => { messages.push(message) },
  }
}

/** 反应「旧编译器产物」的 agent.cordis.yml：带已删除的 `tool-subagent.config.backgroundMode`。 */
const STALE_PRESET_YML = [
  '- id: persona',
  "  name: \"@deepseek-ai/dsh-persona\"",
  '  config:',
  '    prefix: "You are a coding agent."',
  '',
  '- id: tool-subagent',
  "  name: \"@corum/corum-tool-subagent\"",
  '  config:',
  '    provider: "corum-spawn"',
  '    toolName: "subagent"',
  '    backgroundMode: "continuable"',
  '',
].join('\n')

describe('reconcileAgentDirs（启动期产物对账）', () => {
  let home: string
  let oldCorumHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'corum-reconcile-'))
    oldCorumHome = process.env.CORUM_HOME
    process.env.CORUM_HOME = home
  })

  afterEach(() => {
    if (oldCorumHome !== undefined) process.env.CORUM_HOME = oldCorumHome
    else delete process.env.CORUM_HOME
    if (existsSync(home)) rmSync(home, { recursive: true, force: true })
  })

  it('① 旧 schema 产物被当前编译器产物替换（不再含 backgroundMode）', () => {
    const id = 'stale-agent'
    const dir = seedAgent(home, id)
    writeFileSync(join(dir, 'agent.cordis.yml'), STALE_PRESET_YML)
    writeFileSync(join(dir, 'preset.yml'), 'name: stale-agent\n')

    const logger = makeLogger()
    const result = reconcileAgentDirs(logger)

    expect(result.rewritten).toContain(id)
    const rewritten = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')
    expect(rewritten).not.toContain('backgroundMode')
    // 逐字节等于当前编译器的产物（不是「看起来差不多」）
    expect(rewritten).toBe(compilePreset(profile(id)).cordisYml)
    expect(logger.messages).toHaveLength(0)
  })

  it('② 只有 agent.json（产物缺席）也会被补齐', () => {
    const id = 'never-compiled'
    const dir = seedAgent(home, id)
    expect(existsSync(join(dir, 'agent.cordis.yml'))).toBe(false)

    const result = reconcileAgentDirs(makeLogger())

    expect(result.rewritten).toContain(id)
    expect(readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')).toBe(compilePreset(profile(id)).cordisYml)
    expect(existsSync(join(dir, 'preset.yml'))).toBe(true)
  })

  it('③ 内容已一致 ⇒ 不写盘（幂等，mtime 不变）', () => {
    const id = 'fresh-agent'
    const dir = seedAgent(home, id)
    reconcileAgentDirs(makeLogger())
    const before = statSync(join(dir, 'agent.cordis.yml')).mtimeMs

    const second = reconcileAgentDirs(makeLogger())

    expect(second.rewritten).toHaveLength(0)
    expect(statSync(join(dir, 'agent.cordis.yml')).mtimeMs).toBe(before)
  })

  it('④ 单个 profile 写不进去不拖垮其余（warn 带 id，其余照常重编）', () => {
    // 让写盘必失败：`agent.cordis.yml` 这个位置上是一个**目录**（EISDIR/EEXIST 形态之一，
    // 对应实测里「产物被别的东西占了位置」这类脏状态）。
    const brokenId = 'broken-agent'
    const brokenDir = seedAgent(home, brokenId)
    mkdirSync(join(brokenDir, 'agent.cordis.yml'))
    const okId = 'healthy-agent'
    seedAgent(home, okId)

    const logger = makeLogger()
    const result = reconcileAgentDirs(logger)

    expect(result.rewritten).toContain(okId)
    expect(result.failed.join('\n')).toContain(brokenId)
    expect(logger.messages.join('\n')).toContain(brokenId)
  })
})