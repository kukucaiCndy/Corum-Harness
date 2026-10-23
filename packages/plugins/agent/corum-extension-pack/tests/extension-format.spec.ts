/**
 * 扩展包清单格式校验测试。
 *
 * 覆盖：全量合法清单 / 各种失败形态 / isSafeEntityName / isValidExtensionId。
 *
 * P1 是纯函数库（零 IO），所有测试只校验 `validateExtension` 的输入输出，
 * 不碰真实文件系统。
 *
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §3。
 */
import { describe, it, expect } from 'vitest'
import {
  validateExtension,
  isValidExtensionId,
  isSafeEntityName,
  EXTENSION_FORMAT_VERSION,
  EXTENSION_MANIFEST_FILE,
  MODULE_MANIFEST_FILE,
  EXTENSION_CONTENT_KEYS,
} from '../src/index.ts'

/** 全量合法清单（六类内容全有），作为各失败用例的基底。 */
const VALID_MANIFEST = {
  formatVersion: 1,
  id: 'my-extension',
  version: '1.0.0',
  name: '我的扩展包',
  description: '测试用合法扩展包',
  author: 'corum',
  avatar: 'assets/avatar.png',
  contents: {
    presets: ['preset-a', 'preset-b'],
    skills: ['skill-a'],
    mcp: ['mcp-a'],
    plugins: ['plugin-a'],
    themes: ['theme-a'],
    ui: ['ui-a'],
  },
  importSkill: 'skill-a',
  assistantProfile: 'preset-a',
}

describe('validateExtension — 合法清单', () => {
  it('全量合法清单（六类内容全有）⇒ [] 错误', () => {
    const errors = validateExtension(VALID_MANIFEST)
    expect(errors).toEqual([])
  })

  it('最小合法清单（只含必填字段 + 空内容）⇒ [] 错误', () => {
    const errors = validateExtension({
      formatVersion: 1,
      id: 'minimal',
      version: '0.1.0',
      name: '最小',
      contents: {},
    })
    expect(errors).toEqual([])
  })

  it('contents 只填部分类别也合法', () => {
    const errors = validateExtension({
      formatVersion: 1,
      id: 'partial',
      version: '1.0.0',
      name: '部分',
      contents: { skills: ['s1'], mcp: ['m1'] },
    })
    expect(errors).toEqual([])
  })
})

describe('validateExtension — formatVersion', () => {
  it('formatVersion 缺失 ⇒ 错误', () => {
    const { formatVersion: _, ...rest } = VALID_MANIFEST
    const errors = validateExtension(rest)
    expect(errors.some(e => e.field === 'formatVersion')).toBe(true)
  })

  it('formatVersion = 2 ⇒ 错误', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, formatVersion: 2 })
    expect(errors.some(e => e.field === 'formatVersion')).toBe(true)
  })

  it('formatVersion = "1"（字符串）⇒ 错误（严格 number 相等）', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, formatVersion: '1' })
    expect(errors.some(e => e.field === 'formatVersion')).toBe(true)
  })
})

describe('validateExtension — id', () => {
  it('id 含大写字母 ⇒ 错误', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, id: 'MyExtension' })
    expect(errors.some(e => e.field === 'id')).toBe(true)
  })

  it('id 以连字符开头 ⇒ 错误', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, id: '-leading-dash' })
    expect(errors.some(e => e.field === 'id')).toBe(true)
  })

  it('id 为空字符串 ⇒ 错误', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, id: '' })
    expect(errors.some(e => e.field === 'id')).toBe(true)
  })
})

describe('validateExtension — version / name', () => {
  it('version 为空 ⇒ 错误', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, version: '' })
    expect(errors.some(e => e.field === 'version')).toBe(true)
  })

  it('name 为空 ⇒ 错误', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, name: '' })
    expect(errors.some(e => e.field === 'name')).toBe(true)
  })
})

