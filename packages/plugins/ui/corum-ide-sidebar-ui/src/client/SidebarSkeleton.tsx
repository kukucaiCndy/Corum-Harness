/**
 * SidebarSkeleton — the IDE left column 骨架（design.pen ① 双模式侧栏的壳）。
 *
 * 骨架只做：品牌行（品牌卡 + 版本小字 + 档位徽标）+ 两个子槽渲染
 * （corum.sidebar.sessions / corum.sidebar.project）。内容（会话列表 / 项目模式）
 * 由子槽 occupant 提供——开源版只插 sessions 插件（project 槽空 → 无项目面板，
 * 仅剩任务模式，档位徽标显示「社区版」）。
 *
 * PR1（2026-09）：原 brand-row 的 modeSwitch「项目|任务」滑块**已删除**——模式切换
 * 改由活动栏承担（PR3）。模式状态服务（ctx.layout）与下面的面板联动一行未动：
 * project 槽空时仍强制回落 task（付费插件卸载后的兜底）。
 *
 * 集体脱出：子槽填充物随 corum.sidebar 这一个 grid leaf 的渲染树走，脱出时
 * 整列（含付费版才有项目段）一起进浮动窗，壳无需感知插件拆法。
 *
 * 模式切换反转动画（DESIGN §7.10）：mode 是目标（服务值），restMode
 * 是当前静止面板；两者不一致 = 反转进行中——旧面板 data-flipping="out"（rotateY
 * 0→90° + 淡出 120ms easeIn，绝对定位覆盖在新内容上），新面板 data-flipping="in"
 * （rotateY -90°→0° + 淡入 200ms easeOutExpo，延迟 40ms 起跳 = 与退出重叠 80ms），
 * 总时长后 restMode 对齐 mode。双面板常驻挂载（仅切可见性）保住组件态的语义不变。
 *
 * C3a：模式状态收进 IDE 壳的 cordis 服务（ctx.layout，跨 bundle 单例）——本骨架
 * 经 inject 面的 `useSidebarMode` 选择器 Hook 读（`setSidebarMode` 动作仍由 inject
 * 面提供，供会话域空态操作写同一服务）。原本地 useState + window 全局
 * __corumSidebarMode 广播（空态收敛后已无读端、成死写）已退役。
 *
 * 2026-10（用户区搬家）：PR2 的 footer 用户区**已删除**——账户头像入口与用户
 * 菜单整体搬到活动栏底部（@corum/corum-ide-ui 的 ActivityBar，「检查更新 /
 * 升级 PRO / 设置」等菜单项行为随迁）。本骨架现在到「内容区」为止；footer 相关
 * 样式（sidebar.module.css 的 .sidebarFooter/.footerMenu/.editionBadge 等）暂留
 * 未删，待其它 occupant 引用核对后统一清理。
 */
import { useEffect, useState } from 'react'
import { Copy, Star } from 'lucide-react'
import type { InjectFace, PropsRuntime, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarMode } from '@corum/corum-ide-ui/client'
import type { SidebarSkeletonInjected } from './index.ts'
// 物理相对路径而非 @corum/corum-ui-base 子路径：原因同 ProjectPane.tsx（tsdown
// 跨包 css 子路径 import 错乱，相对路径才能正确抽取内联进 bundle）。
import css from '../../../corum-ui-base/src/client/sidebar.module.css'

/** Composed props: 壳的 owner 面 + 子槽渲染面 + 骨架 inject 面（hooks 室绑定为 use* 选择器 Hook）。 */
export type SidebarSkeletonProps =
  & PropsRuntime<'corum.sidebar'>
  & PropsRenderSlots<'corum.sidebar.sessions' | 'corum.sidebar.project'>
  & InjectFace<SidebarSkeletonInjected>

/** 反转动画总时长：出 120ms + 入 200ms − 重叠 80ms（DESIGN §7.10；reduced-motion 下 CSS 降级为 150ms 纯透明度，仍被覆盖）。 */
const FLIP_TOTAL_MS = 240

/** `window.corumDesktop` 的窄化面（只用到版本号一项；本地能力接口，红线 3）。 */
interface AppVersionFace {
  getAppVersion?: () => Promise<string>
  getDshBaselineVersion?: () => Promise<string | undefined>
  /** `release` = 正式发布产物，`local` = 本地构建（版本号相同，只能靠它区分）。 */
  getBuildChannel?: () => Promise<'release' | 'local'>
  /** 构建时间戳（YYYYMMDDHHmm 格式）。 */
  getBuildTime?: () => Promise<string>
}

/** 诊断信息里的平台标签：UA-CH 优先，回落已废弃但仍普遍可用的 navigator.platform。 */
function platformLabel(): string {
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData
  return uaData?.platform ?? navigator.platform
}

