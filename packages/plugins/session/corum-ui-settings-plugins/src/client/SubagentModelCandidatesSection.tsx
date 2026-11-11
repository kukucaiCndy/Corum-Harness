/**
 * 「子 Agent 候选模型」settings section —— 全局候选集的**可达入口**（issue #165）。
 *
 * 薄适配，没有第二套状态：`SubagentModelSelectionCard` 的 props 面（卡片 owner 面 +
 * 本包 locale + 注入的业务面）恰好被 section 的 props 面覆盖（section 只多一个
 * `close`），故直接把 section props 透传给卡片，不复制任何渲染或舞台逻辑。
 *
 * 为什么需要一个 section 而不是留在 `settings.plugin.item`：那个子槽今天**没有渲染
 * 者**（渲染它的 ExtensionsSection 已随「插件管理」分区于 2026-10-03 移除）⇒ 注册了
 * 也看不见。section 自带导航入口，是这张卡第一次真正可用。
 */

import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentModelSelectionCardFace } from './subagent-model-selection-card-controller.ts'
import { SubagentModelSelectionCard } from './SubagentModelSelectionCard.tsx'
import css from './SubagentModelSelectionCard.module.css'

/** Props the settings shell binds for this section. */
export type SubagentModelCandidatesSectionProps =
  PropsLocale<'settings.plugins'>
  & InjectFace<SubagentModelSelectionCardFace>

/**
 * Render the global candidate-set preference as its own settings section.
 * @param props - locale copy and the card's staged actions.
 * @returns the card wrapped in a single-card list.
 */
export function SubagentModelCandidatesSection(props: SubagentModelCandidatesSectionProps) {
  return (
    <ul className={css.cards}>
      {/* 卡片本体渲染 `<li>`（列表形态），故外面必须有列表容器。 */}
      <SubagentModelSelectionCard {...props} />
    </ul>
  )
}