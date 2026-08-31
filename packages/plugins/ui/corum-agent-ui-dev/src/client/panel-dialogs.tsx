/**
 * panel-dialogs —— AgentTestPanel 的子组件（从 AgentTestPanel.tsx 拆出，包内文件拆分）。
 *
 * 三个自包含子组件：
 *   - NewProjectDialog：新建项目对话框（项目名 + 工作目录选择，目录选择走
 *     desktop bridge 的原生对话框）；
 *   - GroupManageDialog：项目组管理对话框（拉团队/拉 Agent/移出成员，
 *     PM 保底——不可移除最后一名 PM）；
 *   - ChatMessageView：聊天消息渲染（user/assistant 气泡 + system prompt
 *     /工具装配/事件流的可折叠展开）。
 * 全部经 props 接收回调与数据，不碰 cordis / RPC——主面板是唯一编排者。
 * @module @corum/corum-agent-ui-dev/panel-dialogs
 */

import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { FolderOpen, Trash2 } from 'lucide-react'
import type { ProfileSummary } from '@corum/corum-agent-dev/contract'
import type { ChatMessage, GroupMember, TeamSummary } from './panel-types.ts'
import css from './AgentTestPanel.module.css'

// ── 新建项目对话框 ───────────────────────────────────────────────────

