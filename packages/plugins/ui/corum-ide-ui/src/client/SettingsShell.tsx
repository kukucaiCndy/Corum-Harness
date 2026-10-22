/**
 * SettingsShell —— ide-shell 自建的设置壳（sidebar.settings occupant）。
 *
 * 1:1 复刻 design.pen 设置中心 (KybzJ > MEGzM 等 44 页)：
 * - SettingsShell: 1040×820, glass-1 面板, cornerRadius 24, background_blur 16,
 *   shadow #00000040 offset(0,16) blur 48
 * - nav: 200px, 搜索框 + 分组标题 + 导航项 (height 28, gap 2, padding [12,10,8,10])
 * - content: header (h56, title + scope-switch + close) + body (group 卡片)
 * - group: glass-1 fill, cornerRadius 16, glass-border stroke, padding [6,16,10,16]
 * - row: space_between, gap 12, padding [10,2], meta(label+desc) ↔ control(select/switch)
 *
 * 面板经 createPortal 挂到 document.body——网格 .leaf 的 will-change:transform +
 * overflow:hidden 会困住 position:fixed 面板（React 18 事件委托挂在 root 容器，
 * portal 子树仍在 React 树内，onClick 全部生效）。
 *
 * 壳是纯组合面：nav 分组/项文案、面板标题、关闭按钮可及名、sections 全部经
 * slots 到达；打开状态与 active section id 是组件本地 viewing state；
 * onboarding 协调器在空 Hero 事实激活期间挂载恰好一个有序 registrant。
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  Archive, Bell, Bot, Box, Brain, ChevronDown, Code, Command, Cpu, Layers,
  Lock, Plug, Search, Settings as SettingsIcon, Shield, Sparkles,
  Star, Sun, Terminal, Trash2, User, Webhook, Repeat, Wrench, X,
} from 'lucide-react'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
// Type-only: pulls `useSessions` into GlobalStandardProps (0.1.2 起由 ui-session 声明)。
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { SectionNavContext } from './settings/shared.tsx'
import type { SettingsKey } from './settings-locales.ts'
import { NAV_GROUP_BY_ID, type SettingsNavGroup } from './settings/SettingsSections.tsx'
import { OPEN_SETTINGS_SECTION_EVENT } from './service.ts'
import css from './SettingsShell.module.css'

/* ── 导航分组定义（设计稿 nav: secA/B/C/D/E/F）───────────────────────── */

interface NavItemDef {
  id: string
  icon: ReactNode
}

interface NavGroupDef {
  title: string
  items: NavItemDef[]
}

/** 导航项图标（lucide-react 14×14，与设计稿 icon 节点一一对应）。 */
function navIcon(id: string): ReactNode {
  const cls = css.navIcon
  const map: Record<string, ReactNode> = {
    general: <SettingsIcon className={cls} size={14} />,
    appearance: <Sun className={cls} size={14} />,
    editor: <Code className={cls} size={14} />,
    notifications: <Bell className={cls} size={14} />,
    shortcuts: <Command className={cls} size={14} />,
    models: <Cpu className={cls} size={14} />,
    'agent-presets': <Layers className={cls} size={14} />,
    permissions: <Lock className={cls} size={14} />,
    // ➖ rules 图标已随该分区移除（用户裁定：以 Agent 为单位管控，见
    //    SettingsSections.tsx 的 SECTION_DEFS 注释）。
    // 记忆组两项（2026-09-21；2026-09-22「移除项目记忆」收敛为两项）：
    // 全局设置 = 大脑、智能体记忆 = 机器人。项目记忆 icon 已随该 section 删除。
    'memory-settings': <Brain className={cls} size={14} />,
    'memory-agent': <Bot className={cls} size={14} />,
    terminal: <Terminal className={cls} size={14} />,
    hooks: <Webhook className={cls} size={14} />,
    'agent-settings': <Repeat className={cls} size={14} />,
    account: <User className={cls} size={14} />,
    privacy: <Shield className={cls} size={14} />,
    data: <Archive className={cls} size={14} />,
    // 「会话管理」独立 section 页（issue #121 修订版）：归档会话生命周期管理，
    // 与「数据管理」同组（secC 数据与隐私）。
    'session-management': <Archive className={cls} size={14} />,
    extensions: <Box className={cls} size={14} />,
    mcp: <Plug className={cls} size={14} />,
    skills: <Star className={cls} size={14} />,
    'ai-polish': <Sparkles className={cls} size={14} />,
    advanced: <Wrench className={cls} size={14} />,
  }
  return map[id] ?? <SettingsIcon className={cls} size={14} />
}

/**
 * 导航分组：从注册的 section rows 中读每个 section 自声明的 `navGroup`（经
 * NAV_GROUP_BY_ID 数据源），缺省归 'extensions'（扩展）。6 组标题/顺序：
 * 通用 → 智能体 → 记忆 → 数据与隐私 → 扩展 → 高级，不再有「其他」桶——所有
 * section 都有归属。
 */
/**
 * 导航分组定义：`titleKey` 是 locale key（不是显示文本）——分组标题必须跟随语言，
 * 否则切到 English 后 5 个分组标题仍是中文（实测就是这样）。渲染处用 `t(titleKey)`
 * 求值（`t` 已是本 effect 的 `ctx.locale.bind(NS)` 绑定）。
 */