/** The IDE left column skeleton (see module doc). */
export function SidebarSkeleton({ wide, renderSlot, useProjectOccupied, useSidebarMode }: SidebarSkeletonProps) {
  // 侧栏模式：服务的跨 bundle 单例状态（选择器 Hook 订阅）。PR1 起骨架**不再
  // 提供模式切换 UI**（modeSwitch「项目|任务」滑块已删，模式切换改由活动栏承担）；
  // 服务通路原样保留（inject 面的 setSidebarMode 仍可用，会话域空态操作照旧写它）。
  const mode = useSidebarMode(s => s)
  // 落定模式：当前静止展示的面板；反转动画播完后对齐 mode。
  const [restMode, setRestMode] = useState<SidebarMode>('task')
  // 项目槽占用（付费版项目插件插入后为 true）。hooks 室源已由 slots 绑定为选择器 Hook。
  const projectAvailable = useProjectOccupied(s => s)
  // 项目插件被卸载（付费→开源切换）时若正在项目模式，退回任务模式。
  const effectiveMode: SidebarMode = projectAvailable ? mode : 'task'
  const flipping = effectiveMode !== restMode

  // 应用版本号：品牌行挂载时经 window.corumDesktop 拉一次并缓存进 state（非桌面壳 /
  // 老 preload 下没有该方法，静默不显示版本）。
  const [appVersion, setAppVersion] = useState<string | null>(null)
  /**
   * dsh 基座版本：**只进「复制诊断信息」，不在界面单独展示**（用户 2026-10-03 定调
   * 「只显示应用版，基座号藏进诊断信息」）。与应用版号同一个 effect 一并取；
   * 取不到就省略那一段（不编造）。
   */
  const [dshVersion, setDshVersion] = useState<string | null>(null)
  /**
   * 构建渠道：本地包与线上包版本号完全相同，不标出来就分不清手上测的是哪一个
   * （用户 2026-10-17 要求）。`null` = 还没取到或老壳没有该桥，此时不渲染后缀，
   * 避免出现「v0.5.0 · 」这种半截文案。
   */
  const [buildChannel, setBuildChannel] = useState<'release' | 'local' | null>(null)
  /** 构建时间戳（YYYYMMDDHHmm）：让不同构建可分辨（用户 2026-10-28 要求）。 */
  const [buildTime, setBuildTime] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const bridge = (window as unknown as { corumDesktop?: AppVersionFace }).corumDesktop
      try {
        const version = await bridge?.getAppVersion?.()
        if (!cancelled && version !== undefined) setAppVersion(version)
      } catch (error) {
        console.warn('[sidebar] 读取应用版本号失败', error)
      }
      try {
        const dsh = await bridge?.getDshBaselineVersion?.()
        if (!cancelled && dsh !== undefined && dsh !== '') setDshVersion(dsh)
      } catch (error) {
        console.warn('[sidebar] 读取 dsh 基座版本号失败', error)
      }
      try {
        const channel = await bridge?.getBuildChannel?.()
        if (!cancelled && (channel === 'release' || channel === 'local')) setBuildChannel(channel)
      } catch (error) {
        console.warn('[sidebar] 读取构建渠道失败', error)
      }
      try {
        const time = await bridge?.getBuildTime?.()
        if (!cancelled && typeof time === 'string' && time !== '') setBuildTime(time)
      } catch (error) {
        console.warn('[sidebar] 读取构建时间戳失败', error)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // 档位：project 槽空 = 社区版；有 occupant（付费版项目插件）= PRO。
  const edition: 'community' | 'pro' = projectAvailable ? 'pro' : 'community'
  // 版本小字行：「v0.1.0 · 社区版 / PRO」；档位文案与右侧徽标同源（同一 edition 判定）。
  // 版本号异步到位：未到位时不显示「v」，避免出现「v · 社区版」这种半截文案。
  const editionLabel = edition === 'pro' ? 'PRO' : '社区版'
  /**
   * 版本小字：只写版本号本身（如 `v0.1.0`）。
   *
   * **不再带档位后缀**：档位由同一行右侧的徽标表达，早先写成「v0.1.0 · 社区版」
   * 会让「社区版」在同一行出现两次（用户 2026-10-02 报障）。版本号异步到位，
   * 未到位时留空 —— 避免出现「v · 社区版」这种半截文案。
   */
  // 版本号 + 构建标记 + 时间戳：`v0.7.0+20261101`（正式包）/ `v0.7.0-local+20261101`（本地包）。
  // 时间戳让不同构建可分辨（用户 2026-10-28 要求）；用 `+` 分隔符合 semver build 段形态。
  // dev 态没有 buildTime（还没取到）时不拼，避免闪烁。
  const buildSuffix = buildChannel === 'local' ? '-local' : ''
  const timeSuffix = buildTime !== null ? `+${buildTime}` : ''
  const versionLabel = appVersion !== null
    ? `v${appVersion}${buildSuffix}${timeSuffix}`
    : ''

  /** 复制诊断信息（版本 + 平台）到系统剪贴板；剪贴板不可用时只记日志，不打断用户。 */
  const copyDiagnostics = (): void => {
    // 窄化取剪贴板：非 secure context / 老壳下 navigator.clipboard 不存在（拿不到就静默返回）。
    const clipboard = (navigator as unknown as {
      clipboard?: { writeText: (text: string) => Promise<void> }
    }).clipboard
    if (clipboard === undefined) return
    // 诊断串 = 应用版 + dsh 基座版 + 平台（基座号无处展示，只有这里能看到）。
    const baseline = dshVersion !== null ? ` · dsh ${dshVersion}` : ''
    void clipboard.writeText(`Corum v${appVersion ?? 'unknown'}${buildSuffix}${timeSuffix !== '' ? ` (${buildTime})` : ''}${baseline} · ${platformLabel()}`).catch((error: unknown) => {
      console.warn('[sidebar] 复制诊断信息失败', error)
    })
  }

  // 反转收尾：总时长到点后把落定面板对齐目标模式（摘掉 data-flipping、可见性交还 data-active）。
  // 快速往返点击时清理重排：mode 回到 restMode 即刻静止，无残影。
  useEffect(() => {
    if (!flipping) return
    const timer = window.setTimeout(() => { setRestMode(effectiveMode) }, FLIP_TOTAL_MS)
    return () => { window.clearTimeout(timer) }
  }, [flipping, effectiveMode])

  /* ── PR2 footer 用户区（已删除，入口搬活动栏）──────────────────────── */

  /** 一个面板的 data-flipping：静止时无值；反转中 = 自己是旧面（out）还是新面（in）。 */
  const flipStateOf = (paneMode: SidebarMode): 'out' | 'in' | undefined =>
    flipping ? (paneMode === restMode ? 'out' : 'in') : undefined

  return (
    <div className={css.sidebar} data-wide={wide || undefined}>
      {/* brand-row：**纯文案**标题区（用户 2026-10-03：「我感觉这个图片还不如不要，
          直接按照这种用文案描述算了，但是不要那个发现应用」）。
          形态参考 WorkBuddy：上行产品名（主标题）、下行版本号（次级小字）；
          右端是档位徽标 + 复制诊断按钮（用户定调：徽标保留）。
          此前用 2172×724 的品牌卡图片撑满整行，实测过高、视觉压迫，故撤图改文案；
          复制功能保留（只有它需要鼠标悬停才显形，避免常驻图标抢视线）。 */}
      <header className={css.brandRow}>
        <div className={css.brandCol}>
          <div className={css.brandTitleRow}>
            <span className={css.brandName}>Corum Harness</span>
            <span className={css.brandMetaEnd}>
              {/* 档位徽标：两个档位**用同一套结构**（图标 + 文字），只换图标与配色，
                  故视觉重量与基线完全一致（用户 2026-10-03：「注意和 PRO 版本要一致」）。
                  社区版 = 品牌「C」图标（彩色，用户提供的素材）；PRO = 星形。 */}
              <span className={css.editionBadge} data-edition={edition}>
                {edition === 'pro'
                  ? <Star className={css.editionBadgeIcon} size={14} strokeWidth={2} aria-hidden="true" />
                  : <img className={css.editionBadgeIcon} src="corumapp://app/assets/edition-community.png" alt="" aria-hidden="true" />}
                {editionLabel}
              </span>
            </span>
          </div>
          {/* 版本号一行：左版本、右复制按钮。复制按钮**放这一行而非标题行**——
              侧栏锁 220 时标题行要先保住产品名，多一个 16px 按钮正好把
              「Corum Harness」挤到截断（实测需 113px、可用 109px）。 */}
          <div className={css.brandSubRow}>
            <span className={css.brandVersion}>{versionLabel}</span>
            <button
              type="button"
              className={css.copyDiag}
              title="复制诊断信息"
              aria-label="复制诊断信息"
              onClick={copyDiagnostics}
            >
              <Copy size={12} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>
      <div className={css.brandDivider} />

      {/* 内容区：两个子槽常驻挂载、仅按模式切可见性——切模式不丢组件态
          （项目详情的 activeProject 等），对齐旧单体侧栏的状态存活语义。
          sessions 槽必填（开源版也有）；project 槽付费版才有 occupant。
          sidebarBody 提供反转动画的透视与覆盖定位上下文（DESIGN §7.10）。 */}
      <div className={css.sidebarBody}>
        <div
          className={css.pane}
          data-active={restMode === 'task'}
          data-flipping={flipStateOf('task')}
        >
          {renderSlot('corum.sidebar.sessions', {})}
        </div>
        {projectAvailable && (
          <div
            className={css.pane}
            data-active={restMode === 'project'}
            data-flipping={flipStateOf('project')}
          >
            {renderSlot('corum.sidebar.project', {})}
          </div>
        )}
      </div>
    </div>
  )
}
