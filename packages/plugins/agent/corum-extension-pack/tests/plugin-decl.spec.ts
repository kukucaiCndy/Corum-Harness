/**
 * 插件声明校验测试。
 *
 * 覆盖：合法插件声明 / 缺 spec / 非法 mode / 缺 bundle 和 entry /
 * sha256 短或大写 / files 负数 / requires 各类失败。
 *
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §3 的插件声明校验规则。
 */
import { describe, it, expect } from 'vitest'
import { validatePluginDecl } from '../src/index.ts'

/** 全量合法插件声明，作为各失败用例的基底。 */
const VALID_DECL = {
  name: 'my-plugin',
  spec: '@corum/my-plugin',
  mode: 'permanent',
  entry: 'index.ts',
  requires: { kind: 'command', command: 'npx', hint: '需要 npx' },
  integrity: { sha256: 'a'.repeat(64), files: 3, bytes: 1024 },
  ui: 'my-ui',
}

describe('validatePluginDecl — 合法', () => {
  it('全量合法插件声明 ⇒ [] 错误', () => {
    const errors = validatePluginDecl(VALID_DECL)
    expect(errors).toEqual([])
  })

  it('bundle: true（无 entry）也合法', () => {
    const { entry: _, ...rest } = VALID_DECL
    const errors = validatePluginDecl({ ...rest, bundle: true })
    expect(errors).toEqual([])
  })

  it('lazy mode 合法', () => {
    const errors = validatePluginDecl({ ...VALID_DECL, mode: 'lazy' })
    expect(errors).toEqual([])
  })

  it('无 requires 也合法', () => {
    const { requires: _, ...rest } = VALID_DECL
    const errors = validatePluginDecl(rest)
    expect(errors).toEqual([])
  })

  it('无 integrity 也合法', () => {
    const { integrity: _, ...rest } = VALID_DECL
    const errors = validatePluginDecl(rest)
    expect(errors).toEqual([])
  })

  it('label 可选且合法', () => {
    const errors = validatePluginDecl({ ...VALID_DECL, label: '我的插件' })
    expect(errors).toEqual([])
  })

  it('restartRequired 可选', () => {
    const errors = validatePluginDecl({ ...VALID_DECL, restartRequired: true })
    expect(errors).toEqual([])
  })
})

describe('validatePluginDecl — name / spec / mode', () => {
  it('name 不安全（含 /）⇒ 错误', () => {
    const errors = validatePluginDecl({ ...VALID_DECL, name: 'a/b' })
    expect(errors.some(e => e.field === 'name')).toBe(true)
  })

  it('spec 为空 ⇒ 错误', () => {
    const errors = validatePluginDecl({ ...VALID_DECL, spec: '' })
    expect(errors.some(e => e.field === 'spec')).toBe(true)
  })

  it('mode 不是 permanent/lazy ⇒ 错误', () => {
    const errors = validatePluginDecl({ ...VALID_DECL, mode: 'always' as string })
    expect(errors.some(e => e.field === 'mode')).toBe(true)
  })
})

describe('validatePluginDecl — bundle / entry', () => {
  it('既没有 bundle 也没有 entry ⇒ 错误（field: entry）', () => {
    const { entry: _, ...rest } = VALID_DECL
    const errors = validatePluginDecl(rest)
    expect(errors.some(e => e.field === 'entry')).toBe(true)
  })

  it('bundle: false 且无 entry ⇒ 错误', () => {
    const { entry: _, ...rest } = VALID_DECL
    const errors = validatePluginDecl({ ...rest, bundle: false })
    expect(errors.some(e => e.field === 'entry')).toBe(true)
  })

  it('entry 为空字符串 ⇒ 错误', () => {
    const { entry: _, ...rest } = VALID_DECL
    const errors = validatePluginDecl({ ...rest, entry: '' })
    expect(errors.some(e => e.field === 'entry')).toBe(true)
  })
})

