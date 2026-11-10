/**
 * 区域显隐的**纯判据**（P1「终端首击死点击」修复，2026-11-01）。
 *
 * ## 修的是什么
 *
 * 标题栏「显示/隐藏 终端」（`ctx.layout.toggleRegion('corum.panel')`）此前只按
 * `userShown` 判断显隐：
 *
 * ```
 * const anyShown = slots.some((s) => userShown.has(s))
 * if (anyShown) → 隐藏；else → 显示
 * ```
 *
 * 而 `userShown` 只是「用户点亮过」的**意图**，不是「此刻可见」的**事实**。区域一旦
 * 被 `ctx.layout.closeRegion`（面板头 × 按钮）关掉，那里**只写 `leaf.hidden=true`、
 * 不碰 `userShown`**，于是：
 *
 * | 状态 | 旧判据 | 真实可见 | 结果 |
 * |---|---|---|---|
 * | `leaf.hidden=true` + `userShown` 含它 | 「显示中」→ 隐藏 | 不可见 | **首击死点击**（再点一次才出来） |
 *
 * 用户在终端/编辑器上点一次 ×、再点一次标题栏按钮，**第一次永远没反应**。
 *
 * ## 现在的判据
 *
 * 「此刻可见」= leaf 在网格里 **且** 树里没被隐藏 **且** 不属于「默认隐藏且用户没点亮」：
 *
 * ```
 * visible = leafPresent && !leafHidden && !(defaultHidden && !userShown)
 * ```
 *
 * 三个实际状态（`leaf.hidden` / `hiddenByDefault` / `userShown`）都在这里合成——
 * 调用方只提供**原始事实**，判定只有这一处（AppFrame 的 toggle 与测试读同一份）。
 *
 * 切换语义（与既有注释一致）：一组 slot 里**任一可见 ⇒ 全隐藏**；全都不可见 ⇒ 全显示。
 * leaf 缺失（detached / 浮窗 / 尚未注册）的 slot 不参与——**绝不假写成功**：
 * `setLeafHidden` 在树里找不到 leaf 时会原样返回，若照样把 slot 记进 `userShown`
 * 就是「点了没反应但状态变了」的假成功。全部缺失 ⇒ 调用方告警并 no-op。
 *
 * @module @corum/corum-ide-ui/client/region-visibility
 */

/**
 * 一个区域的**实际状态**（全部是事实，不是意图）。
 *
 * 注意 `leafHidden` 与 `userShown` 可以同时为真——那正是本模块要修的组合
 * （树里关掉了，但用户曾经点亮过）。
 */
export interface RegionVisibilityState {
  /** 网格槽位名（只用于回填返回值的 slot 列表，不参与判定）。 */
  readonly slot: string
  /** 网格树里有该 slot 的 leaf（缺 = detached / 浮窗 / 还没注册）。 */
  readonly leafPresent: boolean
  /** leaf.hidden——树里持久化的显式隐藏（× 关闭写的就是这个）。 */
  readonly leafHidden: boolean
  /** 用户在 `userShown` 里点亮过它。 */
  readonly userShown: boolean
  /** 该 slot 属于「默认隐藏」清单（如 corum.editor / corum.panel / corum.trajectory）。 */
  readonly defaultHidden: boolean
}

/** 该区域**此刻真的可见**吗（所有显示路径（含默认隐藏）合成后的唯一判据）。 */
export function isRegionVisible(state: RegionVisibilityState): boolean {
  if (!state.leafPresent) return false
  if (state.leafHidden) return false
  // hiddenByDefault = defaultHidden && !userShown（本函数内联，避免调用方各算一遍）。
  if (state.defaultHidden && !state.userShown) return false
  return true
}

/** 一次切换的结论：动作 + 参与动作的 slot（leaf 存在的那些）。 */
export interface RegionToggleDecision {
  readonly action: 'show' | 'hide'
  readonly slots: readonly string[]
}

/**
 * 决定一组 slot 的切换动作。
 *
 * @returns `undefined` = 一个 leaf 都不在网格里（调用方应告警并 no-op，
 *   **不要**把 slot 写进 `userShown` 造成假成功）。
 */
export function decideRegionToggle(
  states: readonly RegionVisibilityState[],
): RegionToggleDecision | undefined {
  const present = states.filter((state) => state.leafPresent)
  if (present.length === 0) return undefined
  return {
    action: present.some((state) => isRegionVisible(state)) ? 'hide' : 'show',
    slots: present.map((state) => state.slot),
  }
}
