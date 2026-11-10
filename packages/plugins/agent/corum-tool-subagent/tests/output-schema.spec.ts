/**
 * `subagent` 工具 **output schema ↔ 实际返回形态** 的行为回归网。
 * （main 3b53ffb6 的 rc3 适配重放：oneOf 已是两分支——activation / foreground。）
 *
 * ## 为什么必须补这一条（用户 2026-11-07 实机报障，第三次同一形态）
 *
 * 现象：每次前台委派都失败，父 Agent 只看到
 * `tool "subagent" returned invalid output: "value" must match exactly one oneOf
 * branch (matched 0)`，子 Agent 的正文**整份丢失**。
 *
 * 根因：`spawnOne` 在路由解析成功时会往结果里挂 `spawnModel`（issue #157，
 * 2026-10-28 加的），但 output schema 的 foreground 分支是
 * `additionalProperties: false`、没声明这个字段 ⇒ 分支全不匹配 ⇒ matched 0。
 * 前两次同形态的学费：`rejected`（2026-09-16）、`integration.report`（2026-09-27）。
 *
 * ## 为什么是"真跑校验器"而不是源码文本断言
 *
 * 文本断言只能证明"某段字符串还在"，证明不了"返回对象能通过校验"。这里走的是与
 * 运行时**同一条链路**：`valueSchemaSpecToJsonSchema`（`defineTool` 里也调它）→
 * `validateJsonSchemaValue`（registry 的 `createSuccessResult` 里也调它）。
 * 于是「返回值多一个没声明的字段」这类漂移在测试里直接变红。
 */
import { describe, expect, it } from 'vitest'
import { valueSchemaSpecToJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { CORUM_SUBAGENT_OUTPUT_SCHEMA } from '../src/output-schema.ts'

/** 与 `defineTool` 完全同口径的编译：spec → JSON Schema。 */
const schema = valueSchemaSpecToJsonSchema(CORUM_SUBAGENT_OUTPUT_SCHEMA)

/** 与 registry `createSuccessResult` 完全同口径的校验。 */
function violationsOf(value: unknown): string[] {
  return validateJsonSchemaValue(schema, value, 'value')
}

describe('subagent 输出形态（oneOf matched 0 的回归网）', () => {
  it('activation 支通过（rc3：后台统一 activation，无 background/continuable 分支）', () => {
    expect(violationsOf({ kind: 'activation', subagentId: 'corum-task-abc' })).toEqual([])
  })

  it('★ 前台结果带 spawnModel 必须通过（2026-11-07 报障的现场）', () => {
    // 这是路由解析成功的**常规形态**：spawnModel 几乎每次都会出现，所以漏声明
    // 等于"前台委派全线失败"，不是边角情形。
    expect(violationsOf({
      kind: 'foreground',
      runId: 'corum-task-1',
      output: [{ type: 'text', text: 'done' }],
      isolationBoundary: 'worktree',
      spawnModel: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
    })).toEqual([])
  })

  it('★ research 落盘形态（reportPath + spawnModel 同时出现）通过', () => {
    expect(violationsOf({
      kind: 'foreground',
      runId: 'corum-task-2',
      output: [{ type: 'text', text: 'summary of the report' }],
      spawnModel: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      reportPath: '/Users/x/.corum/research-reports/corum-task-2.md',
    })).toEqual([])
  })

  it('★ 网有牙：未声明的字段必须判失败', () => {
    // 反证：如果把 spawnModel 的声明再删掉，上一条必须变红。这里用"猜错的字段名"
    // 走同一条路径（曾经真出过错的名字就叫 `model`，与 orchestrate 的 closer.model 撞名）。
    const violations = violationsOf({
      kind: 'foreground',
      runId: 'corum-task-3',
      output: [],
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    })
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.join('\n')).toContain('oneOf')
  })

  it('★ 反证：把 spawnModel 的声明删掉，同一 payload 必须判失败（= 修复前的现场）', () => {
    // 这条不是重复上一条——它证明**上一条的红绿取决于这行声明**，而不是校验器太宽松。
    // 2026-11-07 的报障现场正是这样：返回值里有 spawnModel、schema 里没有。
    const withoutSpawnModel = structuredClone(CORUM_SUBAGENT_OUTPUT_SCHEMA) as unknown as {
      oneOf: { properties?: Record<string, unknown> }[]
    }
    withoutSpawnModel.oneOf.forEach((branch) => { delete branch.properties?.spawnModel })
    const violations = validateJsonSchemaValue(
      valueSchemaSpecToJsonSchema(withoutSpawnModel as unknown as typeof CORUM_SUBAGENT_OUTPUT_SCHEMA),
      {
        kind: 'foreground',
        runId: 'corum-task-1',
        output: [],
        spawnModel: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      },
      'value',
    )
    expect(violations).toContain('"value" must match exactly one oneOf branch (matched 0)')
  })

  it('foreground 分支声明的字段集合 = 代码真实会挂上的字段集合', () => {
    // 漂移的另一半：schema 里多声明了没人产出的字段是无害的，但**这份清单必须与
    // `spawnOne` 的结果装配面一致**——加字段时人眼对一次，改这里就是改契约。
    const foreground = CORUM_SUBAGENT_OUTPUT_SCHEMA.oneOf?.find(
      branch => (branch as { properties?: Record<string, { const?: string }> }).properties?.kind?.const === 'foreground',
    )
    const keys = Object.keys((foreground as { properties: Record<string, unknown> }).properties).sort()
    expect(keys).toEqual(['isolationBoundary', 'kind', 'output', 'reportPath', 'runId', 'spawnModel'])
  })
})
