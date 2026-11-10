/**
 * P1（2026-11-01）**终端/编辑器「首击死点击」**修复的机器验证。
 *
 * ## 缺陷形态（源码可判定）
 *
 * `AppFrame.tsx` 的 `toggleRegionVisibility` 旧判据只看 `userShown`（= 「用户点亮过」
 * 的意图），而面板头的 × 走 `ctx.layout.closeRegion` → `onCloseSlot`，那里**只写
 * `leaf.hidden=true`、不碰 `userShown`**。于是「点亮过 → 点 × 关掉 → 点标题栏
 * 显示/隐藏 终端」的**第一次点击被判成「显示中 ⇒ 隐藏」，实际不可见 ⇒ 空操作**，
 * 用户必须连点两次。
 *
 * ## 这里钉住什么
 *
 *   ① 纯判据 `isRegionVisible` / `decideRegionToggle` 的**实际状态矩阵**
 *      （leaf.hidden × userShown × hiddenByDefault × leaf 是否存在）；
 *   ② 真实点击序列：`leaf.hidden=true + userShown 含它` ⇒ **首击 show**；
 *      显示后 `leaf.visible + userShown 含它` ⇒ **第二击 hide**；
 *   ③ 编辑器（corum.editor）与终端（corum.panel）**同一条路径、同一结论**（不回归）；
 *   ④ leaf 缺失 ⇒ 决策 `undefined`（调用方告警 + no-op，**不假写成功**）；
 *   ⑤ 接线不变式：AppFrame 的 toggle 走 `decideRegionToggle`，且不再出现
 *      「只看 userShown.has」的旧判据 / 不用 `location.reload()` 兜底；
 *   ⑥ 文案不变式：BottomPanel 的 × 关闭文案指向**真实存在**的入口
 *      （标题栏 IconButton 的 「显示/隐藏 终端」），不再提已移除的插件中心视图管理。
 *
 * ⚠️ 这是**源码级 + 纯函数级**验证：它证明判据与文案正确，**不等于**已在实机上
 * 点过一遍（本轮不启动/不驱动实例）。
 * @module @corum/corum-ide-ui/tests/region-visibility-toggle
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  decideRegionToggle,
  isRegionVisible,
  type RegionVisibilityState,
} from '../src/client/region-visibility.ts'

const here = dirname(fileURLToPath(import.meta.url))
/** 工作区 packages/plugins/ui 目录（本包与兄弟插件都在这里）。 */
const UI_PACKAGES = join(here, '..', '..')

/** 造一份区域实际状态（默认 = 在网格里、未被隐藏、用户没点亮、不属默认隐藏）。 */
function state(overrides: Partial<RegionVisibilityState> & { slot: string }): RegionVisibilityState {
  return {
    leafPresent: true,
    leafHidden: false,
    userShown: false,
    defaultHidden: false,
    ...overrides,
  }
}

/**
 * 模拟一次点击对状态的**真实**影响（与 AppFrame 的 showRegion / 隐藏分支一致）：
 * - show：树 hidden=false + 记入 userShown（hiddenByDefault 随之清掉）；
 * - hide：树 hidden=true + 移出 userShown。
 */
function applyToggle(current: RegionVisibilityState): RegionVisibilityState {
  const decision = decideRegionToggle([current])
  expect(decision).toBeDefined()
  if (decision === undefined) return current
  return decision.action === 'show'
    ? { ...current, leafHidden: false, userShown: true }
    : { ...current, leafHidden: true, userShown: false }
}

