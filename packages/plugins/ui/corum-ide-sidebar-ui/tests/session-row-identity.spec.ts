/**
 * 会话行可访问标识（2026-10-29 补）：`data-session-id` + `aria-current`。
 *
 * ## 为什么需要（不是「为测试开的洞」）
 *
 * 侧栏是 fork 自研列表（官方三栏壳的行契约不适用），行上原先只有哈希过的 CSS 类名
 * （`srActive`）与**可重命名、可重复**的标题文本 ⇒ 无障碍读不到「当前会话」，验收/
 * 自动化也无法区分两条同标题会话（都叫「新会话」）。两个属性都是数据的机械投影。
 *
 * 判据放在纯函数上而不是渲染树上：本仓组件测试工具链只有 `renderToStaticMarkup`，
 * 而会话列表组件用 `useSyncExternalStore`（服务端渲染需要 getServerSnapshot，本组件
 * 不提供）⇒ 列表组件无法在单测里渲染。属性来源只有 `sessionRowIdentity` 一处，
 * 渲染侧 `{...sessionRowIdentity(id, active)}`，故这条单测就是该 DOM 契约的守卫。
 *
 * @module @corum/corum-ide-sidebar-ui/tests/session-row-identity
 */
import { describe, expect, it } from 'vitest'
import { sessionRowIdentity } from '../src/client/session-row-identity.ts'

describe('sessionRowIdentity', () => {
  it('每行都带稳定的 data-session-id（id 原文，不做任何改写）', () => {
    expect(sessionRowIdentity('corum-task-abc123', false)['data-session-id']).toBe('corum-task-abc123')
  })

  it('当前会话带 aria-current="true"', () => {
    expect(sessionRowIdentity('corum-task-abc123', true)['aria-current']).toBe('true')
  })

  it('非当前会话不带 aria-current（不写 false —— 与 HTML 语义一致）', () => {
    expect('aria-current' in sessionRowIdentity('corum-task-abc123', false)).toBe(false)
  })

  it('两条同标题会话仍可区分（标题不参与身份）', () => {
    const first = sessionRowIdentity('corum-task-a', false)
    const second = sessionRowIdentity('corum-task-b', false)
    expect(first['data-session-id']).not.toBe(second['data-session-id'])
  })
})
