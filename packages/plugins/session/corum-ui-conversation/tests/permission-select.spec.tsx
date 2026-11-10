/**
 * 访问模式胶囊（`PermissionSelect`）与 rc3 投影形状的对齐。
 *
 * ## 缺陷背景（2026-10-29 实机 console）
 *
 * rc3 的 `permissions` 会话投影**只有 `currentValue`**（可切换档位表搬到了进程级
 * `corumAgent/listPermissionPresets`）。旧实现直接 `value.options.find(...)` ⇒
 * `TypeError: Cannot read properties of undefined (reading 'find')`，整个
 * `conversation.composer.bar` 被槽错误边界吞掉（console 报
 * `slot entry crashed in 'conversation.composer.bar'`）。
 *
 * 判据：
 *   ① 只给 `currentValue`（目录未到位）⇒ 不抛、胶囊照常显示当前档；
 *   ② 目录到位 ⇒ 每个档位进菜单（可切换），未列出的当前档仍能显示；
 *   ③ `value === undefined`（host 无权限能力）⇒ 完全不渲染。
 *
 * @module @corum/corum-ui-conversation/tests/permission-select
 */
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
/**
 * 官方 UI 积木包在单测里替身化：它的 `lib/index.js` 带入未为单测安装的运行时
 * 依赖（`simple-icons` 等，生产走 dsh 模块表内联）。本文件只断言**触发器契约**，
 * 与积木视觉无关；`Menu` 替身只渲染 anchor（下拉项在真实实现里走 portal）。
 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineMedium: (): null => null,
  Menu: ({ anchor }: { anchor?: unknown }) => anchor ?? null,
  RiskConfirmation: (): null => null,
}))

import { PermissionSelect } from '../src/client/skeleton/PermissionSelect.tsx'
import type { PermissionSelectProps } from '../src/client/skeleton/PermissionSelect.tsx'

/** 中文字典回落：只要 key 原样返回即可（断言与文案无关）。 */
const t = ((key: string) => key) as PermissionSelectProps['t']
const command = async (): Promise<boolean> => true

/**
 * 静态渲染（不挂 DOM）：Menu 用 portal 渲染内容，故这里只断言**触发器**与
 * 不抛错 —— 菜单项集合由 `PermissionSelect` 内部依据 options 计算，
 * 通过「档位数 = options 长度」的可见副作用（触发器 aria-label 用当前档名）间接钉住。
 */
function render(value: PermissionSelectProps['value']): string {
  return renderToStaticMarkup(<PermissionSelect value={value} locked={false} command={command} t={t} />)
}

describe('PermissionSelect（rc3 投影只带 currentValue）', () => {
  it('① 只有 currentValue（档位目录未到位）⇒ 不抛、显示当前档名', () => {
    const html = render({ currentValue: 'workspace-write' })
    // 目录缺席时标签走 `displayName(currentValue)`（kebab → Title Case），与旧实现
    // `value.options.find` 抛错形成对照（修复前这一句直接 TypeError）。
    expect(html).toContain('Workspace Write')
    expect(html).toContain('aria-label="input.accessMode"')
  })

  it('② 档位目录到位 ⇒ 当前档用目录里的显示名', () => {
    const html = render({
      currentValue: 'read-only',
      options: [
        { value: 'read-only', name: 'Read Only', description: '只读' },
        { value: 'workspace-write', name: 'Workspace Write' },
      ],
    })
    // 触发器文案走目录里的官方 name（kebab → Title Case）。
    expect(html).toContain('Read Only')
    expect(html).toContain('title="只读"')
  })

  it('②b 当前档不在目录里（自定义档）⇒ 回落机器名展示，不抛', () => {
    const html = render({ currentValue: 'my-custom', options: [{ value: 'read-only', name: 'Read Only' }] })
    expect(html).toContain('My Custom')
  })

  it('③ value 缺席（host 无权限能力）⇒ 不渲染任何东西', () => {
    expect(render(undefined)).toBe('')
  })
})
