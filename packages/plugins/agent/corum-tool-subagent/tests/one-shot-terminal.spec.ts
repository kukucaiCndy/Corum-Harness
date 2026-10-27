/**
 * fork（corum）2026-09-26：**前台一次性子 Agent 是终态** —— 提示词/通知不得承诺一条
 * 机制里不存在的通路。
 *
 * ## 由来（实机报障，会话 `corum-task-ef3f751e`，硬证据）
 *
 * | 行 | 事件 |
 * |---|---|
 * | 66 | `subagent { run_in_background: false, description: "抢救孤儿改动并清理工作树" }` |
 * | 68 | 子 Agent settle：`Subagent bca632cd-… finished … — final report:`（机制注入的结算通知） |
 * | 81 | 主 Agent 调 `send_message`，目标正是 `bca632cd-…`（想「授权它继续执行步骤 1」） |
 * | 82 | **被拒**：`subagent "bca632cd-…" has no supported continuation state and cannot be resumed` |
 *
 * ## 根因（模型可见文本只讲了一半）
 *
 * `subagent` 实例的 `backgroundMode` 是 `continuable`，于是工具描述与机制段都无条件写着
 * 「`send_message` … starts a turn while it is idle」——**没有限定这只对后台子 Agent 成立**。
 * 而 `run_in_background: false` 走 `ctx.subagents.start()`（官方 one-shot 契约：子会话不驻留）
 * ⇒ 天生不可续接。白烧一次往返，且「授权继续」这个意图完全没送达。
 *
 * ## 本 spec 钉住的判据
 *
 * ① 三个决策点文本都要点明「前台一次性 = 终态、`send_message` 够不到」；
 * ② 结算通知（子 Agent 刚结束时模型最可能读到的那条）也要说 —— 实测 id 正是从这里被拿走的；
 * ③ **不能只否定**：必须给出可执行的替代路径（重新委派并交接上下文 / 下次用后台）；
 * ④ 后台语义**不被误伤**：`send_message` 对 continuable 仍然有效（不许改成「send_message 没用」）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  corumForegroundSettlementText,
  corumOneShotTerminalLine,
  corumRunInBackgroundDescription,
  corumSchedulingDescription,
  corumSchedulingSectionText,
} from '../src/index.ts'

const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')

/** 一眼判定「这句话点明了前台一次性不可续接」。 */
const TERMINAL_PATTERN = /foreground[\s\S]{0,120}?(one-shot|TERMINAL)/i

describe('① 决策点文本：前台一次性是终态（三个模型可见面）', () => {
  it('工具描述（continuable 实例）不再无条件承诺「send_message 能唤醒空闲子 Agent」', () => {
    const desc = corumSchedulingDescription({ backgroundEnabled: true, continuable: true, readonlyResearch: false })
    // 原有的后台能力描述必须保留（不能误伤）。
    expect(desc).toContain('keeps the child conversation available for later turns')
    expect(desc).toContain('starts a turn while it is idle')
    // 新增：前台一次性是终态。
    expect(desc).toMatch(TERMINAL_PATTERN)
    expect(desc).toContain('TERMINAL')
    expect(desc).toContain('send_message')
  })

  it('机制段文本（`tool:${toolName}`）同样点明终态', () => {
    const section = corumSchedulingSectionText({ backgroundEnabled: true, continuable: true, readonlyResearch: false }, 'subagent', '')
    expect(section).toMatch(TERMINAL_PATTERN)
    expect(section).toContain('TERMINAL')
    // 后台仍然可续（不被误伤）。
    expect(section).toContain('When a background run settles')
  })

  it('`run_in_background` 参数描述点明「false ⇒ 一次性、事后无法 send_message」', () => {
    const d = corumRunInBackgroundDescription({ continuable: true, readonlyResearch: false })
    expect(d).toContain('Defaults to true')
    expect(d).toMatch(/one-shot/i)
    expect(d).toContain('TERMINAL')
    expect(d).toContain('send_message')
  })

  it('research 实例的描述不被这次改动影响（恒前台、拒绝后台）', () => {
    const research = corumRunInBackgroundDescription({ continuable: true, readonlyResearch: true })
    expect(research).toContain('always runs in the foreground')
    expect(research).not.toContain('TERMINAL')
    const rs = corumSchedulingDescription({ backgroundEnabled: true, continuable: true, readonlyResearch: true })
    expect(rs).toContain('ALWAYS runs in the FOREGROUND')
  })

  it('机制段的「BACKGROUND subagent」指引行限定 send_message 的适用范围', () => {
    // 这一行此前只说「用 send_message 追踪/续接」，未限定后台。
    expect(SRC).toContain('`send_message` reaches BACKGROUND (continuable) children only')
  })
})

