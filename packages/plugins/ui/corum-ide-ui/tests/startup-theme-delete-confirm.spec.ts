/**
 * startup-theme-delete-confirm.spec.ts —— 「删除启动主题」必须过**确认框**（E/K7 的产品回归网）。
 *
 * ## 钉住的缺陷（2026-11-07 实测，与期望 §3 K7 直接冲突）
 *
 * `StartupAnimationSetting` 早期的删除按钮是 `desktop.deleteStartupTheme(theme.id)` **直接调用**：
 * 点一下就删、无确认、不可撤销；若删的正是**当前选中**主题，下一次启动会静默回退内置，
 * 用户事先毫不知情。期望要求：
 *   ① 删除**有确认框**；② 删除的是选中项时，文案要明确「下次启动回退内置」；
 *   ③ 取消**不改变**文件与选中态；④ 内置主题 UI 不可删（且 host/API 直接调用也 fail-loud —— 那条由
 *   `packages/desktop/tests/startup-themes.test.mjs` 的 `assert.rejects(deleteStartupTheme('corum-terminal'))` 守着）。
 *
 * ## 为什么用源码不变式而不是渲染交互
 *
 * 该组件的渲染依赖 `window.corumDesktop`（Electron 预加载桥），在 node 环境里**不存在**，
 * 静态渲染会直接走 `desktop === undefined → return null`。而删除是**真实 side effect**
 * （`rm -rf` 主题目录），不适合在单测里构造。故：
 *   - 交互闭环由实机 run 证明（K7 的 behavior 脚本：真实点删除 → 确认框 → 取消/确认）；
 *   - 本文件只钉「代码形态不许回退成直接删」这一条**结构性前提**，防止有人改回旧写法。
 *
 * @module @corum/corum-ide-ui/tests/startup-theme-delete-confirm
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** 组件源码（相对本文件）。 */
const SRC = readFileSync(
  join(import.meta.dirname, '..', 'src/client/settings/StartupAnimationSetting.tsx'),
  'utf8',
)

/** 取「删除按钮」那一行的源码。 */
function deleteButtonLine(): string {
  const line = SRC.split('\n').find(l => l.includes('aria-label={`删除 ${theme.name}`}'))
  expect(line, '删除按钮那一行必须存在').toBeDefined()
  return line ?? ''
}

describe('删除启动主题：必须先确认', () => {
  it('删除按钮只**打开确认框**，不再直接调用 deleteStartupTheme', () => {
    const line = deleteButtonLine()
    expect(line).toContain('setPendingDelete(theme)')
    expect(line).not.toContain('deleteStartupTheme')
  })

  it('确认框用统一的 ConfirmDialog，标题/主操作文案明确，色调 danger', () => {
    expect(SRC).toContain("import { ConfirmDialog } from './ConfirmDialog.tsx'")
    expect(SRC).toContain('title="删除启动主题"')
    expect(SRC).toContain('tone="danger"')
    expect(SRC).toContain('confirmLabel="删除"')
  })

  it('删除的是**当前选中**主题时，确认文案明确「下次启动回退内置」', () => {
    expect(SRC).toContain('catalog.selectedId === pendingDelete.id')
    // 文案必须同时说清「回退」与「内置」，否则用户不知道后果
    const seg = SRC.slice(SRC.indexOf('catalog.selectedId === pendingDelete.id'))
    const text = seg.slice(0, 400)
    expect(text).toContain('回退')
    expect(text).toContain('内置')
  })

  it('取消只清待删状态，不触碰文件/选中态', () => {
    expect(SRC).toContain('onCancel={() => { setPendingDelete(null) }}')
  })

  it('确认后才真删，并且先关掉确认框（避免删失败时框还在但状态错乱）', () => {
    const seg = SRC.slice(SRC.indexOf('onConfirm={() => {'))
    expect(seg.slice(0, 300)).toContain('setPendingDelete(null)')
    expect(seg.slice(0, 400)).toContain("deleteStartupTheme!(target.id, { confirmed: true })")
  })

  it('内置主题在 UI 里**没有**删除入口（`!theme.builtin` 守卫）', () => {
    expect(deleteButtonLine()).toContain('!theme.builtin &&')
  })
})
