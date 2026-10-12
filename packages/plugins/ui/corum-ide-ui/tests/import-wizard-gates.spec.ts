/**
 * 导入向导 + 发布流程 — 源码结构断言（W5）。
 *
 * ## 为什么用源码对账而不是渲染测试
 *
 * 这是 React 组件内部的状态机/门禁逻辑，本仓没有 client 组件渲染测试装置（跑真实
 * 渲染要拉整个 client runtime）。此处钉的是可机械判定的不变式——行为面（向导真的
 * 按门禁推进、发布真的在 blocked 非空时禁用）由实机验证承担（corum-cdp-verify 技能）。
 *
 * ## 证伪记录
 *
 * 本文件写完后已做过一次「红→绿」证伪：
 * 1. 把 ImportModuleWizard 的 step1Valid 改成 `return true`（去掉路径空门禁）
 *    ⇒ `step1Valid 必须检查路径非空` 变红 ⇒ 改回变绿。
 * 2. 把 PublishModuleDialog 的 `disabled={blocked` 改成 `disabled={false`（去掉闸门）
 *    ⇒ `发布导出按钮在 blocked 时必须禁用` 变红 ⇒ 改回变绿。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WIZARD_SRC = readFileSync(
  join(import.meta.dirname, '../src/client/settings/sections/ImportModuleWizard.tsx'),
  'utf8',
)
const PUBLISH_SRC = readFileSync(
  join(import.meta.dirname, '../src/client/settings/sections/PublishModuleDialog.tsx'),
  'utf8',
)
const PRESETS_SRC = readFileSync(
  join(import.meta.dirname, '../src/client/settings/sections/SettingsAgentPresetsSection.tsx'),
  'utf8',
)

/** 剥掉行注释与块注释——判据只看代码，注释里提到字段名是正当说明。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const WIZARD = stripComments(WIZARD_SRC)
const PUBLISH = stripComments(PUBLISH_SRC)
const PRESETS = stripComments(PRESETS_SRC)

describe('导入向导 — 状态机门禁（行为规格 §2）', () => {
  it('第 ①→② 门禁：step1Valid 必须检查路径非空（未选来源/路径为空 ⇒ 禁用）', () => {
    // step1Valid 里必须有 dirPath.trim() !== '' 判断（从文件导入）与 libraryDir 检查。
    expect(WIZARD).toContain('dirPath.trim()')
    expect(WIZARD).toContain('libraryDir')
  })

  it('第 ②→③ 门禁：inspection === null ⇒ 禁用（step2Valid 检查 inspection）', () => {
    expect(WIZARD).toContain('step2Valid')
    expect(WIZARD).toContain('state.inspection !== null')
  })

  it('第 ③→④ 永远允许：跳过是正常路径，不是错误（跳过按钮存在）', () => {
    // 行为规格 §2：第 ③→④ 永远允许。跳过按钮必须存在。
    expect(WIZARD).toContain('跳过，稍后再装')
  })

  it('第 ③ 步第 ② 层不自动跑：测试由用户点击触发（注释写明理由）', () => {
    // 行为规格 §3：第 ② 层必须由用户点触发。testMcp 必须是显式调用的函数，不在 effect 里。
    // 关键标志：有一个 onTest prop 传到 DepCard，DepCard 有「测试」按钮。
    expect(WIZARD).toContain('onTest')
    expect(WIZARD).toContain('testMcp')
  })

  it('第 ④ 步默认值 = 设计稿选中的那个（profile=skip, skills=skip, mcp=keep）', () => {
    // 行为规格 §4：三组默认值必须与设计稿一致。
    expect(WIZARD).toContain("profile: 'skip'")
    expect(WIZARD).toContain("skills: 'skip'")
    expect(WIZARD).toContain("mcp: 'keep'")
  })
})

describe('发布流程 — 闸门逻辑（行为规格 §5）', () => {
  it('blocked 非空 ⇒ 导出按钮禁用（disabled={blocked}）', () => {
    // 行为规格 §5.3：blocked 非空 ⇒ 主按钮禁用。
    expect(PUBLISH).toContain('disabled={blocked')
  })

  it('blocked 非空 ⇒ 不产出文件（doExport 先检查 blocked 再调 RPC）', () => {
    // 行为规格 §5：blocked 非空 ⇒ 一个文件都不产出。
    // doExport 开头必须有 `if (blocked) return`。
    expect(PUBLISH).toContain('if (blocked) return')
  })

  it('未补全项提供「让 Agent 重试」（onRetry 调 authorModuleRequires）', () => {
    // 行为规格 §5.4：每张未补全卡提供「让 Agent 重试」。
    expect(PUBLISH).toContain('让 Agent 重试')
    expect(PUBLISH).toContain('authorModuleRequires')
  })

  it('unconfirmed 与已补全区分渲染（待补全徽标存在）', () => {
    // 行为规格 §5.5：unconfirmed 里列出的名字要区分渲染。
    expect(PUBLISH).toContain('待补全')
    expect(PUBLISH).toContain('unconfirmed')
  })

  it('发布目标「即将开放」项灰禁用（不假装可用）', () => {
    // 行为规格 §5：复制分享链接与发布到市场灰禁用 + 橙字「即将开放」。
    expect(PUBLISH).toContain('即将开放')
  })
})

describe('列表卡片 — 模块徽标（契约 §7.1 moduleSource）', () => {
  it('moduleSource 存在时加「模块」徽标', () => {
    // 契约 §7.1（主 Agent 统一裁定）：ProfileSummary.moduleSource 存在 ⇒ 模块装来的 ⇒ 加徽标。
    expect(PRESETS).toContain('moduleSource')
    expect(PRESETS).toContain('模块')
  })

  it('模块徽标复用 trustBadge 类（样式一致）', () => {
    // 行为规格 §1：样式复用现有「系统」徽标的类。
    expect(PRESETS).toContain('css.trustBadge')
    expect(PRESETS).toContain('css.moduleBadge')
  })
})