export function NewProjectDialog({ busy, onCancel, onSubmit }: {
  busy: boolean
  onCancel: () => void
  onSubmit: (name: string, cwd: string) => Promise<void>
}): ReactNode {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  /** 经原生目录选择对话框选工作目录（只选已存在目录，新建交给系统对话框）。 */
  const pickCwd = useCallback(async () => {
    const bridge = (window as unknown as {
      corumDesktop?: { pickDirectory?: (o?: { title?: string; defaultPath?: string }) => Promise<{ path: string | null; cancelled?: boolean; error?: string }> }
    }).corumDesktop
    if (bridge?.pickDirectory === undefined) {
      setError('目录选择不可用（desktop bridge 缺失）')
      return
    }
    const existing = cwd.trim()
    const picked = await bridge.pickDirectory({
      title: '选择项目工作目录',
      ...(existing !== '' ? { defaultPath: existing } : {}),
    })
    if (picked.cancelled === true || picked.path === null) return
    setCwd(picked.path)
    setError(null)
  }, [cwd])

  const submit = useCallback(async () => {
    const trimmed = name.trim()
    if (trimmed === '') {
      setError('项目名不能为空')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(trimmed, cwd.trim())
      // 成功由父组件关闭对话框
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
    }
  }, [name, cwd, onSubmit])

  const disabled = busy || submitting

  return (
    <div className={css.dialogOverlay} onClick={() => { if (!disabled) onCancel() }}>
      <div className={css.dialog} role="dialog" aria-label="新建项目" onClick={e => { e.stopPropagation() }}>
        <div className={css.dialogTitle}>新建项目</div>

        <label className={css.dialogLabel}>项目名</label>
        <input
          className={css.dialogInput}
          placeholder="如：我的第一个项目"
          value={name}
          autoFocus
          onChange={e => { setName(e.target.value); setError(null) }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }}
        />

        <label className={css.dialogLabel}>工作目录（代码存放位置）</label>
        <div className={css.dialogCwdRow}>
          <button type="button" className={css.dialogCwdBtn} disabled={disabled} onClick={() => { void pickCwd() }}>
            <FolderOpen size={13} /> 选择目录
          </button>
          <span className={css.dialogCwdEcho} title={cwd !== '' ? cwd : '未选择（将退回进程目录）'}>
            {cwd !== '' ? cwd : '未选择工作目录'}
          </span>
        </div>
        <div className={css.dialogHint}>
          工作目录是你的代码存放位置（Agent 在此工作）；corum 的项目配置存放在其内部目录，与此分离。
        </div>

        {error !== null && <div className={css.dialogError}>{error}</div>}

        <div className={css.dialogActions}>
          <button type="button" className={css.dialogBtnSecondary} disabled={disabled} onClick={onCancel}>
            取消
          </button>
          <button type="button" className={css.dialogBtnPrimary} disabled={disabled} onClick={() => { void submit() }}>
            {submitting ? '创建中…' : '创建项目'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 项目组管理对话框 ─────────────────────────────────────────────────

/**
 * 项目组管理面板。项目组是项目的运行时组织（虚拟组织），成员为引用式（指向全局
 * AgentProfile，只有一份配置）。成员来源三类：整个团队 / 团队指定 Agent / 独立 Agent。
 * PM 是唯一统筹入口（空项目组默认有预置 PM，且不可移除最后一名 PM）。
 */
export function GroupManageDialog({ members, profiles, teams, busy, onClose, onAddTeam, onAddMember, onRemoveMember }: {
  members: readonly GroupMember[]
  profiles: readonly ProfileSummary[]
  teams: readonly TeamSummary[]
  busy: boolean
  onClose: () => void
  onAddTeam: (teamId: string) => Promise<void>
  onAddMember: (profileId: string, fromTeam?: string) => Promise<void>
  onRemoveMember: (profileId: string) => Promise<void>
}): ReactNode {
  const memberIds = new Set(members.map(m => m.profileId))
  /** 尚未进组的全局 Agent（「拉 Agent」下拉来源）。 */
  const availableProfiles = profiles.filter(p => !memberIds.has(p.id))
  /** 尚未被整体拉入的团队（「拉团队」下拉来源）。 */
  const availableTeams = teams.filter(t => t.memberProfileIds.some(id => !memberIds.has(id)))
  const pmCount = members.filter(m => m.role === 'pm').length

  return (
    <div className={css.dialogOverlay} onClick={() => { if (!busy) onClose() }}>
      <div className={css.dialog} role="dialog" aria-label="项目组管理" onClick={e => { e.stopPropagation() }}>
        <div className={css.dialogTitle}>项目组管理</div>

        {/* 拉人入口：整个团队 / 单个 Agent */}
        <div className={css.groupAddRow}>
          <select
            className={css.formSelect}
            value=""
            disabled={busy || availableTeams.length === 0}
            onChange={e => { const id = e.target.value; if (id !== '') { e.target.value = ''; void onAddTeam(id) } }}
          >
            <option value="">{availableTeams.length === 0 ? '无可拉团队' : '＋ 拉整个团队…'}</option>
            {availableTeams.map(t => (
              <option key={t.id} value={t.id}>{t.name}（{t.memberProfileIds.length} 人）</option>
            ))}
          </select>
          <select
            className={css.formSelect}
            value=""
            disabled={busy || availableProfiles.length === 0}
            onChange={e => { const id = e.target.value; if (id !== '') { e.target.value = ''; void onAddMember(id) } }}
          >
            <option value="">{availableProfiles.length === 0 ? '无可拉 Agent' : '＋ 拉 Agent…'}</option>
            {availableProfiles.map(p => (
              <option key={p.id} value={p.id}>{p.nickname ?? p.id}{p.nickname !== undefined ? `（${p.id}）` : ''}</option>
            ))}
          </select>
        </div>

        {/* 当前成员列表 */}
        <div className={css.groupMemberList}>
          {members.length === 0 && <div className={css.emptyText}>项目组暂无成员</div>}
          {members.map(m => {
            const p = profiles.find(x => x.id === m.profileId)
            const isLastPm = m.role === 'pm' && pmCount <= 1
            return (
              <div key={m.profileId} className={css.groupMemberRow}>
                <div className={css.groupMemberInfo}>
                  <span className={css.profileId}>{p?.nickname ?? m.profileId}</span>
                  {m.role === 'pm' && <span className={css.pmBadge}>PM</span>}
                  <span className={css.profileIdSub}>
                    {m.profileId}{m.fromTeam !== undefined ? ` · 来自 ${m.fromTeam}` : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className={css.iconBtn}
                  title={isLastPm ? '项目组必须保留至少一名 PM' : '移出项目组'}
                  disabled={busy || isLastPm}
                  onClick={() => { void onRemoveMember(m.profileId) }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )
          })}
        </div>

        <div className={css.dialogActions}>
          <button type="button" className={css.dialogBtnPrimary} onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  )
}

// ── 聊天消息渲染 ────────────────────────────────────────────────────

export function ChatMessageView({ message }: { message: ChatMessage }): ReactNode {
  const [showEvents, setShowEvents] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  if (message.role === 'user') {
    return (
      <div className={css.msgUser}>
        <div className={css.msgBubbleUser}>{message.text}</div>
      </div>
    )
  }
  return (
    <div className={css.msgAssistant}>
      {message.systemPrompt !== undefined && (
        <div className={css.msgPromptSection}>
          <button type="button" className={css.msgEventsToggle} onClick={() => { setShowPrompt(s => !s) }}>
            {showPrompt ? '隐藏' : '显示'}装配的 System Prompt（{message.systemPrompt.length} 字符）
          </button>
          {showPrompt && (
            <pre className={css.msgSystemPrompt}>{message.systemPrompt}</pre>
          )}
          {message.tools !== undefined && message.tools.length > 0 && (
            <div className={css.msgTools}>
              <span className={css.msgToolsLabel}>已装配工具（{message.tools.length}）:</span>
              {message.tools.map((t, i) => (
                <span key={i} className={css.msgToolChip}>{t.name}</span>
              ))}
            </div>
          )}
        </div>
      )}
      <div className={css.msgBubbleAssistant}>
        {message.text === '' ? (
          <span className={css.msgEmptyReply}>(空回复)</span>
        ) : (
          <pre className={css.msgText}>{message.text}</pre>
        )}
      </div>
      {message.events !== undefined && message.events.length > 0 && (
        <button type="button" className={css.msgEventsToggle} onClick={() => { setShowEvents(s => !s) }}>
          {showEvents ? '隐藏' : '显示'}事件流（{message.events.length}）
        </button>
      )}
      {showEvents && message.events !== undefined && (
        <div className={css.msgEvents}>
          {message.events.map((ev, i) => {
            const data = ev.data as Record<string, unknown> | null
            const isReasoning = ev.type === 'assistant/message' && Array.isArray(data?.content)
            const reasoningText = isReasoning
              ? (data!.content as Array<{ type: string; text?: string }>)
                  .filter(b => b.type === 'reasoning' && b.text)
                  .map(b => b.text)
                  .join('\n')
              : ''
            const textContent = isReasoning
              ? (data!.content as Array<{ type: string; text?: string }>)
                  .filter(b => b.type === 'text' && b.text)
                  .map(b => b.text)
                  .join('')
              : ''
            return (
              <div key={i} className={css.eventRow}>
                <span className={css.eventType}>{ev.type}</span>
                {reasoningText !== '' && (
                  <span className={css.eventReasoning}>{reasoningText}</span>
                )}
                {textContent !== '' && (
                  <span className={css.eventData}>{textContent}</span>
                )}
                {reasoningText === '' && textContent === '' && (
                  <span className={css.eventData}>{JSON.stringify(data)}</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