const NAV_GROUPS: { key: SettingsNavGroup; titleKey: SettingsKey }[] = [
  { key: 'general', titleKey: 'group.general' },
  { key: 'agent', titleKey: 'group.agent' },
  // ➕ 记忆独立成组（2026-09-21 用户裁定「将记忆单独列一个项，放在智能体下方」；
  //    2026-09-22「移除项目记忆」收敛为两项）：含「全局设置 / 智能体记忆」两个
  //    section（由 @corum/corum-memory 插件自注册，归属见 SettingsSections.NAV_GROUP_BY_ID）。
  { key: 'memory', titleKey: 'group.memory' },
  { key: 'data', titleKey: 'group.data' },
  { key: 'extensions', titleKey: 'group.extensions' },
  { key: 'advanced', titleKey: 'group.advanced' },
]

/** 读某 section 的归属分组（自声明；缺省归扩展）。 */
function navGroupOf(id: string): SettingsNavGroup {
  return NAV_GROUP_BY_ID[id] ?? 'extensions'
}

/* ── 面板 ────────────────────────────────────────────────────────── */

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
  /** 「发现更多插件」触发（inject 面下发，直通 LayoutController.openPluginManager）。 */
  onOpenPluginManager: () => void
  t: (key: string) => string
}

/**
 * The modal layer: full-viewport mask + centered panel.
 * Close paths: header button, mask click, Escape (mounted only while open).
 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose, onOpenPluginManager, t }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()
  const closeButton = useRef<HTMLButtonElement | null>(null)

  // 搜索状态
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // Baseline focus management: entering the dialog lands on the close button.
  useEffect(() => { closeButton.current?.focus() }, [])

  // 按 nav 分组投影 rows；搜索过滤。
  const lowerQuery = searchQuery.trim().toLowerCase()
  const filteredRows = lowerQuery === ''
    ? rows
    : rows.filter(r => r.label.toLowerCase().includes(lowerQuery) || r.id.includes(lowerQuery))

  // 为每个分组计算可见项：读每个 section 自声明的 navGroup（缺省归扩展），
  // 保持 5 组标题/顺序现状；无「其他」桶。
  const visibleGroups = NAV_GROUPS.map(group => ({
    title: t(group.titleKey),
    items: filteredRows.filter(r => navGroupOf(r.id) === group.key),
  })).filter(g => g.items.length > 0)

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {/* ── Nav (200px) ───────────────────────────────────────────── */}
        <nav className={css.nav}>
          <div className={css.navSearch}>
            <Search className={css.navSearchIcon} size={13} />
            <input
              className={css.navSearchInput}
              type="text"
              placeholder={t('search')}
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value) }}
            />
          </div>
          <div className={css.navSpacer} />
          {visibleGroups.map((group, gi) => (
            <div key={group.title} className={css.navGroup}>
              {gi > 0 && <div className={css.navSpacer} />}
              <div className={css.navSecTitle}>{group.title}</div>
              {group.items.map(row => (
                <button
                  key={row.id}
                  type="button"
                  className={clsx(css.navCell, row.id === active && css.navCellActive)}
                  aria-current={row.id === active ? 'true' : undefined}
                  onClick={() => { onSelect(row.id) }}
                >
                  {navIcon(row.id)}
                  <span className={css.navLabel}>{row.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* ── Content ────────────────────────────────────────────────── */}
        <div className={css.content}>
          <div className={css.header}>
            <span className={css.headerTitle} id={titleId}>
              {active !== undefined
                ? (rows.find(r => r.id === active)?.label ?? t('title'))
                : t('title')}
            </span>
            <div className={css.headerRight}>
              {/* close */}
              <button
                ref={closeButton}
                type="button"
                className={css.closeBtn}
                onClick={onClose}
                aria-label={t('close')}
              >
                <X size={20} />
              </button>
            </div>
          </div>
          <div className={css.headerDivider} />
          <div className={css.body}>
            {/* section 操作面（openSection 切换 + close 关面板）经 context 下发，
                不走 slot owner props（slot 契约不含这些）。 */}
            <SectionNavContext.Provider value={{ openSection: onSelect, close: onClose, openPluginManager: onOpenPluginManager }}>
              {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
            </SectionNavContext.Provider>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── 壳 ────────────────────────────────────────────────────────── */

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsShell(props: SettingsRootComponentProps) {
  const { wide, useSections, useOnboardingSteps, useSessions, renderSlot, openPluginManager } = props
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])
  const openSection = useCallback((id: string) => {
    setActiveId(id)
    setOpen(true)
  }, [])

  // 监听壳「打开设置某 section」事件（如插件中心入口 → 扩展面板）。
  // OPEN_SETTINGS_SECTION_EVENT 是一次性触发信号（detail=section id），合法 window 用法。
  useEffect(() => {
    const handler = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail
      if (typeof id === 'string' && id !== '') openSection(id)
    }
    window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, handler)
    return () => { window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, handler) }
  }, [openSection])

  const rows = useSections(s => s)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find((step: { id: string }) => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  // t：settings 命名空间绑定（InjectFace 注入面）
  const t = props.t

  return (
    <>
      <button
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(true) }}
      >
        {renderSlot('settings.trigger', { wide })}
      </button>
      {/* 面板经 createPortal 到 document.body */}
      {open && createPortal(
        <SettingsPanel
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
          onOpenPluginManager={openPluginManager}
          t={t}
        />,
        document.body,
      )}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}