describe('validateExtension — contents', () => {
  it('contents 缺失 ⇒ 错误', () => {
    const { contents: _, ...rest } = VALID_MANIFEST
    const errors = validateExtension(rest)
    expect(errors.some(e => e.field === 'contents')).toBe(true)
  })

  it('contents 不是对象（是数组）⇒ 错误', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, contents: [] })
    expect(errors.some(e => e.field === 'contents')).toBe(true)
  })

  it('contents 不是对象（是字符串）⇒ 错误', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, contents: 'hello' })
    expect(errors.some(e => e.field === 'contents')).toBe(true)
  })

  it('contents 含未知键 ⇒ 错误（未知的内容类型）', () => {
    const errors = validateExtension({
      ...VALID_MANIFEST,
      contents: { ...VALID_MANIFEST.contents, unknown: ['x'] },
    })
    expect(errors.some(e => e.field === 'contents.unknown' && e.message === '未知的内容类型')).toBe(true)
  })

  it('contents 条目不是字符串（是数字）⇒ 错误', () => {
    const errors = validateExtension({
      ...VALID_MANIFEST,
      contents: { skills: [123] },
    })
    expect(errors.some(e => e.field === 'contents.skills')).toBe(true)
  })

  it('contents 条目含路径穿越 "../evil" ⇒ 错误', () => {
    const errors = validateExtension({
      ...VALID_MANIFEST,
      contents: { skills: ['../evil'] },
    })
    expect(errors.some(e => e.field === 'contents.skills')).toBe(true)
  })

  it('contents 条目含绝对路径 "/etc/passwd" ⇒ 错误', () => {
    const errors = validateExtension({
      ...VALID_MANIFEST,
      contents: { mcp: ['/etc/passwd'] },
    })
    expect(errors.some(e => e.field === 'contents.mcp')).toBe(true)
  })

  it('contents 条目含子路径 "a/b" ⇒ 错误', () => {
    const errors = validateExtension({
      ...VALID_MANIFEST,
      contents: { plugins: ['a/b'] },
    })
    expect(errors.some(e => e.field === 'contents.plugins')).toBe(true)
  })

  it('contents 条目为 ".." ⇒ 错误', () => {
    const errors = validateExtension({
      ...VALID_MANIFEST,
      contents: { themes: ['..'] },
    })
    expect(errors.some(e => e.field === 'contents.themes')).toBe(true)
  })

  it('contents 条目为 "." ⇒ 错误', () => {
    const errors = validateExtension({
      ...VALID_MANIFEST,
      contents: { ui: ['.'] },
    })
    expect(errors.some(e => e.field === 'contents.ui')).toBe(true)
  })

  it('contents 条目重复 ⇒ 错误', () => {
    const errors = validateExtension({
      ...VALID_MANIFEST,
      contents: { skills: ['dup', 'dup'] },
    })
    expect(errors.some(e => e.field === 'contents.skills' && e.message.includes('重复'))).toBe(true)
  })
})

describe('validateExtension — avatar', () => {
  it('avatar 是绝对路径（以 / 开头）⇒ 错误', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, avatar: '/etc/passwd' })
    expect(errors.some(e => e.field === 'avatar')).toBe(true)
  })

  it('avatar 含 .. 段（路径穿越）⇒ 错误', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, avatar: '../evil.png' })
    expect(errors.some(e => e.field === 'avatar')).toBe(true)
  })

  it('avatar 含反斜杠 ⇒ 错误', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, avatar: 'assets\\avatar.png' })
    expect(errors.some(e => e.field === 'avatar')).toBe(true)
  })

  it('avatar 为空字符串 ⇒ 错误', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, avatar: '' })
    expect(errors.some(e => e.field === 'avatar')).toBe(true)
  })
})

describe('validateExtension — importSkill / assistantProfile', () => {
  it('importSkill 不安全（含 /）⇒ 错误', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, importSkill: 'a/b' })
    expect(errors.some(e => e.field === 'importSkill')).toBe(true)
  })

  it('importSkill 为 ".." ⇒ 错误', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, importSkill: '..' })
    expect(errors.some(e => e.field === 'importSkill')).toBe(true)
  })

  it('assistantProfile 不安全（含 ..）⇒ 错误', () => {
    const errors = validateExtension({ ...VALID_MANIFEST, assistantProfile: '../evil' })
    expect(errors.some(e => e.field === 'assistantProfile')).toBe(true)
  })
})

