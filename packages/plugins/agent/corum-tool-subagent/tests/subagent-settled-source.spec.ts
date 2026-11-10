/**
 * fork（corum）subagent-settled 消息源字段完整性对账（2026-09-27 修复轮）。
 *
 * ## 根因（实机 CDP 抓出）
 * corum 写 `subagent-settled` 消息源时漏写官方必填字段 `senderSessionId`。官方
 * `@deepseek-ai/dsh-session-format-v0-to-v1`（0.1.5）的 `assertReleasedV0Keys` 对
 * `source.kind === 'subagent-settled'` 要求 4 个成员：`kind`/`form`/`summary`/
 * `senderSessionId`（注释："Session id of the child that settled"）。漏写 ⇒
 * 46 个历史 v2 会话加载失败（v2→v3 迁移拒绝、原文不变）。
 *
 * ## 为什么用「源码扫描式」对账
 * 本仓先例：`model-policy.spec.ts`（`between`/`stripComments`）、
 * `prompt-discipline.spec.ts`（`indexOf` 切片钉规则）。`subagent-settled` 的 source
 * 是注入到会话流的 durable 字段，漏写只有实机加载历史会话才暴露。本 spec 把
 * "每个 subagent-settled source 都含 senderSessionId" 变成断言，回潮即红。
 *
 * ## 覆盖边界
 * 只钉住 `src/index.ts` 里所有 `kind: 'subagent-settled'` 出现处都伴生
 * `senderSessionId`；不做运行期注入产物断言（那要 CDP 取证）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')

/** 剥掉注释后的源码——判「字段有没有」先剥注释，避免说明性注释被算成代码。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 取一个 `kind: 'subagent-settled'` 所在的 source 对象块。
 *
 * source 对象字面量从 `source: {` 开始，到 `as unknown as MessageSource` 结束。
 * kind 行总在 source 对象里，故先定位 kind 再回溯 `source: {`、前推到收尾标记。
 */
function sourceBlockAt(kindOffset: number): string {
  const sourceIdx = SRC.lastIndexOf('source: {', kindOffset)
  expect(sourceIdx, `source: { not found before offset ${kindOffset}`).toBeGreaterThanOrEqual(0)
  const tailIdx = SRC.indexOf('as unknown as MessageSource', kindOffset)
  expect(tailIdx, `source block tail not found after offset ${kindOffset}`).toBeGreaterThan(kindOffset)
  return SRC.slice(sourceIdx, tailIdx)
}

/** 取一段源码：从 `from` 到其后第一个 `to`（不含）。顺序即语义锚点。 */
function between(from: string, to: string): string {
  const start = SRC.indexOf(from)
  expect(start, `anchor not found: ${from}`).toBeGreaterThanOrEqual(0)
  const end = SRC.indexOf(to, start + from.length)
  expect(end, `closing anchor not found: ${to}`).toBeGreaterThan(start)
  return SRC.slice(start, end)
}

describe('subagent-settled 消息源字段完整性 — 每个 source 都含 senderSessionId', () => {
  it('★ 防回归：剥注释后，源码里每个 subagent-settled source 块都含 senderSessionId', () => {
    // 逐个 `kind: 'subagent-settled'` 出现处，检查它所在的 source 块都含 senderSessionId。
    // 这是结构性兜底——钉住"将来新增/修改的 subagent-settled source 也别漏写"。
    const code = stripComments(SRC)
    let from = 0
    let count = 0
    while (true) {
      const idx = code.indexOf("kind: 'subagent-settled'", from)
      if (idx < 0) break
      count++
      const sourceIdx = code.lastIndexOf('source: {', idx)
      expect(sourceIdx, `source: { not found before subagent-settled #${count} at offset ${idx}`).toBeGreaterThanOrEqual(0)
      const tailIdx = code.indexOf('as unknown as MessageSource', idx)
      expect(tailIdx, `source block tail not found for #${count} at offset ${idx}`).toBeGreaterThan(idx)
      const block = code.slice(sourceIdx, tailIdx)
      expect(block, `subagent-settled source #${count} at offset ${idx} lacks senderSessionId`).toContain('senderSessionId')
      from = tailIdx + 1
    }
    // 5 个写 subagent-settled source 的通知函数（corumNotifyPartialIntegration /
    // corumNotifyPendingIntegration / corumNotifyForegroundResult /
    // corumNotifyModelDecision / corumNotifySettleCommitFailures），全部都应含
    // senderSessionId。
    //
    // 2026-10（origin/main）：`corumNotifyVerifyRejected` 随 `merge` 字段一起退役（收尾
    // 改由 closer 承担、被拒形态由它的 persona 逐条报告，不再走第二条 notice 通路），
    // 故从 6 降到 5。
    //
    // 2026-10-27：`corumNotifyForegroundResult` 删除（前台结果只在工具结果里），
    // subagent-settled source 数量从 5 降到 4。
    expect(count, 'subagent-settled source 数量异常（可能扫描逻辑坏了）').toBe(4)
  })

  it('corumNotifyModelDecision 在无 childId 时走 logger.warn（不注入缺字段的 source）', () => {
    // 父 agent 裁定：子会话未起（后台预检 / spawn 期失败）时，不注入 subagent-settled
    // notice（没有 settled child，senderSessionId 无法填），改为只 logger.warn。
    // 这条钉住"无 childId 时不走 inject"——防回潮成占位值。
    const block = between('if (notify && outcome.summary !== \'\') {', 'return {')
    expect(block).toContain('childId !== undefined')
    expect(block).toContain('corumNotifyModelDecision')
    expect(block).toContain('logger.warn')
  })
})
