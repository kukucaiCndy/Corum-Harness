/**
 * TeamManagerPanel —— corum 全局团队管理面板。
 *
 * 团队是「预设 Agent 集合」（部门/模板）：用户创建团队、把全局 AgentProfile
 * 组进去。与项目无关——项目组（项目的运行时成员）在项目语境里单独管理，
 * 可把这里的整个团队 / 指定 Agent 拉进项目组。
 *
 * 布局：左侧团队列表（新建/删除团队）+ 右侧选中团队的成员管理（从全局
 * profile 加成员 / 移除成员）。经官方 connection.rpc（0.1.2 起）调
 * /api/corumTeam/* 与 /api/corumAgent/listProfiles；caller 由宿主插件 apply
 * 注入（旧 corumDesktop.unary IPC 桥已退役）。
 * @module @corum/corum-team-ui-dev/client/TeamManagerPanel
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { type CorumRpcCall } from '@corum/corum-rpc-client/client'
import { Plus, RefreshCw, Trash2, UserPlus, Users, X } from 'lucide-react'
import css from './TeamManagerPanel.module.css'

// ── RPC 类型（镜像 corum-agent-dev 的 team/profile） ─────────────

interface CorumTeam {
  id: string
  name: string
  description?: string
  memberProfileIds: string[]
  createdAt: number
  version: number
}

interface ProfileSummary {
  id: string
  nickname?: string
  title?: string
}

/** 面板对外依赖：corumTeam / corumAgent 两个命名空间的 RPC caller。 */
export interface TeamManagerPanelProps {
  readonly callRemote: CorumRpcCall
}