describe('② 结算通知：子 Agent 刚结束时告知不可续接', () => {
  it('★ 通知含汇报 + 终态事实（实测 id 正是从这里被拿去 send_message 的）', () => {
    const { summary, blocks } = corumForegroundSettlementText('bca632cd', '抢救孤儿改动', '两个硬阻断，未执行任何破坏性操作。', 'subagent')
    expect(summary).toBe('Subagent bca632cd finished (抢救孤儿改动) — final report:')
    expect(blocks[0]).toBe(summary)
    expect(blocks[1]).toBe('两个硬阻断，未执行任何破坏性操作。')
    // 关键：第三条是机制事实，且点明「不能续接」。
    expect(blocks[2]).toContain('NOTE:')
    expect(blocks[2]).toContain('TERMINAL')
    expect(blocks[2]).toContain('send_message')
  })

  it('没留收尾话时也照样告知（不发散成静默）', () => {
    const { blocks } = corumForegroundSettlementText('id-1', 'lab', '', 'subagent')
    expect(blocks[1]).toBe('It left no closing message.')
    expect(blocks[2]).toContain('TERMINAL')
  })

  it('工具名随实例插值（不写死 subagent，否则 subagent_fork 会指错工具）', () => {
    const { blocks } = corumForegroundSettlementText('id-1', 'lab', 'r', 'subagent_fork')
    expect(blocks[2]).toContain('subagent_fork')
    expect(blocks[2]).not.toContain('via subagent)')
  })
})

describe('③ 不只否定：给出可执行的替代路径', () => {
  const line = corumOneShotTerminalLine('subagent')

  it('说清「要带着上下文继续」该怎么办（重新委派 / 下次用后台）', () => {
    expect(line).toMatch(/delegate a fresh child/i)
    expect(line).toMatch(/background/i)
  })

  it('不许只留一句「cannot be resumed」而没有下一步', () => {
    expect(line).not.toBe('You cannot send_message to a foreground child.')
    expect(line.length).toBeGreaterThan(120)
  })
})

describe('④ 机制锚点：官方的拒绝路径确实存在（文本没在描述幻象）', () => {
  const MANAGER = readFileSync(
    join(import.meta.dirname, '../../corum-subagent/src/manager.ts'),
    'utf8',
  )

  it('一次性（非 continuable）子会话被拒且错误码是 NOT_RESUMABLE', () => {
    expect(MANAGER).toContain("descriptor.mode !== 'continuable'")
    expect(MANAGER).toContain('has no supported continuation state and cannot be resumed')
    expect(MANAGER).toContain("'NOT_RESUMABLE'")
  })

  it('前台路径走的是 one-shot startActivation（delivery: caller）——这正是它不可续的原因', () => {
    // fork（corum）2026-10-22：start/startContinuable 已统一为 startActivation。
    // 前台 one-shot: delivery:'caller'（settleForegroundRun 收结果后 dispose）
    // 后台 continuable: delivery:'parent'（startActivation 返回 childId，manager 负责通知）
    expect(SRC).toContain("runtimeCtx.subagents.startActivation({")
    expect(SRC).toContain("delivery: 'caller'")
    expect(SRC).toContain("delivery: 'parent'")
  })

  it('结算通知只在**前台**成功路径注入（后台走 subagent/end 的另一套）', () => {
    const idx = SRC.indexOf('corumNotifyForegroundResult(parent, settledRunId')
    expect(idx).toBeGreaterThan(-1)
    // 传了 toolName（措辞随实例插值）。
    expect(SRC.slice(idx, idx + 120)).toContain('toolName')
  })
})
