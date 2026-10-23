/**
 * UI 声明校验测试 + 包根分类测试。
 *
 * 覆盖：
 * - UI 声明：合法 / 缺 plugin / 空 slot / 非数字 priority / replaces 格式
 * - classifyPack：四种组合
 *
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §3。
 */
import { describe, it, expect } from 'vitest'
import { validateUiDecl, classifyPack } from '../src/index.ts'

const VALID_UI_DECL = {
  name: 'my-ui',
  plugin: 'my-plugin',
  slot: 'sidebar',
  priority: 10,
  replaces: ['old-ui'],
}

describe('validateUiDecl — 合法', () => {
  it('全量合法 UI 声明 ⇒ [] 错误', () => {
    const errors = validateUiDecl(VALID_UI_DECL)
    expect(errors).toEqual([])
  })

  it('最小合法（只必填）⇒ [] 错误', () => {
    const errors = validateUiDecl({
      name: 'my-ui',
      plugin: 'my-plugin',
      slot: 'sidebar',
    })
    expect(errors).toEqual([])
  })

  it('label 可选且合法', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, label: 'my-ui-label' })
    expect(errors).toEqual([])
  })
})

describe('validateUiDecl — name / label / plugin', () => {
  it('name 不安全（含 /）⇒ 错误', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, name: 'a/b' })
    expect(errors.some(e => e.field === 'name')).toBe(true)
  })

  it('name 为 ".." ⇒ 错误', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, name: '..' })
    expect(errors.some(e => e.field === 'name')).toBe(true)
  })

  it('plugin 缺失 ⇒ 错误', () => {
    const { plugin: _, ...rest } = VALID_UI_DECL
    const errors = validateUiDecl(rest)
    expect(errors.some(e => e.field === 'plugin')).toBe(true)
  })

  it('plugin 不安全（含 /）⇒ 错误', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, plugin: 'a/b' })
    expect(errors.some(e => e.field === 'plugin')).toBe(true)
  })

  it('plugin 为 ".." ⇒ 错误', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, plugin: '..' })
    expect(errors.some(e => e.field === 'plugin')).toBe(true)
  })

  it('label 不安全（含 ..）⇒ 错误', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, label: '../evil' })
    expect(errors.some(e => e.field === 'label')).toBe(true)
  })
})

describe('validateUiDecl — slot', () => {
  it('slot 为空字符串 ⇒ 错误', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, slot: '' })
    expect(errors.some(e => e.field === 'slot')).toBe(true)
  })

  it('slot 缺失 ⇒ 错误', () => {
    const { slot: _, ...rest } = VALID_UI_DECL
    const errors = validateUiDecl(rest)
    expect(errors.some(e => e.field === 'slot')).toBe(true)
  })

  it('slot 为纯空格 ⇒ 错误', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, slot: '   ' })
    expect(errors.some(e => e.field === 'slot')).toBe(true)
  })
})

describe('validateUiDecl — priority', () => {
  it('priority 为字符串 ⇒ 错误', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, priority: '10' })
    expect(errors.some(e => e.field === 'priority')).toBe(true)
  })

  it('priority 为 NaN ⇒ 错误', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, priority: NaN })
    expect(errors.some(e => e.field === 'priority')).toBe(true)
  })

  it('priority 为 Infinity ⇒ 错误', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, priority: Infinity })
    expect(errors.some(e => e.field === 'priority')).toBe(true)
  })

  it('priority 为负数合法', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, priority: -5 })
    expect(errors).toEqual([])
  })

  it('priority 为 0 合法', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, priority: 0 })
    expect(errors).toEqual([])
  })
})

describe('validateUiDecl — replaces', () => {
  it('replaces 不是数组 ⇒ 错误', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, replaces: 'not-array' })
    expect(errors.some(e => e.field === 'replaces')).toBe(true)
  })

  it('replaces 含空字符串 ⇒ 错误', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, replaces: ['ok', ''] })
    expect(errors.some(e => e.field === 'replaces')).toBe(true)
  })

  it('replaces 含非字符串 ⇒ 错误', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, replaces: ['ok', 123] })
    expect(errors.some(e => e.field === 'replaces')).toBe(true)
  })

  it('replaces 为空数组合法', () => {
    const errors = validateUiDecl({ ...VALID_UI_DECL, replaces: [] })
    expect(errors).toEqual([])
  })
})

describe('validateUiDecl — 根不是对象', () => {
  it('根是数组 ⇒ 错误', () => {
    const errors = validateUiDecl([])
    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe('(root)')
  })

  it('根是 null ⇒ 错误', () => {
    const errors = validateUiDecl(null)
    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe('(root)')
  })
})

describe('classifyPack — 四种组合', () => {
  it('只有 extension.json ⇒ extension', () => {
    expect(classifyPack(true, false)).toBe('extension')
  })

  it('只有 module.json ⇒ preset-module', () => {
    expect(classifyPack(false, true)).toBe('preset-module')
  })

  it('两者都有 ⇒ ambiguous', () => {
    expect(classifyPack(true, true)).toBe('ambiguous')
  })

  it('两者都没有 ⇒ empty', () => {
    expect(classifyPack(false, false)).toBe('empty')
  })
})