/** 全局团队管理面板。 */
export function TeamManagerPanel({ callRemote }: TeamManagerPanelProps): ReactNode {
  const [teams, setTeams] = useState<readonly CorumTeam[]>([])
  const [profiles, setProfiles] = useState<readonly ProfileSummary[]>([])
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null)
  const [newTeamName, setNewTeamName] = useState('')
  const [newTeamDesc, setNewTeamDesc] = useState('')
  const [addProfileId, setAddProfileId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const { teams: t } = await callRemote<{ teams: CorumTeam[] }>('corumTeam', 'listTeams', {})
      setTeams(t)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    try {
      const { profiles: p } = await callRemote<{ profiles: ProfileSummary[] }>('corumAgent', 'listProfiles', {})
      setProfiles(p)
    } catch { /* corumAgent 服务可能尚未就绪 */ }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const selectedTeam = teams.find(t => t.id === selectedTeamId) ?? null

  /** 新建团队。 */
  const onCreateTeam = useCallback(async () => {
    const name = newTeamName.trim()
    if (name === '') {
      setError('团队名不能为空')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { team } = await callRemote<{ team: CorumTeam }>('corumTeam', 'createTeam', {
        name,
        ...(newTeamDesc.trim() !== '' ? { description: newTeamDesc.trim() } : {}),
      })
      setNewTeamName('')
      setNewTeamDesc('')
      setSelectedTeamId(team.id)
      setNotice(`团队 "${team.name}" 已创建`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [newTeamName, newTeamDesc, refresh])

  /** 删除选中的团队。 */
  const onDeleteTeam = useCallback(async (teamId: string) => {
    setBusy(true)
    setError(null)
    try {
      await callRemote('corumTeam', 'deleteTeam', { teamId })
      if (selectedTeamId === teamId) setSelectedTeamId(null)
      setNotice('团队已删除')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [selectedTeamId, refresh])

  /** 给选中团队添加一个成员（Agent profile）。 */
  const onAddMember = useCallback(async () => {
    if (selectedTeamId === null || addProfileId === '') return
    setBusy(true)
    setError(null)
    try {
      await callRemote('corumTeam', 'addMember', { teamId: selectedTeamId, profileId: addProfileId })
      setAddProfileId('')
      setNotice(`已把 ${addProfileId} 加入团队`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [selectedTeamId, addProfileId, refresh])

  /** 从选中团队移除一个成员。 */
  const onRemoveMember = useCallback(async (profileId: string) => {
    if (selectedTeamId === null) return
    setBusy(true)
    setError(null)
    try {
      await callRemote('corumTeam', 'removeMember', { teamId: selectedTeamId, profileId })
      setNotice(`已把 ${profileId} 移出团队`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [selectedTeamId, refresh])

  /** 选中团队里尚未加入的全局 profile（供「添加成员」下拉）。 */
  const addableProfiles = profiles.filter(p => !(selectedTeam?.memberProfileIds ?? []).includes(p.id))

  return (
    <div className={css.root}>
      {/* 左侧：团队列表 + 新建团队 */}
      <aside className={css.sidebar}>
        <div className={css.sideHead}>
          <span className={css.sideTitle}><Users size={14} /> 团队</span>
          <button type="button" className={css.iconBtn} title="刷新" onClick={() => { void refresh() }}>
            <RefreshCw size={13} />
          </button>
        </div>

        <div className={css.teamList}>
          {teams.length === 0 && <div className={css.empty}>暂无团队。在下方新建一个团队（部门/预设 Agent 集合）。</div>}
          {teams.map(t => (
            <div
              key={t.id}
              className={css.teamCard}
              data-selected={selectedTeamId === t.id || undefined}
              onClick={() => { setSelectedTeamId(t.id) }}
            >
              <div className={css.teamCardHead}>
                <span className={css.teamName}>{t.name}</span>
                <span className={css.teamCount}>{t.memberProfileIds.length} 成员</span>
              </div>
              {t.description !== undefined && <div className={css.teamDesc}>{t.description}</div>}
              <div className={css.teamId}>{t.id}</div>
            </div>
          ))}
        </div>

        {/* 新建团队 */}
        <div className={css.newTeam}>
          <input
            className={css.input}
            placeholder="新团队名（如：后端组）"
            value={newTeamName}
            onChange={e => { setNewTeamName(e.target.value) }}
          />
          <input
            className={css.input}
            placeholder="描述（可选）"
            value={newTeamDesc}
            onChange={e => { setNewTeamDesc(e.target.value) }}
          />
          <button type="button" className={css.primaryBtn} disabled={busy} onClick={() => { void onCreateTeam() }}>
            <Plus size={13} /> 新建团队
          </button>
        </div>
      </aside>

      {/* 右侧：选中团队的成员管理 */}
      <main className={css.main}>
        {selectedTeam === null ? (
          <div className={css.emptyMain}>从左侧选择一个团队查看/管理成员，或新建一个团队。</div>
        ) : (
          <>
            <div className={css.mainHead}>
              <div className={css.mainHeadMeta}>
                <span className={css.mainTitle}>{selectedTeam.name}</span>
                <span className={css.mainSub}>{selectedTeam.id} · {selectedTeam.memberProfileIds.length} 成员</span>
              </div>
              <button
                type="button"
                className={css.dangerBtn}
                disabled={busy}
                onClick={() => { void onDeleteTeam(selectedTeam.id) }}
                title="删除该团队（不影响团队里的 Agent 本体）"
              >
                <Trash2 size={13} /> 删除团队
              </button>
            </div>

            {/* 成员列表 */}
            <div className={css.memberSection}>
              <div className={css.sectionLabel}>团队成员（{selectedTeam.memberProfileIds.length}）</div>
              {selectedTeam.memberProfileIds.length === 0 && (
                <div className={css.empty}>暂无成员。从下方「添加成员」把全局 Agent 加进团队。</div>
              )}
              <div className={css.memberList}>
                {selectedTeam.memberProfileIds.map(pid => {
                  const profile = profiles.find(p => p.id === pid)
                  return (
                    <div key={pid} className={css.memberRow}>
                      <span className={css.memberName}>{profile?.nickname ?? pid}</span>
                      <span className={css.memberId}>{pid}</span>
                      <button
                        type="button"
                        className={css.removeBtn}
                        disabled={busy}
                        onClick={() => { void onRemoveMember(pid) }}
                        title="移出团队"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* 添加成员 */}
            <div className={css.addMember}>
              <div className={css.sectionLabel}>添加成员（从全局 Agent 选择）</div>
              <div className={css.addRow}>
                <select
                  className={css.select}
                  value={addProfileId}
                  onChange={e => { setAddProfileId(e.target.value) }}
                >
                  <option value="">选择要加入的 Agent…</option>
                  {addableProfiles.map(p => (
                    <option key={p.id} value={p.id}>{p.nickname !== undefined ? `${p.nickname}（${p.id}）` : p.id}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className={css.primaryBtn}
                  disabled={busy || addProfileId === ''}
                  onClick={() => { void onAddMember() }}
                >
                  <UserPlus size={13} /> 加入团队
                </button>
              </div>
            </div>
          </>
        )}
        {error !== null && <div className={css.error}>{error}</div>}
        {notice !== null && error === null && <div className={css.notice}>{notice}</div>}
      </main>
    </div>
  )
}

export default TeamManagerPanel
