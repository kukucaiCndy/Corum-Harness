/**
 * 会话行的**可访问标识**（单一事实源）。
 *
 * ## 为什么单独成函数（2026-10-29）
 *
 * 侧栏是 fork 自研列表，官方三栏壳的 `[data-session-id]` 行契约不适用；行上原先只有
 * 哈希过的 CSS 类名（`srActive`）与**可重命名、可重复**的标题文本 ⇒
 *   · 无障碍：当前打开的会话没有可读状态（读屏软件无从判断）；
 *   · 定位：两条同标题会话（都叫「新会话」）无法区分，验收/自动化只能靠猜。
 *
 * 两个属性都是数据的机械投影，不改任何交互：
 *   · `data-session-id` = 会话 id 原文（稳定、唯一）；
 *   · `aria-current="true"` = 当前打开的会话（非当前行**不写**该属性，
 *     而不是写 `false` —— 与 HTML 语义一致，避免把「非当前」暴露成状态值）。
 *
 * 抽成纯函数是为了让「属性从哪来」只有一处，并能被不依赖 DOM 的单测钉住
 * （本仓的组件测试工具链只有 `renderToStaticMarkup`，不支持 `useSyncExternalStore`
 * 的会话列表组件 —— 见 tests/session-row-identity.spec.ts）。
 *
 * @module @corum/corum-ide-sidebar-ui/client/session-row-identity
 */

/** 会话行上承载身份/当前态的 DOM 属性。 */
export interface SessionRowIdentity {
  readonly 'data-session-id': string
  readonly 'aria-current'?: 'true'
}

/**
 * 会话行的身份属性。
 * @param sessionId - 会话 id（`SessionSummary.id` 的字符串形态）。
 * @param active - 该行是否就是当前打开的会话。
 * @returns 可直接展开到行元素上的属性集。
 */
export function sessionRowIdentity(sessionId: string, active: boolean): SessionRowIdentity {
  return {
    'data-session-id': sessionId,
    ...active ? { 'aria-current': 'true' as const } : {},
  }
}
