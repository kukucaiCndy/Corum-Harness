/**
 * 标题栏「红绿灯让位」宽度的判据（纯函数，便于单元断言）。
 *
 * ## 为什么单独成文件
 * 这是一个**几何安全**判据：它错了不会报错，只会让窗口控制按钮压到 macOS 红绿灯上。
 * 抽成不依赖 React / CSS module 的纯函数后，`tests/traffic-light-inset.spec.ts` 能把
 * 「桥不可用时往哪边倒」这条分支直接钉死。
 *
 * ## 让位是干什么的
 * macOS 用 `titleBarStyle: 'hiddenInset'` 把系统红绿灯内联进内容区
 * （`trafficLightPosition{12,13}`，灯实占 x=12..67）。渲染层因此必须在标题栏最左
 * 让出这条宽度，控件层才能从它右边开始排——折叠/展开按钮落在 x=80（让位 76 + 间距 4）。
 * Windows / Linux 是系统标题栏、没有灯可让，让位必须是 0，否则顶上留一条无主的空白。
 *
 * @module corum-ui-titlebar/client/traffic-light-inset
 */

/** 红绿灯让位宽（主窗）：76 = 活动栏宽（两列上下对齐）。 */
const MAIN_INSET = 76
/** 浮窗自带顶栏的让位（浮窗红绿灯位更靠左）。 */
const FLOATING_INSET = 66

/** 桥上平台字样（`window.corumDesktop.getPlatform()` 的返回域）。 */
export type BridgePlatform = 'darwin' | 'linux' | 'win32'

/** 判据的输入（全部可注入，测试无需真 window）。 */
export interface TrafficLightInsetInput {
  /** `window.corumDesktop` 的存在性（preload 是否加载）。 */
  readonly bridge: { readonly getPlatform?: (() => BridgePlatform) | undefined } | undefined
  /** `navigator.userAgent`（桥不可用时的次选事实源）。 */
  readonly userAgent: string
}

/**
 * 红绿灯让位宽（按平台）。
 *
 * **判据优先级与「往哪边倒」**（2026-10-09 缺陷收口）：
 * 1. 桥可用 ⇒ 以 `getPlatform()` 为唯一权威（= host `process.platform` 的同一事实）：
 *    darwin 让位、其余 0。
 * 2. 桥**不可用** ⇒ 退回 `navigator.userAgent` 粗判，而**不是**直接返回 0。
 *    这一条修正了一个真实缺陷：原实现写的是「不是 darwin ⇒ 0」，把「确认不是 macOS」
 *    与「读不到平台」混成一件事，于是桥一缺席就 fail-open 到 0 —— 在 macOS 上
 *    折叠按钮随即落进红绿灯带（实测 inset=0 ⇒ 按钮 x=4..32，而灯占 x=12..67，正好压上，
 *    即用户报的「红绿灯和折叠按钮重叠」）。
 *    前提是真实存在的：preload 随**壳**重建、渲染层 bundle 随**各插件包**重建，
 *    两者版本天然可以不同步（dev 态更是各自热更），于是「有渲染层、没有新桥」是常态而非异常。
 * 3. UA 也判不出 ⇒ **保留让位**。让位留多了只是顶上一条空白拖拽带（观感损失）；
 *    留少了是控件压在系统按钮上（功能损失）。代价不对称，故倒向安全侧。
 *
 * @param floating - 是否会话浮窗（两处让位宽不同）。
 * @param input - 平台事实源（见 {@link TrafficLightInsetInput}）。
 * @returns 让位宽度（px）。
 */
export function trafficLightInset(
  floating: boolean,
  input: TrafficLightInsetInput,
): number {
  const reserve = floating ? FLOATING_INSET : MAIN_INSET
  const platform = input.bridge?.getPlatform?.()
  if (platform !== undefined) return platform === 'darwin' ? reserve : 0
  const ua = input.userAgent
  if (/Mac|iPhone|iPad/i.test(ua)) return reserve
  if (/Linux|Windows|Android|CrOS/i.test(ua)) return 0
  return reserve
}

/**
 * 从真实运行环境读 {@link TrafficLightInsetInput} 并给出主窗/浮窗的让位宽。
 *
 * `typeof window === 'undefined'`（SSR / 非浏览器）按 macOS 保留让位——与
 * {@link trafficLightInset} 的「判不出就保留」同一条安全侧约定。
 *
 * @param floating - 是否会话浮窗。
 * @returns 让位宽度（px）。
 */
export function resolveTrafficLightInset(floating: boolean): number {
  if (typeof window === 'undefined') return floating ? FLOATING_INSET : MAIN_INSET
  return trafficLightInset(floating, {
    bridge: (window as unknown as { corumDesktop?: { getPlatform?: () => BridgePlatform } }).corumDesktop,
    userAgent: navigator.userAgent ?? '',
  })
}
