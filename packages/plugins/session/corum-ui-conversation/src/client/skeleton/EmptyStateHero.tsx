/**
 * EmptyStateHero —— 会话区空态（2026-08-30 重设计定稿，设计稿 DjFev 重排版式）。
 *
 * 版式（更品牌 · 保留大 logo）：大 logo + 「新建项目 / 新建任务」两个**横排
 * 大按钮**（ic 44×44 左 + 标题/副标题右，宽 360、高 97）+ 「最近」合一列
 * （项目+任务混排按时间倒序，icon + 标题 + kind + 时间，宽 420）。每次启动
 * 显示空态，用户再打开想要的项目/任务。
 *
 * 数据流：动作经 ConversationInjected.emptyActions（apply.ts 注入，RPC/目录
 * 选择器/sessions.open 通路）。最近项目经 emptyActions.listProjects（corumProject
 * RPC），最近任务泳道经 recentTasks prop（AppFrame/ConversationRoot 投影
 * sessions.list corum-task-*）。大 logo 深/浅主题各一张（big_brand_dark/light，
 * 拷入 desktop assets，corumapp:// 协议可达）。
 */
import { useEffect, useState } from 'react'
import { Plus, Clock, FolderGit2, Folder } from 'lucide-react'
import type { ConversationInjected } from '../contract/slots.ts'
import css from './EmptyStateHero.module.css'

/** 一个横排大按钮（设计稿 card-*：360×97、ic 44×44 r12 左 + 标题 20/600 +
 *  副标题 15 secondary 右，横排 ic 左 tx 右）。 */
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
      <span className={css.tx}>
        <span className={css.t}>{title}</span>
        <span className={css.d}>{desc}</span>
      </span>
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

  // 最近合一列：项目 + 任务泳道混排，按 updatedAt 倒序取前 6。
  const recents: RecentItem[] = [
    ...projects.map((p) => ({ kind: 'project' as const, id: p.id, title: p.name, updatedAt: p.updatedAt ?? 0 })),
    ...recentTasks.map((t) => ({ kind: 'task' as const, id: t.id, title: t.title, updatedAt: t.updatedAt })),
  ]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6)

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

      {/* 新建双按钮（设计稿：两个横排大按钮，ic 左 + 标题/副标题右）。 */}
      <div className={css.actions}>
        <NewCard
          icon={<Plus size={18} />}
          title="新建项目"
          desc="多 Agent 团队协作 · 项目制工作区"
          primary
          onClick={() => { emptyActions.newProject().catch((e) => console.error('[empty-hero] newProject failed', e)) }}
        />
        <NewCard
          icon={<Plus size={18} />}
          title="新建任务"
          desc="单任务泳道 · 快速开始"
          onClick={() => { emptyActions.newTask().catch((e) => console.error('[empty-hero] newTask failed', e)) }}
        />
      </div>

      {/* 最近合一列（项目+任务混排按时间倒序）：icon + 标题 + kind + 时间。 */}
      {recents.length > 0 && (
        <div className={css.recents}>
          <div className={css.recentsHead}>
            <Clock size={15} />
            <span>最近</span>
          </div>
          <div className={css.recentsList}>
            {recents.map((r) => (
              <button key={`${r.kind}-${r.id}`} type="button" className={css.recentRow} onClick={() => openRecent(r)}>
                <span className={css.recentIcon} data-kind={r.kind}>
                  {r.kind === 'project' ? <FolderGit2 size={18} /> : <Folder size={18} />}
                </span>
                <span className={css.recentTitle}>{r.title}</span>
                <span className={css.recentKind}>{r.kind === 'project' ? '项目' : '任务'}</span>
                <span className={css.recentTime}>{relTime(r.updatedAt)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
