/**
 * Agent 预设编辑页：**预览与保存同源**（2026-10-11；台账 ui.agent-presets.preview.persona-field-inert）。
 *
 * ## 修的是什么
 *
 * 草稿里曾有两个 persona 相关字段：
 *   · `personaCustom` —— 人格输入框绑的就是它（**用户实际输入**）；
 *   · `persona`       —— 只在回填时从 profile 赋值一次，此后**永不更新**。
 *
 * 保存读的是 `personaCustom`（正确），而**预览**读的是 `persona`（陈旧）⇒ 用户新填的
 * 自定义人格**不会出现在预览里**。此前无人察觉，是因为 `AgentCard` 恰好不渲染 persona；
 * 一旦有人让它渲染，就会当场表现为「预览与保存不一致」。
 *
 * ## 为什么用源码对账
 *
 * 这是 React 组件内部的纯展示逻辑，本仓没有 client 组件渲染测试装置（跑真实渲染要拉
 * 整个 client runtime）。此处钉的是一条**可机械判定的不变式**：预览与保存必须用
 * **逐字相同**的表达式构造 persona ⇒ 两处不可能再分叉。行为面（预览真的显示新值）由
 * 实机验证承担。
 *
 * 同时钉住「那个陈旧副本已删除」——否则有人把字段加回来，上面那条不变式仍会通过
 * （因为预览已改用 personaCustom），于是隐患复活而测试不红。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TSX = readFileSync(
  join(import.meta.dirname, '../src/client/settings/sections/SettingsAgentPresetsSection.tsx'),
  'utf8',
)

/** 本页读写 persona 时应当使用的**唯一**表达式（保存与预览共用）。 */
const SHARED_PERSONA_EXPR = "draft.personaPreset === 'custom' && draft.personaCustom.trim() !== ''"

/** 剥掉行注释与块注释——判据只看**代码**，注释里提到字段名是正当的说明。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 去掉注释后的代码文本（所有结构判据都基于它）。 */
const CODE = stripComments(TSX)

describe('Agent 预设编辑页 — 预览与保存同源', () => {
  it('预览与保存都用同一个 persona 表达式（两处，不多不少）', () => {
    const hits = CODE.split(SHARED_PERSONA_EXPR).length - 1
    // 一处是 doSave 的载荷、一处是 previewProfile ⇒ 恰好 2。
    expect(hits, `共享表达式出现 ${hits} 次（应为 2：保存 + 预览）`).toBe(2)
  })

  it('陈旧副本 draft.persona 已删除（防隐患复活）', () => {
    // 只要还有人**读**它，就说明双字段回来了。⚠️ 必须先剥注释：修这条缺陷时我恰好
    // 在注释里写了「已删的 `draft.persona` 副本」来说明缘由，裸正则把那段说明也算成
    // 回潮（本仓已有这个学费，见 model-policy.spec.ts 的 stripComments 同款注释）。
    expect(CODE).not.toMatch(/draft\.persona\b(?!Custom)/)
    // 字段声明也不该在（它是死状态）。
    expect(CODE).not.toMatch(/^\s{2}persona: string$/m)
  })

  it('预览不再无条件带上 persona（避免展示一个保存时会被丢弃的值）', () => {
    // 旧写法 `...(draft.persona !== '' ? { persona: draft.persona } : {})` 必须消失。
    expect(CODE).not.toContain("...(draft.persona !== ''")
  })
})
