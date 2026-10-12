/**
 * corum-ui-commit-card 国际化键集合守卫 + 三态文案映射。
 *
 * 缺键 = 某语言下露出原始 key（用户看到 `pending` 这种 key 字面量而不是「待提交」）。
 * zh 是键集合的事实源（`satisfies Record<string, string>`），en 是
 * `Record<CommitCardKey, string>`——typecheck 层已强制 en 覆盖全部 zh 键，但这是一道
 * **运行期**防回归：有人把 zh 改成内联字面量丢了 `satisfies`、或 en 被改成 `Record<string,
 * string>` 宽类型，typecheck 就拦不住了；本测试钉死「两份字典键集合必须严格一致」。
 *
 * 同时钉三态（pending/progress/done）→ 文案的映射：CommitCard.tsx 的 chipText 用的是
 * **硬编码中文字面量**（不走 i18n），而 locales.ts 也存了一份同语义的文案——这两份
 * 必须对得上，否则中文界面的 chip 与卡片标题对不上（见 CommitCard.tsx 的 chipText）。
 */
import { describe, expect, it } from 'vitest'
import { en, zh, NS, type CommitCardKey } from '../src/client/locales.ts'

describe('zh 与 en 键集合一致（缺键 = 某语言露原始 key）', () => {
  const zhKeys = Object.keys(zh).sort() as CommitCardKey[]
  const enKeys = Object.keys(en).sort() as CommitCardKey[]

  it('★ zh 与 en 键集合逐字一致', () => {
    expect(enKeys).toEqual(zhKeys)
  })

  it('★ 包含三态键（pending / progress / done）', () => {
    for (const k of ['pending', 'progress', 'done'] as const) {
      expect(zhKeys, `zh 缺 ${k}`).toContain(k)
      expect(enKeys, `en 缺 ${k}`).toContain(en[k] ? k : '')
    }
  })

  it('★ 包含标题与命名空间键（ns / title）', () => {
    expect(zhKeys).toContain('ns')
    expect(zhKeys).toContain('title')
  })

  it('NS 常量逐字为 "commitCard"（LocaleNamespaceMap 注册键）', () => {
    expect(NS).toBe('commitCard')
    expect(zh.ns).toBe('commitCard')
    expect(en.ns).toBe('commitCard')
  })
})

describe('三态 → 文案映射（与 CommitCard.tsx chipText 同语义）', () => {
  // CommitCard.tsx 的 chipText 用硬编码中文字面量（不走 i18n），locales 存的是同语义的
  // i18n 版。两份必须对得上：zh.pending === chipText('pending')，否则中文界面 chip 与
  // 标题文案分叉。这里钉 zh 字面量 + en 语义存在。
  it('★ pending: zh="待提交" en 有值', () => {
    expect(zh.pending).toBe('待提交')
    expect(en.pending.length).toBeGreaterThan(0)
  })

  it('★ progress: zh="进行中" en 有值', () => {
    expect(zh.progress).toBe('进行中')
    expect(en.progress.length).toBeGreaterThan(0)
  })

  it('★ done: zh="已完成" en 有值', () => {
    expect(zh.done).toBe('已完成')
    expect(en.done.length).toBeGreaterThan(0)
  })

  it('title: zh="整理改动并提交" en 有值', () => {
    expect(zh.title).toBe('整理改动并提交')
    expect(en.title.length).toBeGreaterThan(0)
  })

  it('★ en 三态文案与 zh 不串档（不是同义互用——防翻译表贴错列）', () => {
    // pending 的 en 不该等于 progress 的 en（防贴错列）
    expect(en.pending).not.toBe(en.progress)
    expect(en.progress).not.toBe(en.done)
    expect(en.pending).not.toBe(en.done)
  })
})
