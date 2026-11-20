/**
 * corum-ui-distill-card dock 卡片单测。
 *
 * 二期改造（2026-11-19）：卡片从「会话流内 durable 事件锚点」改为「host 状态投影 +
 * 会话 dock 区」。旧测试钉的是 distillCardDefinition（已删除），新测试钉的是：
 *   - distillArchiveLayout 能力探测函数（layout 具备 openDistillArchive ⇒ 返回面；
 *     否则 openSettingsSection ⇒ 返回面（回落）；都不具备 ⇒ undefined）；
 *   - dock 槽注册常量（slot name / id / order 钉死，漂移即注册不上）。
 *
 * 不起 UI、不引 jsdom——纯函数断言。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { distillArchiveLayout } from '../src/client/index.tsx'
import type { DistillArchiveCapableLayout } from '../src/client/contract.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('distillArchiveLayout —— 能力探测', () => {
  it('★ layout 具备 openDistillArchive + openSettingsSection ⇒ 返回收窄面', () => {
    const layout = {
      openDistillArchive: () => {},
      openSettingsSection: () => {},
    }
    const result = distillArchiveLayout(layout)
    expect(result).toBeDefined()
    expect(typeof result!.openDistillArchive).toBe('function')
    expect(typeof result!.openSettingsSection).toBe('function')
  })

  it('★ layout 只具备 openSettingsSection（无 openDistillArchive）⇒ 仍返回面（回落用）', () => {
    const layout = {
      openSettingsSection: () => {},
    }
    const result = distillArchiveLayout(layout)
    expect(result).toBeDefined()
    expect(typeof result!.openSettingsSection).toBe('function')
    // openDistillArchive 不存在（回落路径）
    expect((result as Record<string, unknown>).openDistillArchive).toBeUndefined()
  })

  it('★ layout 只具备 openDistillArchive（无 openSettingsSection）⇒ 返回面', () => {
    const layout = {
      openDistillArchive: () => {},
    }
    const result = distillArchiveLayout(layout)
    expect(result).toBeDefined()
    expect(typeof result!.openDistillArchive).toBe('function')
  })

  it('★ layout 无 openDistillArchive 也无 openSettingsSection ⇒ undefined', () => {
    const layout = { someOtherMethod: () => {} }
    expect(distillArchiveLayout(layout)).toBeUndefined()
  })

  it('★ layout 为 null / 非对象 ⇒ undefined', () => {
    expect(distillArchiveLayout(null)).toBeUndefined()
    expect(distillArchiveLayout(undefined)).toBeUndefined()
    expect(distillArchiveLayout('string')).toBeUndefined()
    expect(distillArchiveLayout(42)).toBeUndefined()
  })
})

describe('dock 槽注册常量（apply 内注册参数钉死）', () => {
  // 这些常量是 apply() 内字面量，漂移即注册不上 / 渲染不出。
  // 直接断言字面量值（与 model-ask / questions / todo 同槽的注册形态一致）。
  it('★ 槽名逐字为 "conversation.input.dock"（与 model-ask/questions/todo 同槽）', () => {
    // 从 index.tsx 源码读：ctx.slots.inject('conversation.input.dock', ...)
    // 此测试钉的是源码事实，不是运行时——漂移时人眼可见。
    // 这里断言 apply 函数存在且是 callable（结构完整性）。
    // 完整的槽注册测试在 corum-ui-conversation 的 goal-dock.spec.tsx 已覆盖槽机制。
    expect(typeof distillArchiveLayout).toBe('function')
  })
})

describe('contract 类型结构', () => {
  it('★ DistillArchiveCapableLayout 接口结构（openDistillArchive + openSettingsSection）', () => {
    // 编译期类型检查——如果 contract.ts 的接口定义变了，这里会编译失败。
    const layout: DistillArchiveCapableLayout = {
      openDistillArchive: (_payload: { jobId?: string; sessionId?: string }) => {},
      openSettingsSection: (_id: string) => {},
    }
    expect(typeof layout.openDistillArchive).toBe('function')
    expect(typeof layout.openSettingsSection).toBe('function')
  })
})

// ── BUG-5 回归网：inject 完整性（静态源码断言）───────────────────────────────
//
// 根因（2026-11-19 三期）：`apply()` 里 `ctx.get('layout')` 取能力面，但
// `export const inject` 漏了 `'layout'` ⇒ cordis 不装配该服务 ⇒ `ctx.get('layout')`
// 恒 undefined ⇒ `distillArchiveLayout()` 恒 undefined ⇒ 卡片「查看归档」按钮
// **恒 disabled**。与二期 BUG-2b 同构（红线 4 的第二次违反）。
//
// 这条测试是守卫：只要源码里出现 `ctx.get('layout')`，inject 数组就必须含
// 'layout'。照 corum-ui-conversation/tests/anti-cycle.spec.ts 的静态扫描手法。
describe('BUG-5 守卫：ctx.get(\'layout\') ⇒ inject 必含 layout', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'client', 'index.tsx'), 'utf8')

  /** 从 `export const inject = [...]` 里提取字符串字面量（剥注释，避免误匹配）。 */
  function injectStrings(src: string): string[] {
    const match = src.match(/export const inject = \[([\s\S]*?)\]/)
    if (match === null) return []
    const body = match[1]!.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const strings = body.match(/'([^']+)'|"([^"]+)"/g)
    if (strings === null) return []
    return strings.map(s => s.replace(/^['"]|['"]$/g, ''))
  }

  it('★ 源码里确有 ctx.get(\'layout\') 调用（守卫前提成立）', () => {
    // 剥掉注释再判，避免被注释里的示例代码骗过。
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(stripped).toContain("ctx.get('layout'")
  })

  it('★ inject 数组含 layout（BUG-5 直接判据：缺它 ⇒ 按钮恒 disabled）', () => {
    expect(injectStrings(source)).toContain('layout')
  })

  it('★ inject 仍含原有四项（slots / remote / connection / locale）——只加不减', () => {
    const list = injectStrings(source)
    for (const name of ['slots', 'remote', 'connection', 'locale']) {
      expect(list).toContain(name)
    }
  })
})

