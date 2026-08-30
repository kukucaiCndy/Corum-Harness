/**
 * EmptyStateHero —— 会话区空态（2026-08-30 圆桌收敛：session 管理一个空态即可）。
 *
 * 布局（圆桌定调）：大 logo + 「新建项目 / 新建任务」双卡（各自副标题说明
 * 模式区别：项目=多 Agent 团队协作、任务=单任务泳道快速开始）+ 「最近」
 * 列表（项目+任务混排按时间倒序，可点直接进入）。每次启动显示空态，用户
 * 再打开想要的项目/任务。
 *
 * 数据流：动作经 ConversationInjected.emptyActions（apply.ts 注入，RPC/目录
 * 选择器/sessions.open 通路）。最近项目经 emptyActions.listProjects（corumProject
 * RPC），最近任务泳道经 recentTasks prop（AppFrame/ConversationRoot 投影
 * sessions.list corum-task-*）。大 logo 深/浅主题各一张（big_brand_dark/light，
 * 拷入 desktop assets，corumapp:// 协议可达）。
 */
import { useEffect, useState } from 'react'
import { Plus, Clock, FolderGit2, MessageSquare } from 'lucide-react'
import type { ConversationInjected } from '../contract/slots.ts'
import css from './EmptyStateHero.module.css'

/** 一张新建卡（ic 36×36 + 标题 18/600 + 模式副标题 14 secondary）。 */
function NewCard({ icon, title, desc, primary, onClick }: {
  icon: React.ReactNode
  title: string
  desc: string
  primary?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={`${css.card}${primary ? ` ${css.cardPrimary}` : ''}`} onClick={onClick}>
      <span className={`${css.ic}${primary ? ` ${css.icPrimary}` : ''}`}>{icon}</span>
      <span className={css.t}>{title}</span>
      <span className={css.d}>{desc}</span>
    </button>
  )
}

/** 相对时间（中文，与侧栏会话行同源语义）。 */
function relTime(ts: number): string {
  if (ts <= 0) return ''
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} 天`
  const date = new Date(ts)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** 最近一条（项目/任务混排）。 */
interface RecentItem {
  kind: 'project' | 'task'
  id: string
  title: string
  updatedAt: number
}

/**
 * 会话区空态。props：emptyActions（apply 注入的 RPC 通路）+ recentTasks
 * （最近任务泳道投影）+ dark（主题选大 logo 图）。
 */
export function EmptyStateHero({ emptyActions, recentTasks, dark }: {
  emptyActions: ConversationInjected['emptyActions']
  recentTasks: readonly { id: string; title: string; updatedAt: number }[]
  dark: boolean
}) {
  const [projects, setProjects] = useState<readonly { id: string; name: string; updatedAt?: number }[]>([])
  useEffect(() => {
    let alive = true
    emptyActions.listProjects()
      .then((list) => { if (alive) setProjects(list) })
      .catch(() => { /* 项目列表拉取失败不阻塞空态（最近项目留空） */ })
    return () => { alive = false }
  }, [emptyActions])

  // 最近：项目、任务分组各取前五个（2026-08-30 用户定调——不再混排取前 6）。
  const recentProjects: RecentItem[] = projects
    .map((p) => ({ kind: 'project' as const, id: p.id, title: p.name, updatedAt: p.updatedAt ?? 0 }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
  const recentTaskItems: RecentItem[] = recentTasks
    .map((t) => ({ kind: 'task' as const, id: t.id, title: t.title, updatedAt: t.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)

  const openRecent = (r: RecentItem): void => {
    const p = r.kind === 'project' ? emptyActions.openProject(r.id) : emptyActions.openTask(r.id)
    void p.catch((e) => console.error('[empty-hero] openRecent failed', e))
  }

  return (
    <div className={css.emptyHero}>
      <div className={css.bigLogo}>
        <img
          src={dark ? 'corumapp://app/assets/big_brand_dark.png' : 'corumapp://app/assets/big_brand_light.png'}
          alt="矩道 Corum"
          draggable={false}
        />
      </div>

      {/* 新建双卡：副标题说明两种模式的区别（圆桌定调③）。 */}
      <div className={css.actions}>
        <NewCard
          icon={<Plus size={24} />}
          title="新建项目"
          desc="多 Agent 团队协作 · 项目制工作区"
          primary
          onClick={() => { emptyActions.newProject().catch((e) => console.error('[empty-hero] newProject failed', e)) }}
        />
        <NewCard
          icon={<Plus size={24} />}
          title="新建任务"
          desc="单任务泳道 · 快速开始"
          onClick={() => { emptyActions.newTask().catch((e) => console.error('[empty-hero] newTask failed', e)) }}
        />
      </div>

      {/* 最近：项目、任务分组各前五个（不再混排）。 */}
      {(recentProjects.length > 0 || recentTaskItems.length > 0) && (
        <div className={css.recents}>
          {recentProjects.length > 0 && (
            <div className={css.recentGroup}>
              <div className={css.recentsHead}>
                <Clock size={15} />
                <span>最近项目</span>
              </div>
              <div className={css.recentsList}>
                {recentProjects.map((r) => (
                  <button key={`project-${r.id}`} type="button" className={css.recentRow} onClick={() => openRecent(r)}>
                    <span className={css.recentIcon} data-kind="project"><FolderGit2 size={16} /></span>
                    <span className={css.recentTitle}>{r.title}</span>
                    <span className={css.recentTime}>{relTime(r.updatedAt)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {recentTaskItems.length > 0 && (
            <div className={css.recentGroup}>
              <div className={css.recentsHead}>
                <Clock size={15} />
                <span>最近任务</span>
              </div>
              <div className={css.recentsList}>
                {recentTaskItems.map((r) => (
                  <button key={`task-${r.id}`} type="button" className={css.recentRow} onClick={() => openRecent(r)}>
                    <span className={css.recentIcon} data-kind="task"><MessageSquare size={16} /></span>
                    <span className={css.recentTitle}>{r.title}</span>
                    <span className={css.recentTime}>{relTime(r.updatedAt)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
