/**
 * fork（corum）：todo 清单维护纪律段（2026-10-12 用户定调）。
 *
 * ## 为什么需要这一层（issue #2 的根因面）
 *
 * issue #2「任务已经做完，但进度条依然显示进行中」经取证**不是面板/投影 BUG**：面板计数
 * 直接来自 `todos` 投影，官方投影刻意在 `turn/end` 保留刚完成的清单，官方 dsh 也没有任何
 * turn 收口对账机制。清单陈旧的真正原因是**模型写完之后没再维护它**。
 *
 * 基座（官方 `dsh-tool-todo`）确实有一段「让模型维护清单」的代码——但它**只是一段工具描述**，
 * 渲染进系统提示词的工具清单里（`packages/todo/tool-todo/src/index.ts` 的
 * `DESCRIPTION_HEAD / _SINGLE / _PARALLEL / _TAIL`）：
 *
 * > Record and update a task list to plan multi-step work and show progress; …
 * > While work remains, keep exactly one todo `in_progress`.
 * > Mark each todo `completed` as soon as it is done.
 *
 * 加上工具结果回显计数（`Updated todo list: N pending, N in progress, N completed.`），
 * 这就是基座侧的全部（2026-10-12 全仓核实，无第三处）。
 *
 * **它缺的正是用户点出的那一半**：初版规划常在调查/实现中被推翻——某步证明不必要、拆成两步、
 * 或冒出新的前置——基座那段只讲「边做边更新」，**没有讲计划变更时该怎么办**。于是清单留在旧
 * 计划上、与实际执行分叉，用户看到的就是「做完了却还显示进行中」。
 *
 * 本段补的就是这一层（借基座的杠杆面：提示词侧纪律），与机制侧的
 * `@corum/corum-todo-guard`（turn 收口时对账兜底）配对：**本段管过程、那个管收口**。
 *
 * ## 注册位置与作用域
 *
 * 在 **root scope** 注册一次（`CorumAgentService` 构造期，与工具策略段/执行纪律段同处），
 * 所有 corum 会话与子会话继承。
 *
 * ⚠️ 不按「该 Agent 有没有 todo 工具」做条件渲染：本服务读 `ctx.tools` 会抛
 * `cannot get property "tools" without inject`（同一坑在 {@link TOOL_POLICY_SECTION} 的注册处
 * 已实机抓到过一次，issue #3 是它的另一个现场）。改用**文本层条件句**收口
 * （"When you keep a todo list, …"）：没有该工具的读者不受影响。
 *
 * @module @corum/corum-agent/todo-discipline
 */

/** todo 清单维护纪律段的名字。 */
export const TODO_DISCIPLINE_SECTION = 'corum:todo-discipline'

/**
 * todo 清单维护纪律正文。
 *
 * 写作纪律（docs/PROMPT-INVENTORY.md §0）：模型可见提示词一律英文；只讲「怎么做 + 为什么」，
 * 不夹带实测计数与内部日期（那些属台账，进提示词会被模型当承诺）。
 */
export const TODO_DISCIPLINE_TEXT = [
  'When you keep a todo list, it must stay true as the work changes — a list that drifted from reality is worse than no list.',
  '',
  '- Re-plan as you go. Investigation often overturns the first plan: a step turns out unnecessary, splits in two, or a new one appears. Rewrite the list in that same step instead of cleaning it up at the end.',
  '- Keep exactly one item `in_progress` — the thing you are doing right now. None is fine between steps.',
  '- Mark an item `completed` the moment it is done, not retrospectively; when the turn ends, every finished item is `completed`.',
  '- Never mark work you did not finish as `completed` to make the list look done. If work is genuinely unfinished, leave it `pending` or `in_progress` and say so in your reply.',
  '',
  'Why: the list is the durable record of what you set out to do and the progress signal the user watches. Drift makes every later status report suspect, and it is harder to spot than a missing list.',
].join('\n')
