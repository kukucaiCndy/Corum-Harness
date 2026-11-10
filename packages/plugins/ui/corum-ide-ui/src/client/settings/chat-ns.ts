/**
 * `chat` 设置命名空间的**解析**（轨迹视图等对话显示偏好的真源定位）。
 *
 * ## 为什么需要这个模块（真实缺陷，2026-11-07 实测）
 *
 * `SettingsAdvancedSection` 曾把 `CHAT_NS` 硬编码成 `'ui-chat'`。rc3 起 **ns = entry id**：
 * IDE overlay（`cordis.ide.patch.yml`）插入的是 `corum-chat`（name `@corum/corum-ui-chat`），
 * 而官方 `ui-chat` 行在 IDE 模式下**被禁用** —— 于是：
 *   - 读：`snapshot.view.namespaces` 里没有 `ui-chat` ⇒ 表达式恒回退默认值 `compact`
 *     （界面上看起来「正常」，因为默认值就是 compact）；
 *   - 写：`settings.mutate('ui-chat', …)` 直接抛
 *     `No configurable plugin entry "ui-chat"` ⇒ **开关永远不落盘**。
 * 实测证据：改「轨迹视图」→ 下拉文案不变、无「已修改」徽标、分区顶部出现该错误文案
 *（对应用例 E21，见 docs/evidence/rc3-settings-behavior-batch1-2026-11-07.md）。
 *
 * ## 为什么不直接改成 `'corum-chat'`
 *
 * **最小模式（minimal）不装 IDE overlay**，那里的 `corum-chat` 行不存在、官方 `ui-chat`
 * 行仍活跃（见 `corum-ui-chat/src/chat-settings.ts` 的同一段注释）。硬编码任一单个 id
 * 都会在另一种模式下复现同一缺陷。
 *
 * ## 因此：**按候选列表解析实际在册的那个 ns**
 *
 * 顺序固定为「rc3 IDE 的 `corum-chat` → 官方兜底 `ui-chat`」，取**第一个在册**的；
 * 两个都没有时返回 `undefined`，由调用方如实报错（不猜、不回退到写一个不存在的 ns）。
 *
 * @module corum-ide-ui/client/settings/chat-ns
 */

/**
 * 候选命名空间，**按优先级**排列。
 *
 * - `corum-chat`：rc3 IDE 模式（ns = entry id）下真实在册的那个；
 * - `ui-chat`：官方/minimal 模式下在册的那个（历史值，保留作兜底）。
 */
export const CHAT_NS_CANDIDATES = ['corum-chat', 'ui-chat'] as const

/** 只有 `ns` 字段被用到，故只要求这一项（便于单测传入最小对象）。 */
export interface NamespaceLike {
  readonly ns: string
}

/**
 * 从「当前在册的命名空间列表」里解析出对话设置的真实 ns。
 *
 * @param namespaces - `settings.describe` 快照里的命名空间列表（可为 undefined）
 * @returns 第一个在册的候选；一个都没在册时返回 `undefined`
 */
export function resolveChatNamespace<T extends NamespaceLike>(
  namespaces: readonly T[] | undefined,
): T | undefined {
  if (namespaces === undefined) return undefined
  for (const candidate of CHAT_NS_CANDIDATES) {
    const hit = namespaces.find(n => n.ns === candidate)
    if (hit !== undefined) return hit
  }
  return undefined
}
