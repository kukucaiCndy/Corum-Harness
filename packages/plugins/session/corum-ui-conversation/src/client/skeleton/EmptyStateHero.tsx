/**
 * EmptyStateHero —— 会话区空态（2026-08-30 设计稿 DjFev「L1 空态 · 深色」）。
 *
 * 替换 fork 官方 HeroShell（品牌标语 + 工作区选择）——设计稿空态 = 中央大
 * logo + 操作卡 + 底部提示。操作卡按侧栏模式区分（共享源 corum-ui-base
 * sidebar-mode）：
 *   - 任务模式：新建任务（起 task 泳道）/ 打开目录（目录选择器→工作区+泳道）；
 *   - 项目模式：新建工程 / 打开工程（目录选择器→openProjectByPath 分流，侧栏
 *     ProjectPane 接管）。
 * 数据流：动作经 ConversationInjected.emptyActions（apply.ts 注入，RPC/目录
 * 选择器/sessions.open 通路）。大 logo 深/浅主题各一张（big_brand_dark/light，
 * 拷入 desktop assets，corumapp:// 协议可达）。
 */
import { useSyncExternalStore } from 'react'
import { Plus, FolderOpen, Save } from 'lucide-react'
import { subscribeSidebarMode, getSidebarModeSnapshot } from '@corum/corum-ui-base/client'
import type { ConversationInjected } from '../contract/slots.ts'
import css from './EmptyStateHero.module.css'

/** 一张操作卡（设计稿 card-*：ic 36×36 + 标题 18/600 + 描述 15 secondary）。 */
function ActionCard({ icon, title, desc, primary, onClick }: {
  icon: React.ReactNode
  title: string
  desc: string
  primary?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`${css.card}${primary ? ` ${css.cardPrimary}` : ''}`}
      onClick={onClick}
    >
      <span className={`${css.ic}${primary ? ` ${css.icPrimary}` : ''}`}>{icon}</span>
      <span className={css.t}>{title}</span>
      <span className={css.d}>{desc}</span>
    </button>
  )
}

/**
 * 会话区空态。props：emptyActions（apply 注入的 RPC 通路）+ 当前主题（dark/light
 * 选大 logo 图）。模式经共享源订阅（SidebarSkeleton 广播）。
 */
export function EmptyStateHero({ emptyActions, dark }: {
  emptyActions: ConversationInjected['emptyActions']
  dark: boolean
}) {
  const mode = useSyncExternalStore(subscribeSidebarMode, getSidebarModeSnapshot)
  const cards = mode === 'project'
    ? [
      { key: 'new', icon: <Plus size={24} />, title: '新建工程', desc: '创建新的 Agent 工作区', primary: true, onClick: () => { emptyActions.openProjectPath().catch((e) => console.error('[empty-hero] openProjectPath failed', e)) } },
      { key: 'open', icon: <FolderOpen size={24} />, title: '打开工程', desc: '选择本地目录开始', primary: false, onClick: () => { emptyActions.openProjectPath().catch((e) => console.error('[empty-hero] openProjectPath failed', e)) } },
    ]
    : [
      { key: 'new', icon: <Plus size={24} />, title: '新建任务', desc: '创建新的 Agent 工作区', primary: true, onClick: () => { emptyActions.startTaskSession().catch((e) => console.error('[empty-hero] startTaskSession failed', e)) } },
      { key: 'open', icon: <FolderOpen size={24} />, title: '打开目录', desc: '选择本地目录开始', primary: false, onClick: () => { emptyActions.openDirectoryAsWorkspace().catch((e) => console.error('[empty-hero] openDirectoryAsWorkspace failed', e)) } },
    ]
  return (
    <div className={css.emptyHero}>
      <div className={css.bigLogo}>
        <img
          src={dark ? 'corumapp://app/assets/big_brand_dark.png' : 'corumapp://app/assets/big_brand_light.png'}
          alt="矩道 Corum"
          draggable={false}
        />
      </div>
      <div className={css.actions}>
        {cards.map((c) => (
          <ActionCard key={c.key} icon={c.icon} title={c.title} desc={c.desc} primary={c.primary} onClick={c.onClick} />
        ))}
      </div>
      <div className={css.hint}>最近工程：kkc-desktop · agent-sandbox</div>
    </div>
  )
}