describe('validatePluginDecl — integrity', () => {
  it('sha256 过短 ⇒ 错误', () => {
    const errors = validatePluginDecl({
      ...VALID_DECL,
      integrity: { sha256: 'abc', files: 3, bytes: 1024 },
    })
    expect(errors.some(e => e.field === 'integrity.sha256')).toBe(true)
  })

  it('sha256 含大写字母 ⇒ 错误', () => {
    const errors = validatePluginDecl({
      ...VALID_DECL,
      integrity: { sha256: 'A'.repeat(64), files: 3, bytes: 1024 },
    })
    expect(errors.some(e => e.field === 'integrity.sha256')).toBe(true)
  })

  it('files 为负数 ⇒ 错误', () => {
    const errors = validatePluginDecl({
      ...VALID_DECL,
      integrity: { sha256: 'a'.repeat(64), files: -1, bytes: 1024 },
    })
    expect(errors.some(e => e.field === 'integrity.files')).toBe(true)
  })

  it('files 为 0 ⇒ 错误（必须是正整数）', () => {
    const errors = validatePluginDecl({
      ...VALID_DECL,
      integrity: { sha256: 'a'.repeat(64), files: 0, bytes: 1024 },
    })
    expect(errors.some(e => e.field === 'integrity.files')).toBe(true)
  })

  it('bytes 为负数 ⇒ 错误', () => {
    const errors = validatePluginDecl({
      ...VALID_DECL,
      integrity: { sha256: 'a'.repeat(64), files: 3, bytes: -100 },
    })
    expect(errors.some(e => e.field === 'integrity.bytes')).toBe(true)
  })

  it('files 为非整数（3.5）⇒ 错误', () => {
    const errors = validatePluginDecl({
      ...VALID_DECL,
      integrity: { sha256: 'a'.repeat(64), files: 3.5, bytes: 1024 },
    })
    expect(errors.some(e => e.field === 'integrity.files')).toBe(true)
  })
})

describe('validatePluginDecl — requires', () => {
  it('requires kind=command 但 command 为空 ⇒ 错误', () => {
    const errors = validatePluginDecl({
      ...VALID_DECL,
      requires: { kind: 'command', command: '', hint: '需要 npx' },
    })
    expect(errors.some(e => e.field === 'requires.command')).toBe(true)
  })

  it('requires kind 无效 ⇒ 错误', () => {
    const errors = validatePluginDecl({
      ...VALID_DECL,
      requires: { kind: 'binary', command: 'npx', hint: '需要 npx' },
    })
    expect(errors.some(e => e.field === 'requires.kind')).toBe(true)
  })

  it('requires hint 为空 ⇒ 错误', () => {
    const errors = validatePluginDecl({
      ...VALID_DECL,
      requires: { kind: 'command', command: 'npx', hint: '' },
    })
    expect(errors.some(e => e.field === 'requires.hint')).toBe(true)
  })

  it('requires kind=app 缺 platforms ⇒ 错误', () => {
    const errors = validatePluginDecl({
      ...VALID_DECL,
      requires: { kind: 'app', hint: '需要 Pen' },
    })
    expect(errors.some(e => e.field === 'requires.platforms')).toBe(true)
  })

  it('requires kind=app 有非空 platforms ⇒ 合法', () => {
    const errors = validatePluginDecl({
      ...VALID_DECL,
      requires: { kind: 'app', platforms: { darwin: '/Applications/Pen.app' }, hint: '需要 Pen' },
    })
    expect(errors).toEqual([])
  })

  it('requires kind=service 缺 url ⇒ 错误', () => {
    const errors = validatePluginDecl({
      ...VALID_DECL,
      requires: { kind: 'service', hint: '跑服务' },
    })
    expect(errors.some(e => e.field === 'requires.url')).toBe(true)
  })

  it('requires 不是对象 ⇒ 错误', () => {
    const errors = validatePluginDecl({
      ...VALID_DECL,
      requires: 'not-an-object',
    })
    expect(errors.some(e => e.field === 'requires.(root)')).toBe(true)
  })
})

describe('validatePluginDecl — ui', () => {
  it('ui 不安全（含 /）⇒ 错误', () => {
    const errors = validatePluginDecl({ ...VALID_DECL, ui: 'a/b' })
    expect(errors.some(e => e.field === 'ui')).toBe(true)
  })

  it('ui 为 ".." ⇒ 错误', () => {
    const errors = validatePluginDecl({ ...VALID_DECL, ui: '..' })
    expect(errors.some(e => e.field === 'ui')).toBe(true)
  })
})

describe('validatePluginDecl — 根不是对象', () => {
  it('根是数组 ⇒ 错误', () => {
    const errors = validatePluginDecl([])
    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe('(root)')
  })
})
