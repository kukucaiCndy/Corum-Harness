/**
 * fork（corum）提示词 ↔ 机制对账（2026-09-15 提示词承诺修复轮）。
 *
 * 为什么需要：`corumSandboxEscalationLines` / `corumSchedulingDescription` /
 * `corumSchedulingSectionText` / `corumRunInBackgroundDescription` 都是模型可见文本，
 * 它们描述的「通路」必须在机制里真实存在——否则就是向模型承诺了一条不存在的路。
 * 本 spec 把「描述说的是机制里有的」变成可执行断言：每条描述锚点都对照一个机制
 * 守卫/拒绝路径，锚点一断就先红。工具名也必须随实例插值——同一段文本服务
 * `subagent` / `subagent_research` / `subagent_fork` 多个实例，写死任一个就会指错工具。
 *
 * 覆盖边界：只钉住本 spec 列出的通路描述与它各自的机制锚点，不做语义等价证明。
 * 实机装配仍由 CDP 取证。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  corumSchedulingDescription,
  corumSchedulingSectionText,
  corumRunInBackgroundDescription,
} from '../src/index.ts'
// 2026-09-27：两块执行纪律已下沉到 @corum/corum-orchestration（本包不再持有）。
import { corumSandboxEscalationLines } from '@corum/corum-orchestration'

const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')

// Mechanism anchor sources (read at test time, not imported — byte-level check).
const CHILD_AGENT_SRC = readFileSync(
  join(import.meta.dirname, '../../corum-subagent/src/child-agent.ts'),
  'utf8',
)
// fork（corum）2026-09-26：提权应答器——「重试会被裁决」那句提示词的机制锚点。
const ESCALATION_ANSWERER_SRC = readFileSync(
  join(import.meta.dirname, '../../corum-subagent/src/escalation-answerer.ts'),
  'utf8',
)
const COMPILE_SRC = readFileSync(
  join(import.meta.dirname, '../../corum-agent/src/compile.ts'),
  'utf8',
)

describe('块 1 · 例1 沙箱升级 — 子会话无弹窗的分岔承诺', () => {
  const text = corumSandboxEscalationLines().join('\n')

  it('子会话分岔条目存在：DELEGATED CHILD + 重试会被裁决 + 硬上限不可加宽 + report as conclusion', () => {
    // 2026-09-26：本条由「子会话提权必被拒」改aim为「子会话提权会被裁决」。
    // 改动的**判据**是机制真的变了（child-agent.ts 的 approvalPolicy 由 never 改成 ask
    // + 装了 escalation-answerer），不是为了让测试变绿 —— 见下方「机制锚点」。
    expect(text).toContain('DELEGATED CHILD session')
    expect(text).toContain('the retry IS adjudicated')
    // 2026-09-27：**主仓目标连卡都不出**（用户裁定「子 Agent 不能操作除自己 worktree 之外的
    // 其它分支（可读）…这一类无法提权获得」）。措辞必须与机制一致，否则子 Agent 会一直等
    // 一张永远不会出现的卡（实测代价：会话 corum-task-56b7d485 反复重试同一类命令）。
    expect(text).toContain('refused without any prompt')
    // 2026-09-27（审查员 C 4.1 + A 的 F2(ii)）：旧句 'a read-only or isolated scope stays as-is' 与机制不符
    // —— 隔离**不是**档位天花板（hardCeilingFor 仅 pinReadOnly 收窄）；不变的是**按路径**的写边界。
    expect(text).toContain('a READ-ONLY scope can never widen')
    expect(text).toContain('its write boundary is by PATH')
    expect(text).toContain('report it as a conclusion')
    // 旧的（现已为假的）承诺必须消失。
    expect(text).not.toContain('pinned to `never`')
    expect(text).not.toContain('no approval prompt is reachable')
  })

  it('主会话那句带条件：approval policy is ask（不再是无条件承诺）', () => {
    expect(text).toContain('approval policy is `ask`')
  })

  it('旧的无条件承诺已消失', () => {
    expect(text).not.toContain('The approval prompt raised by that retry is how the user consents')
  })

  it('禁止改写成「向主 Agent 请求提权」（防回潮）', () => {
    const banned = [
      /ask the parent/i,
      /notify the parent/i,
      /request (?:escalation|permission) from the parent/i,
      /parent (?:can|will) (?:widen|approve)/i,
      /tell the parent to ask/i,
    ]
    for (const re of banned) {
      expect(text, `banned parent-escalation phrasing: ${String(re)}`).not.toMatch(re)
    }
  })

  // Mechanism anchor: this is the tripwire that fired on 2026-09-26 when the child
  // gained an approval path. It now pins the NEW truth pair: the child policy is
  // seeded `ask` AND the mechanism-side answerer exists to adjudicate it.
  it('机制锚点：child-agent.ts 把子会话 approvalPolicy 播种为 ask（而非 never）', () => {
    expect(CHILD_AGENT_SRC).toContain("approvalPolicy: parent.ctx.get('approval') === undefined ? undefined : 'ask'")
    expect(CHILD_AGENT_SRC).not.toContain("undefined : 'never'")
  })

  it('机制锚点：提权应答器存在（ask 必须有应答者，否则等于把旧承诺换成新幻象）', () => {
    // 提示词说「重试会被裁决」⇒ 机制里必须真有裁决者。缺了它，ask 策略下子会话的
    // 请求会落到 fail-closed 的 unavailable，那句话就又变成假的。
    // 2026-09-29：0.1.5 升级后 `installEscalationAnswerer` 增加 `childAgent` 形参
    //（官方 0.1.5 删除 `ctx.agent` accessor，改由 setup 第二参传入）⇒ 锚点同步。
    expect(CHILD_AGENT_SRC).toContain('installEscalationAnswerer(childCtx, childAgent, {')
    expect(ESCALATION_ANSWERER_SRC).toContain('decideEscalation({ requested: request.mode')
  })

  it('保留性断言：原有三条仍在线', () => {
    expect(text).toContain('retry the exact same command once, in the same turn')
    expect(text).toContain('sandbox_permissions')
    expect(text).toContain('narrowest wider mode that suffices')
    expect(text).toContain('never speculatively')
    expect(text).toContain('A rejected escalation is final for that command')
  })
})

describe('块 2 · 例2 research 恒前台（描述 + 机制段 + 拒绝路径三处对齐）', () => {
  const researchDesc = corumSchedulingDescription({ backgroundEnabled: true, continuable: true, readonlyResearch: true })
  const workerDesc = corumSchedulingDescription({ backgroundEnabled: true, continuable: true, readonlyResearch: false })
  const researchSection = corumSchedulingSectionText({ backgroundEnabled: true, continuable: true, readonlyResearch: true }, 'subagent_research', '')
  const workerSection = corumSchedulingSectionText({ backgroundEnabled: true, continuable: true, readonlyResearch: false }, 'subagent', '')

  it('research 描述：恒前台 + 拒绝后台', () => {
    expect(researchDesc).toContain('ALWAYS runs in the FOREGROUND')
    expect(researchDesc).toContain('Do NOT pass `run_in_background: true` (it is rejected)')
    expect(researchDesc).not.toContain('background by default')
  })

  it('worker 描述：后台默认（不误伤）', () => {
    expect(workerDesc).toContain('background by default')
    expect(workerDesc).not.toContain('ALWAYS runs in the FOREGROUND')
  })

  it('research 机制段文本：非空 + 恒前台 + 拒绝后台', () => {
    expect(researchSection).not.toBe('')
    expect(researchSection).toContain('ALWAYS runs in the FOREGROUND')
    expect(researchSection).toContain('Do NOT pass `run_in_background: true` (it is rejected)')
  })

  it('PTC 前缀仍生效', () => {
    expect(corumSchedulingSectionText({ backgroundEnabled: true, continuable: true, readonlyResearch: true }, 'subagent_research', 'PTC ')).toMatch(/^PTC /)
  })

  it('worker 机制段：含后台默认', () => {
    expect(workerSection).toContain('in the background by default')
  })

  // Dead-code shape: the old guard `backgroundEnabled && continuable && !corumReadonlyResearch`
  // excluded research from registering its section — that made the research branch dead.
  // The new guard lets research register `tool:subagent_research`.
  it('死代码形状钉死：旧守卫已消失，新守卫已就位', () => {
    expect(SRC).not.toContain('backgroundEnabled && continuable && !corumReadonlyResearch')
    expect(SRC).toContain('if (corumReadonlyResearch || (backgroundEnabled && continuable))')
  })

  // Wiring: ensure the test exercises the function that's actually called, not an orphan.
  it('接线断言：描述块与机制段都调用纯函数', () => {
    expect(SRC).toContain('corumSchedulingDescription({')
    expect(SRC).toContain('corumSchedulingSectionText({')
    expect(SRC).toContain('corumRunInBackgroundDescription({')
  })

  // Mechanism anchor: the throw that backs the "it is rejected" claim.
  it('拒绝路径锚点：throw run_in_background is not supported for read-only research', () => {
    expect(SRC).toContain('run_in_background is not supported for read-only research')
  })
})

// 防写死回潮：同一段机制段文本服务 subagent / subagent_research / subagent_fork 三个实例，
// worker 分支的「Use <toolName> in the background by default」必须随实例 toolName 插值。
// 若 ${toolName} 被写死成字面量 subagent，fork 实例的机制段会指错工具名（模型手里叫 subagent_fork）。
describe('块 2b · 段内工具名随实例', () => {
  it('subagent_fork 实例：机制段含「Use subagent_fork in the background by default」', () => {
    const text = corumSchedulingSectionText({ backgroundEnabled: true, continuable: true, readonlyResearch: false }, 'subagent_fork', '')
    expect(text).toContain('Use subagent_fork in the background by default')
  })

  it('subagent 实例：机制段含「Use subagent in the background by default」且不含 subagent_fork（防写死回潮）', () => {
    const text = corumSchedulingSectionText({ backgroundEnabled: true, continuable: true, readonlyResearch: false }, 'subagent', '')
    expect(text).toContain('Use subagent in the background by default')
    expect(text).not.toContain('subagent_fork')
  })

  it('research 分支不含后台默认措辞（插值不能让 research 回到后台句）', () => {
    const text = corumSchedulingSectionText({ backgroundEnabled: true, continuable: true, readonlyResearch: true }, 'subagent_research', '')
    expect(text).not.toContain('in the background by default')
  })
})

describe('块 3 · 参数面 — run_in_background 描述对齐', () => {
  it('research 实例：不含 Defaults to true；含 omit it', () => {
    const param = corumRunInBackgroundDescription({ continuable: true, readonlyResearch: true })
    expect(param).not.toContain('Defaults to true')
    expect(param).toContain('omit it')
  })

  it('worker 实例：含 Defaults to true（不误伤）', () => {
    const param = corumRunInBackgroundDescription({ continuable: true, readonlyResearch: false })
    expect(param).toContain('Defaults to true')
  })
})

/**
 * 模型可见的通路描述 ↔ 机制锚点。新增任何写进工具 description / 机制段 / 派单模板的
 * 通路描述时，在这里加一行（描述来源文件 + 描述锚点字符串 + 机制锚点所在文件 + 机制锚点字符串），
 * 让「提示词说的通路在机制里存在」变成可执行对账，而不是一次性人工复核。
 *
 * `claim` 字段 = 被断言必须存在的描述锚点字符串；
 * `source` = 描述来源文件（已读入的源码文本变量）；
 * `mechanism` = 机制锚点来源文件（同上）；
 * `mechanismAnchor` = 机制锚点字符串。
 */
