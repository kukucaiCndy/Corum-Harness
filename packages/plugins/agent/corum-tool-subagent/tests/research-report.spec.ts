/**
 * fork（corum）2026-10 修复③（B 方案）：**单个 research 子 Agent 的报告落盘**。
 *
 * 用户需求：把「报告留存」语义扩展到**单个** research 子 Agent（`subagent_research`，
 * 只读）。它的一次性前台 settle 之后会话就销毁（#75），结论若没被及时用上就丢了。
 *
 * B 方案（用户已拍板）：**小结果直接回全文，大结果落盘给路径**——
 *   · 正文 ≤ 6000 字符 ⇒ 照回全文 + 附带报告路径；
 *   · 正文 > 6000 字符 ⇒ 回「摘要 + 报告路径引用」，正文只在盘上
 *     （避免撞 #100 的 8192 pruner 截断，那会把正文腰斩）。
 *
 * 本 spec 测**纯函数**（`corumResearchReportDelivery`）：落盘路径、溯源信息、阈值分流、
 * 落盘失败不抛。接线面（spawnOne 里在 settle 后调用它）由源码面断言钉住。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { corumResearchReportDelivery } from '../src/index.ts'

const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')

/** 每个用例造一个独立临时 CORUM_HOME（阅后即焚，测完删）。 */
const homes: string[] = []
const makeHome = (): string => {
  const dir = join(tmpdir(), `corum-research-spec-${process.pid}-${Date.now()}-${homes.length}`)
  homes.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NOW = new Date('2026-10-20T10:00:00.000Z')

describe('corumResearchReportDelivery — 小结果照回全文 + 附带路径', () => {
  it('★ 正文全文回传，且报告落盘到 <CORUM_HOME>/research-reports/<childSessionId>.md', () => {
    const home = makeHome()
    const body = '结论：没有死代码。证据：rg 无命中。'
    const delivery = corumResearchReportDelivery({
      childSessionId: 'corum-task-res1',
      label: '死代码调研',
      report: body,
      now: NOW,
      env: { CORUM_HOME: home } as NodeJS.ProcessEnv,
    })
    expect(delivery.reportPath).toBe(join(home, 'research-reports', 'corum-task-res1.md'))
    expect(delivery.written).toBe(true)
    expect(delivery.truncated).toBe(false)
    // 小结果：全文照回（不是摘要）。
    expect(delivery.text).toContain(body)
    expect(delivery.text).toContain(delivery.reportPath)
    // 盘上那份带**溯源信息**（会话 id / 父任务 / 时间）——脱离溯源的结论事后无法复核。
    const onDisk = readFileSync(delivery.reportPath, 'utf8')
    expect(onDisk).toContain('corum-task-res1')
    expect(onDisk).toContain('死代码调研')
    expect(onDisk).toContain(NOW.toISOString())
    expect(onDisk).toContain(body)
  })

  it('★ 阈值边界：恰好 6000 字符仍走「全文」档（含边界）', () => {
    const home = makeHome()
    const body = 'x'.repeat(6000)
    const delivery = corumResearchReportDelivery({
      childSessionId: 'corum-task-res2',
      label: 'boundary',
      report: body,
      now: NOW,
      env: { CORUM_HOME: home } as NodeJS.ProcessEnv,
    })
    expect(delivery.truncated).toBe(false)
    expect(delivery.text).toContain(body)
    expect(delivery.text).not.toContain('truncated:')
  })
})

describe('corumResearchReportDelivery — 大结果落盘 + 回摘要引用（B 方案）', () => {
  it('★★ 正文 > 6000 字符 ⇒ 回摘要 + 路径引用，正文全文只在盘上', () => {
    const home = makeHome()
    const body = `HEAD-${'y'.repeat(6001)}-TAIL`
    const delivery = corumResearchReportDelivery({
      childSessionId: 'corum-task-res3',
      label: '大调研',
      report: body,
      now: NOW,
      env: { CORUM_HOME: home } as NodeJS.ProcessEnv,
    })
    expect(delivery.written).toBe(true)
    expect(delivery.truncated).toBe(true)
    // 回传是**摘要**：带截断标记 + 路径引用，且不含尾部（全文不在结果里）。
    expect(delivery.text).toContain('truncated:')
    expect(delivery.text).toContain(delivery.reportPath)
    expect(delivery.text).not.toContain('-TAIL')
    // 回传体积必须仍在 pruner 阈值（8192）以内——这正是阈值取 6000 的理由。
    expect(delivery.text.length).toBeLessThan(8192)
    // 全文在盘上（tail 也在）。
    expect(readFileSync(delivery.reportPath, 'utf8')).toContain('-TAIL')
  })
})

describe('corumResearchReportDelivery — 落盘失败不抛（正文仍是交付物）', () => {
  it('★ 不可写 CORUM_HOME ⇒ written=false，正文照旧回传，并如实说明没存下来', () => {
    // 「父级是个普通文件」⇒ 其下建目录必失败。**不用 `/dev/null`**：那是 POSIX 专属，
    // Windows 上没有它，mkdir 会真的把 `\dev\null\never` 建出来 ⇒ written=true（假红）。
    const blockedFile = join(makeHome(), 'not-a-dir')
    mkdirSync(join(blockedFile, '..'), { recursive: true })
    writeFileSync(blockedFile, 'this is a file, not a directory')
    const delivery = corumResearchReportDelivery({
      childSessionId: 'corum-task-res4',
      label: 'x',
      report: '正文',
      now: NOW,
      env: { CORUM_HOME: join(blockedFile, 'never') } as NodeJS.ProcessEnv,
    })
    expect(delivery.written).toBe(false)
    expect(delivery.text).toContain('正文')
    expect(delivery.text).toContain('could NOT be saved')
  })

  it('空正文 ⇒ 不落盘、回「没留收尾话」（不是凭空造一份空报告）', () => {
    const home = makeHome()
    const delivery = corumResearchReportDelivery({
      childSessionId: 'corum-task-res5',
      label: 'x',
      report: '   ',
      now: NOW,
      env: { CORUM_HOME: home } as NodeJS.ProcessEnv,
    })
    expect(delivery.written).toBe(false)
    expect(delivery.text).toContain('left no closing message')
  })
})

describe('修复③的接线面（源码断言）', () => {
  it('★ 落点在 spawnOne 的前台 settle 之后，且只对 research + 主 Agent 可见的结果生效', () => {
    // 落盘由机制做（research 子 Agent 只读，写不了盘）。
    expect(SRC).toContain('const researchDelivery = effReadonlyResearch && args.notifyParent !== false')
    expect(SRC).toContain('corumResearchReportDelivery({')
    // orchestrate 的任务与 closer 传 notifyParent:false ⇒ 它们的正文另有去向（交给 closer），
    // 绝不能在 research 落盘路径上被阈值截断。
    expect(SRC).toContain('notifyParent: false')
  })

  it('★ 回传形态变了就必须同步 output schema（additionalProperties:false 会吞掉整个结果）', () => {
    expect(SRC).toContain('reportPath: { type: \'string\' }')
  })

  it('阈值 6000 与编排 script.value 同量级（同一个产品里不出现两条「大」标准）', () => {
    expect(SRC).toContain('const CORUM_RESEARCH_INLINE_LIMIT = 6000')
    expect(SRC).toContain('const CORUM_ORCHESTRATE_SCRIPT_VALUE_LIMIT = 6000')
  })
})