describe('isRegionVisible：实际状态矩阵（leaf.hidden / userShown / hiddenByDefault）', () => {
  it('① leaf.hidden=true + userShown 含它 ⇒ **不可见**（旧判据在这里撒谎）', () => {
    expect(isRegionVisible(state({ slot: 'corum.panel', leafHidden: true, userShown: true, defaultHidden: true }))).toBe(false)
    expect(isRegionVisible(state({ slot: 'corum.editor', leafHidden: true, userShown: true, defaultHidden: true }))).toBe(false)
    // 默认隐藏清单外的区域同理：树里 hidden 就是不可见（与 userShown 无关）。
    expect(isRegionVisible(state({ slot: 'corum.trajectory', leafHidden: true, userShown: true, defaultHidden: false }))).toBe(false)
  })

  it('② leaf.visible + userShown 含它 ⇒ 可见（再点才该隐藏）', () => {
    expect(isRegionVisible(state({ slot: 'corum.panel', userShown: true, defaultHidden: true }))).toBe(true)
    expect(isRegionVisible(state({ slot: 'corum.editor', userShown: true, defaultHidden: true }))).toBe(true)
    expect(isRegionVisible(state({ slot: 'corum.trajectory', userShown: true, defaultHidden: false }))).toBe(true)
  })

  it('③ hiddenByDefault（在默认隐藏清单里且用户没点亮）⇒ 不可见，即使 leaf.hidden=false', () => {
    expect(isRegionVisible(state({ slot: 'corum.panel', userShown: false, defaultHidden: true }))).toBe(false)
    expect(isRegionVisible(state({ slot: 'corum.editor', userShown: false, defaultHidden: true }))).toBe(false)
  })

  it('④ 不在默认隐藏清单、未隐藏、未点亮 ⇒ 可见（如侧栏/轨迹）', () => {
    expect(isRegionVisible(state({ slot: 'corum.sidebar', userShown: false, defaultHidden: false }))).toBe(true)
  })

  it('⑤ leaf 缺失 ⇒ 一律不可见（不管其它三个标志）', () => {
    for (const leafHidden of [false, true]) {
      for (const userShown of [false, true]) {
        for (const defaultHidden of [false, true]) {
          expect(isRegionVisible({
            slot: 'corum.panel', leafPresent: false, leafHidden, userShown, defaultHidden,
          })).toBe(false)
        }
      }
    }
  })

  it('⑥ 16 种组合的完整真值表（唯一判据，防后续重构悄悄改语义）', () => {
    const rows: Array<[boolean, boolean, boolean, boolean, boolean]> = []
    for (const leafPresent of [false, true]) {
      for (const leafHidden of [false, true]) {
        for (const userShown of [false, true]) {
          for (const defaultHidden of [false, true]) {
            const expected = leafPresent && !leafHidden && !(defaultHidden && !userShown)
            rows.push([leafPresent, leafHidden, userShown, defaultHidden, expected])
            expect(
              isRegionVisible({ slot: 's', leafPresent, leafHidden, userShown, defaultHidden }),
              `leafPresent=${leafPresent} leafHidden=${leafHidden} userShown=${userShown} defaultHidden=${defaultHidden}`,
            ).toBe(expected)
          }
        }
      }
    }
    expect(rows).toHaveLength(16)
  })
})