const CLAIMS: ReadonlyArray<{
  readonly claim: string
  readonly source: string
  readonly sourceName: string
  readonly mechanism: string
  readonly mechanismName: string
  readonly mechanismAnchor: string
}> = [
  // ① 沙箱升级：子会话的重试会被**裁决**（2026-09-26 改aim；机制锚点 = 子会话策略 seed 为
  //    ask + 提权应答器确实存在）
  {
    claim: 'the retry IS adjudicated',
    source: corumSandboxEscalationLines().join('\n'),
    sourceName: 'corumSandboxEscalationLines()',
    mechanism: CHILD_AGENT_SRC,
    mechanismName: 'corum-subagent/src/child-agent.ts',
    mechanismAnchor: 'installEscalationAnswerer(childCtx, childAgent, {',
  },
  // ④ 主仓目标的提权**连卡都不出**（2026-09-27 用户裁定「不可提权获得」；机制锚点 =
  //    应答器复用隔离门禁的同一判定后直接判 refuse 的那一支）
  {
    claim: 'refused without any prompt',
    source: corumSandboxEscalationLines().join('\n'),
    sourceName: 'corumSandboxEscalationLines()',
    mechanism: ESCALATION_ANSWERER_SRC,
    mechanismName: 'corum-subagent/src/escalation-answerer.ts',
    mechanismAnchor: "reason: 'parent-tree'",
  },
  // fork（corum）2026-10-22：orchestrate script 模式已移除（彻底独立），
  // 钩子签名断言不再适用——orchestrate 不再暴露 agent()/parallel()/pipeline() 等
  // workflow 引擎钩子给 LLM。
  // ② research 恒前台 / 拒绝后台（描述说「it is rejected」，机制锚点是 index.ts 的 throw）
  {
    claim: 'Do NOT pass `run_in_background: true` (it is rejected)',
    source: corumSchedulingDescription({ backgroundEnabled: true, continuable: true, readonlyResearch: true }),
    sourceName: 'corumSchedulingDescription(research)',
    mechanism: SRC,
    mechanismName: 'corum-tool-subagent/src/index.ts',
    mechanismAnchor: 'run_in_background is not supported for read-only research',
  },
  // ③ research 只读工具面：write/edit are denied / sandbox read-only
  //   （描述说「write/edit are denied」，机制锚点是 compile.ts research 分支的 readonlyResearch = true + toolFilter deny）
  {
    claim: 'write/edit are denied',
    source: SRC,
    sourceName: 'corum-tool-subagent/src/index.ts (工具描述决策点文本)',
    mechanism: COMPILE_SRC,
    mechanismName: 'corum-agent/src/compile.ts',
    mechanismAnchor: 'config.readonlyResearch = true',
  },
]

describe('块 4 · 可复用收口 — 通路描述 ↔ 机制锚点对账', () => {
  for (const c of CLAIMS) {
    it(`${c.sourceName} 含「${c.claim}」且 ${c.mechanismName} 含锚点「${c.mechanismAnchor.slice(0, 60)}…」`, () => {
      expect(c.source, `claim missing in ${c.sourceName}`).toContain(c.claim)
      expect(c.mechanism, `anchor missing in ${c.mechanismName}`).toContain(c.mechanismAnchor)
    })
  }
})