describe('validateExtension — 根不是对象', () => {
  it('根是数组 ⇒ 错误（field: (root)）', () => {
    const errors = validateExtension([])
    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe('(root)')
  })

  it('根是字符串 ⇒ 错误（field: (root)）', () => {
    const errors = validateExtension('hello')
    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe('(root)')
  })

  it('根是 null ⇒ 错误（field: (root)）', () => {
    const errors = validateExtension(null)
    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe('(root)')
  })
})

describe('isValidExtensionId — 单元', () => {
  it('合法 id（小写+数字+连字符）', () => {
    expect(isValidExtensionId('my-ext-123')).toBe(true)
  })

  it('单个字母合法', () => {
    expect(isValidExtensionId('a')).toBe(true)
  })

  it('大写字母不合法', () => {
    expect(isValidExtensionId('MyExt')).toBe(false)
  })

  it('以连字符开头不合法', () => {
    expect(isValidExtensionId('-ext')).toBe(false)
  })

  it('含下划线不合法', () => {
    expect(isValidExtensionId('my_ext')).toBe(false)
  })

  it('空字符串不合法', () => {
    expect(isValidExtensionId('')).toBe(false)
  })
})

describe('isSafeEntityName — 单元', () => {
  it('合法名字', () => {
    expect(isSafeEntityName('my-skill')).toBe(true)
  })

  it('含下划线合法', () => {
    expect(isSafeEntityName('my_skill')).toBe(true)
  })

  it('含 / 不合法', () => {
    expect(isSafeEntityName('a/b')).toBe(false)
  })

  it('含 \\ 不合法', () => {
    expect(isSafeEntityName('a\\b')).toBe(false)
  })

  it('"." 不合法', () => {
    expect(isSafeEntityName('.')).toBe(false)
  })

  it('".." 不合法', () => {
    expect(isSafeEntityName('..')).toBe(false)
  })

  it('"../evil" 不合法', () => {
    expect(isSafeEntityName('../evil')).toBe(false)
  })

  it('空字符串不合法', () => {
    expect(isSafeEntityName('')).toBe(false)
  })

  it('非字符串不合法', () => {
    expect(isSafeEntityName(123 as unknown as string)).toBe(false)
  })

  // 评审补充（2026-10-23）：这些名字不会被 `..` 判据拦住，但落盘会出跨平台问题。
  it('以 . 开头不合法（隐藏文件 / "..."）', () => {
    expect(isSafeEntityName('.hidden')).toBe(false)
    expect(isSafeEntityName('...')).toBe(false)
  })

  it('Windows 保留设备名不合法（含带扩展名形态）', () => {
    expect(isSafeEntityName('CON')).toBe(false)
    expect(isSafeEntityName('nul')).toBe(false)
    expect(isSafeEntityName('COM1')).toBe(false)
    expect(isSafeEntityName('CON.txt')).toBe(false)
  })

  it('尾点 / 尾空格不合法（Windows 会静默截断）', () => {
    expect(isSafeEntityName('foo.')).toBe(false)
    expect(isSafeEntityName('foo ')).toBe(false)
  })

  it('控制字符不合法', () => {
    expect(isSafeEntityName('a\u0000b')).toBe(false)
    expect(isSafeEntityName('a\u001fb')).toBe(false)
  })

  it('中间的点合法（v1.2-notes）', () => {
    expect(isSafeEntityName('v1.2-notes')).toBe(true)
  })
})

describe('导出的常量', () => {
  it('EXTENSION_FORMAT_VERSION = 1', () => {
    expect(EXTENSION_FORMAT_VERSION).toBe(1)
  })

  it('EXTENSION_MANIFEST_FILE = "extension.json"', () => {
    expect(EXTENSION_MANIFEST_FILE).toBe('extension.json')
  })

  it('MODULE_MANIFEST_FILE = "module.json"', () => {
    expect(MODULE_MANIFEST_FILE).toBe('module.json')
  })

  it('EXTENSION_CONTENT_KEYS 六类', () => {
    expect(EXTENSION_CONTENT_KEYS).toEqual(['presets', 'skills', 'mcp', 'plugins', 'themes', 'ui'])
  })
})