describe('decideRegionToggle：首击必须是 show（P1 死点击）', () => {
  it('① × 关掉后（leaf.hidden=true + userShown 含它）首击 = show，第二击 = hide', () => {
    for (const slot of ['corum.panel', 'corum.editor']) {
      // 用户点亮过（userShown 含它），随后点面板头 × 关掉（只写 leaf.hidden=true）。
      const afterClose = state({ slot, leafHidden: true, userShown: true, defaultHidden: true })

      // 首击：必须显示（旧实现在这里返回「隐藏」⇒ 空操作 ⇒ 用户看到的死点击）。
      const first = decideRegionToggle([afterClose])
      expect(first?.action, `first click on ${slot}`).toBe('show')
      expect(first?.slots).toEqual([slot])

      // plot 一次点击后的真实状态：树 hidden=false + userShown 保留/写入。
      const afterFirst = applyToggle(afterClose)
      expect(isRegionVisible(afterFirst)).toBe(true)

      // 第二击：才是隐藏。
      expect(decideRegionToggle([afterFirst])?.action, `second click on ${slot}`).toBe('hide')
      const afterSecond = applyToggle(afterFirst)
      expect(isRegionVisible(afterSecond)).toBe(false)
    }
  })

  it('② 点亮中（leaf.visible + userShown 含它）⇒ hide（不回归）', () => {
    const visible = state({ slot: 'corum.panel', userShown: true, defaultHidden: true })
    expect(decideRegionToggle([visible])?.action).toBe('hide')
  })

  it('③ 默认隐藏、从没被点亮（hiddenByDefault）⇒ show', () => {
    const byDefault = state({ slot: 'corum.panel', userShown: false, defaultHidden: true })
    expect(decideRegionToggle([byDefault])?.action).toBe('show')
  })

  it('④ 在网格里且没被默认隐藏（如轨迹/sidebar）⇒ hide', () => {
    expect(decideRegionToggle([state({ slot: 'corum.trajectory', defaultHidden: false })])?.action).toBe('hide')
  })

  it('⑤ leaf 缺失 ⇒ undefined（调用方告警 no-op，绝不假写成功）', () => {
    expect(decideRegionToggle([state({ slot: 'corum.panel', leafPresent: false, defaultHidden: true })])).toBeUndefined()
  })

  it('⑥ 组内部分 leaf 缺失：只对存在的那些动手；任一可见 ⇒ 全隐藏', () => {
    const decision = decideRegionToggle([
      state({ slot: 'corum.editor', leafPresent: false, defaultHidden: true }),
      state({ slot: 'corum.panel', userShown: true, defaultHidden: true }),
    ])
    expect(decision).toEqual({ action: 'hide', slots: ['corum.panel'] })

    const missingAll = decideRegionToggle([
      state({ slot: 'corum.editor', leafPresent: false, defaultHidden: true }),
      state({ slot: 'corum.panel', leafPresent: false, defaultHidden: true }),
    ])
    expect(missingAll).toBeUndefined()
  })
})

describe('接线 + 文案不变式（源码级）', () => {
  const appFrame = readFileSync(join(here, '..', 'src', 'client', 'AppFrame.tsx'), 'utf8')
  const bottomPanel = readFileSync(
    join(UI_PACKAGES, 'corum-ide-panel-bottom-ui', 'src', 'client', 'BottomPanel.tsx'),
    'utf8',
  )
  const titleBar = readFileSync(
    join(UI_PACKAGES, 'corum-ui-titlebar', 'src', 'client', 'TitleBar.tsx'),
    'utf8',
  )

  /** 取 `toggleRegionVisibility` 回调体的源码切片。 */
  function toggleBody(): string {
    const start = appFrame.indexOf('const toggleRegionVisibility = useCallback(')
    expect(start, 'toggleRegionVisibility not found').toBeGreaterThanOrEqual(0)
    const end = appFrame.indexOf('\n  }, [userShown, showRegion, saveIdeGrid])', start)
    expect(end, 'toggleRegionVisibility end not found').toBeGreaterThan(start)
    return appFrame.slice(start, end)
  }

  it('① AppFrame 的 toggle 用纯判据 decideRegionToggle，而不是只看 userShown', () => {
    const body = toggleBody()
    expect(body).toContain('decideRegionToggle(')
    // 旧判据的原文形态（`slots.some((s) => userShown.has(s))`）不该再出现。
    expect(body).not.toContain('slots.some((s) => userShown.has(s))')
    // 三份实际状态都进了判据输入（缺一不可）。
    expect(body).toContain('leafHidden:')
    expect(body).toContain('userShown:')
    expect(body).toContain('defaultHidden:')
  })

  it('② leaf 缺失时不假写成功：决策 undefined 早退，且不做 location.reload 兜底', () => {
    const body = toggleBody()
    expect(body).toContain('decision === undefined')
    expect(body).toContain('console.warn')
    expect(appFrame).not.toContain('location.reload(')
  })

  it('③ BottomPanel 的 × 文案指向**真实存在**的标题栏入口「显示/隐藏 终端」', () => {
    // 真实入口就在标题栏 IconButton（点 corum.panel 的 toggleRegion）。
    expect(titleBar).toContain('label="显示/隐藏 终端"')
    expect(titleBar).toContain("toggleRegion('corum.panel')")
    // 文案与入口同名，且不再提已移除的插件中心视图管理。
    expect(bottomPanel).toContain('显示/隐藏 终端')
    expect(bottomPanel).not.toContain('视图管理')
  })
})
