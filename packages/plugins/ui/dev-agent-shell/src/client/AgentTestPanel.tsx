/**
 * AgentTestPanel —— dev-agent combo 的测试交互面板（v2）。
 *
 * 四个 tab：
 *   1. Profile 编辑器：创建/编辑 AgentProfile（prompt / model / skills / mcp / terminal）
 *   2. 对话：选择已保存的 Profile → 创建 Agent → 发消息 → 看回复 + 事件流
 *   3. 日志：操作日志
 *   4. Skill 管理：导入/删除/查看 skill
 *
 * 通过桌面 IPC 桥调 /api/corumAgent/* 和 /api/skillManager/* RPC 端点。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity, Bot, FlaskConical, MessageSquare, Package, Plus, RefreshCw, Save,
  Send, Settings, Trash2, Wrench,
} from 'lucide-react'
import { SkillManagerPanel } from '@corum/dev-skill-manager-shell/client'
import css from './AgentTestPanel.module.css'

// ── RPC 类型 ────────────────────────────────────────────────────────

interface ProfileSummary {
  id: string
  prompt: string
  model: { provider: string; model: string; reasoningEffort?: string }
  skills: SkillBinding[]
  mcpServers: string[]
  terminal: { mode: string }
  version: number
  trust: string
}

interface AgentStatus {
  profileId: string
  created: boolean
}

interface SkillBinding { name: string; versionId: string }

interface SkillInfo {
  name: string
  description: string
  path: string
  currentVersion?: string
  versionCount: number
  createdAt?: string
}

interface SessionEventDto {
  seq: number
  type: string
  data: unknown
  time: number
}

interface RunPromptResult {
  reply: string
  events: SessionEventDto[]
}

interface SaveProfileInput {
  id: string
  prompt: string
  model: { provider: string; model: string; reasoningEffort?: string }
  skills: SkillBinding[]
  mcpServers: Array<{
    serverName: string
    transport: 'stdio' | 'streamable-http'
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
  }>
  terminal: { mode: 'sandbox' | 'host' }
  memoryPolicy: { scope: 'agent'; dir?: string }
  trust: 'system' | 'user'
}

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

// ── RPC 桥 ──────────────────────────────────────────────────────────

async function callRemote<T>(service: string, method: string, args: Record<string, unknown>): Promise<T> {
  const bridge = (window as unknown as {
    corumDesktop?: { unary?: (pathname: string, body?: string) => Promise<{ status: number; body: string }> }
  }).corumDesktop
  if (bridge?.unary === undefined) throw new Error('desktop bridge unavailable')
  const rpcId = crypto.randomUUID()
  const message = { type: 'client-request', rpcId, method: `${service}/${method}`, payload: { args } }
  const { status, body } = await bridge.unary(`/api/${service}/${method}`, JSON.stringify(message))
  if (status !== 200) throw new Error(`${service}/${method}: HTTP ${status}`)
  const envelope = JSON.parse(body) as { type: string; rpcId: string; result: RpcResult<T> }
  if (envelope.rpcId !== rpcId) throw new Error(`${service}/${method}: rpcId mismatch`)
  if (!envelope.result.ok) throw new Error(`${envelope.result.error.code}: ${envelope.result.error.message}`)
  return envelope.result.value
}

// ── 模型目录（从 host 动态获取） ────────────────────────────────────

interface ProviderCatalog {
  id: string
  name: string
  models: Array<{ id: string; name: string; input?: string[] }>
}

// ── 日志 ────────────────────────────────────────────────────────────

interface LogEntry {
  time: string
  level: 'info' | 'error' | 'success'
  message: string
}

// ── 聊天消息 ────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  /** 关联的 session events（assistant 消息携带工具调用等过程信息）。 */
  events?: SessionEventDto[]
}

// ── Profile 编辑器状态 ─────────────────────────────────────────────

interface ProfileDraft {
  id: string
  prompt: string
  provider: string
  model: string
  reasoningEffort: string
  skills: SkillBinding[]
  terminalMode: 'sandbox' | 'host'
}

function profileToDraft(p: ProfileSummary): ProfileDraft {
  return {
    id: p.id,
    prompt: p.prompt,
    provider: p.model.provider,
    model: p.model.model,
    reasoningEffort: p.model.reasoningEffort ?? '',
    skills: p.skills.map(s => ({ name: s.name, versionId: s.versionId })),
    terminalMode: p.terminal.mode as 'sandbox' | 'host',
  }
}

function emptyDraft(): ProfileDraft {
  return {
    id: '',
    prompt: 'You are a helpful assistant.',
    provider: '',
    model: '',
    reasoningEffort: '',
    skills: [],
    terminalMode: 'sandbox',
  }
}

// ── 主组件 ──────────────────────────────────────────────────────────

type Tab = 'editor' | 'chat' | 'logs' | 'skill-manager'

export function AgentTestPanel(): ReactNode {
  const [tab, setTab] = useState<Tab>('editor')
  const [profiles, setProfiles] = useState<readonly ProfileSummary[]>([])
  const [agents, setAgents] = useState<readonly AgentStatus[]>([])
  const [availableSkills, setAvailableSkills] = useState<readonly SkillInfo[]>([])
  const [providers, setProviders] = useState<readonly ProviderCatalog[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [busy, setBusy] = useState(false)

  // Profile 编辑器状态
  const [draft, setDraft] = useState<ProfileDraft>(emptyDraft())
  const [editingExisting, setEditingExisting] = useState<string | null>(null)

  // 聊天状态
  const [chatProfile, setChatProfile] = useState<string | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatRunning, setChatRunning] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)

  const log = useCallback((level: LogEntry['level'], message: string) => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    setLogs(prev => [...prev, { time, level, message }])
  }, [])

  const refresh = useCallback(async () => {
    try {
      const { profiles: p } = await callRemote<{ profiles: ProfileSummary[] }>('corumAgent', 'listProfiles', {})
      setProfiles(p)
      log('info', `已加载 ${p.length} 个 Profile`)
    } catch (error) {
      log('error', `加载 Profile 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const { agents: a } = await callRemote<{ agents: AgentStatus[] }>('corumAgent', 'listAgents', {})
      setAgents(a)
    } catch { /* 静默 */ }
    try {
      const { skills: sk } = await callRemote<{ skills: SkillInfo[] }>('skillManager', 'listAll', {})
      setAvailableSkills(sk)
      log('info', `已发现 ${sk.length} 个可用 Skill`)
    } catch { /* skillManager 服务可能尚未就绪 */ }
    try {
      const { providers: p } = await callRemote<{ providers: ProviderCatalog[] }>('corumAgent', 'listModels', {})
      setProviders(p)
      log('info', `已加载 ${p.length} 个模型 Provider`)
    } catch { /* llm 服务可能尚未就绪 */ }
  }, [log])

  useEffect(() => { void refresh() }, [refresh])

  // ── Profile 编辑器操作 ──

  const onNewProfile = useCallback(() => {
    setDraft(emptyDraft())
    setEditingExisting(null)
  }, [])

  const onEditProfile = useCallback((p: ProfileSummary) => {
    setDraft(profileToDraft(p))
    setEditingExisting(p.id)
  }, [])

  const onSaveProfile = useCallback(async () => {
    if (draft.id.trim() === '') {
      log('error', 'Profile ID 不能为空')
      return
    }
    setBusy(true)
    log('info', `保存 Profile "${draft.id}"...`)
    try {
      const input: SaveProfileInput = {
        id: draft.id.trim(),
        prompt: draft.prompt,
        model: {
          provider: draft.provider,
          model: draft.model,
          ...(draft.reasoningEffort === '' ? {} : { reasoningEffort: draft.reasoningEffort }),
        },
        skills: draft.skills,
        mcpServers: [],
        terminal: { mode: draft.terminalMode },
        memoryPolicy: { scope: 'agent' },
        trust: 'user',
      }
      await callRemote('corumAgent', 'saveProfile', { input })
      log('success', `Profile "${draft.id}" 已保存${draft.skills.length > 0 ? `（绑定 ${draft.skills.length} 个 skill）` : ''}`)
      await refresh()
    } catch (error) {
      log('error', `保存失败 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [draft, log, refresh])

  const onDeleteProfile = useCallback(async (id: string) => {
    setBusy(true)
    log('info', `删除 Profile "${id}"...`)
    try {
      await callRemote('corumAgent', 'deleteProfile', { id })
      log('success', `Profile "${id}" 已删除`)
      if (editingExisting === id) {
        setDraft(emptyDraft())
        setEditingExisting(null)
      }
      await refresh()
    } catch (error) {
      log('error', `删除失败 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [editingExisting, log, refresh])

  // ── 聊天操作 ──

  const onChatStart = useCallback(async (profileId: string) => {
    setBusy(true)
    log('info', `创建 Agent (profile: ${profileId})...`)
    try {
      await callRemote('corumAgent', 'createAgent', { profileId })
      log('success', `Agent 已创建 (profile: ${profileId})`)
      setChatProfile(profileId)
      setChatMessages([])
      setTab('chat')
      const { agents: a } = await callRemote<{ agents: AgentStatus[] }>('corumAgent', 'listAgents', {})
      setAgents(a)
    } catch (error) {
      log('error', `创建 Agent 失败 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [log])

  const onChatSend = useCallback(async () => {
    if (chatProfile === null || chatInput.trim() === '') return
    const userText = chatInput.trim()
    setChatInput('')
    setChatRunning(true)
    setChatMessages(prev => [...prev, { role: 'user', text: userText }])
    log('info', `发送消息 (profile: ${chatProfile})...`)
    try {
      const result = await callRemote<RunPromptResult>('corumAgent', 'runPrompt', {
        profileId: chatProfile,
        prompt: userText,
      })
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        text: result.reply,
        events: result.events,
      }])
      log('success', `Agent 回复: ${result.reply.slice(0, 200)}${result.reply.length > 200 ? '...' : ''}`)
    } catch (error) {
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        text: `[错误] ${error instanceof Error ? error.message : String(error)}`,
      }])
      log('error', `运行失败 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setChatRunning(false)
    }
  }, [chatProfile, chatInput, log])

  // 自动滚动到底部
  useEffect(() => {
    if (chatScrollRef.current !== null) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
    }
  }, [chatMessages])

  const isAgentCreated = agents.some(a => a.profileId === chatProfile)

  // ── 冒烟测试 ──
  const onVerify = useCallback(async () => {
    setBusy(true)
    log('info', '开始冒烟测试...')
    try {
      const result = await callRemote<{ ok: boolean; reply?: string; error?: string }>('corumAgent', 'verify', {})
      if (result.ok) {
        log('success', `冒烟测试通过 — ${JSON.stringify(result.reply)}`)
      } else {
        log('error', `冒烟测试失败 — ${result.error}`)
      }
    } catch (error) {
      log('error', `冒烟测试异常 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [log])

  const currentProvider = providers.find(p => p.id === draft.provider)
  const reasoningEfforts = ['off', 'low', 'high', 'max']

  // ── Skills 勾选辅助函数 ──
  const isSkillChecked = useCallback((skillName: string): boolean => {
    return draft.skills.some(s => s.name === skillName)
  }, [draft.skills])

  const toggleSkill = useCallback((skill: SkillInfo) => {
    setDraft(d => {
      const existing = d.skills.find(s => s.name === skill.name)
      if (existing) {
        return { ...d, skills: d.skills.filter(s => s.name !== skill.name) }
      }
      return { ...d, skills: [...d.skills, { name: skill.name, versionId: skill.currentVersion ?? '' }] }
    })
  }, [])

  return (
    <div className={css.root}>
      {/* 标题栏 */}
      <header className={css.header}>
        <div className={css.headerLeft}>
          <Bot size={20} />
          <span className={css.title}>Corum Agent 开发验证</span>
          <span className={css.badge}>dev-agent combo</span>
        </div>
        <div className={css.headerRight}>
          <button type="button" className={css.headerBtn} disabled={busy || chatRunning} onClick={() => { void refresh() }}>
            <RefreshCw size={14} /> 刷新
          </button>
          <button type="button" className={css.headerBtn} disabled={busy || chatRunning} onClick={() => { void onVerify() }}>
            <FlaskConical size={14} /> 冒烟测试
          </button>
        </div>
      </header>

      {/* Tab 栏 */}
      <nav className={css.tabs}>
        <button type="button" role="tab" className={css.tab} data-active={tab === 'editor' || undefined} onClick={() => { setTab('editor') }}>
          <Settings size={14} /> Profile 配置
        </button>
        <button type="button" role="tab" className={css.tab} data-active={tab === 'chat' || undefined} onClick={() => { setTab('chat') }}>
          <MessageSquare size={14} /> 对话
        </button>
        <button type="button" role="tab" className={css.tab} data-active={tab === 'skill-manager' || undefined} onClick={() => { setTab('skill-manager') }}>
          <Package size={14} /> Skill 管理
        </button>
        <button type="button" role="tab" className={css.tab} data-active={tab === 'logs' || undefined} onClick={() => { setTab('logs') }}>
          <Activity size={14} /> 日志
        </button>
      </nav>

      <div className={css.body}>
        {/* ── Tab 1: Profile 编辑器 ── */}
        {tab === 'editor' && (
          <div className={css.editorLayout}>
            {/* 左侧：Profile 列表 */}
            <aside className={css.profileListPanel}>
              <div className={css.profileListHeader}>
                <span className={css.sidebarTitle}>Profiles</span>
                <button type="button" className={css.iconBtn} title="新建" onClick={onNewProfile}>
                  <Plus size={14} />
                </button>
              </div>
              <div className={css.profileList}>
                {profiles.length === 0 && (
                  <div className={css.emptyText}>暂无 Profile，点击 + 创建</div>
                )}
                {profiles.map(p => (
                  <div
                    key={p.id}
                    className={css.profileCard}
                    data-selected={editingExisting === p.id || undefined}
                    onClick={() => { onEditProfile(p) }}
                  >
                    <div className={css.profileCardHead}>
                      <span className={css.profileId}>{p.id}</span>
                      {agents.some(a => a.profileId === p.id) && (
                        <span className={css.agentBadge}><Activity size={10} /> 已创建</span>
                      )}
                    </div>
                    <div className={css.profileModel}>{p.model.provider}/{p.model.model}</div>
                    <div className={css.profilePrompt}>{p.prompt.slice(0, 60)}{p.prompt.length > 60 ? '...' : ''}</div>
                    <div className={css.profileMeta}>
                      {p.skills.length > 0 && <span>skills: {p.skills.length}</span>}
                      {p.mcpServers.length > 0 && <span>mcp: {p.mcpServers.length}</span>}
                      <span>terminal: {p.terminal.mode}</span>
                      <span>v{p.version}</span>
                    </div>
                  </div>
                ))}
              </div>
            </aside>

            {/* 右侧：编辑表单 */}
            <main className={css.editorForm}>
              <div className={css.formSection}>
                <label className={css.formLabel}>Profile ID</label>
                <input
                  className={css.formInput}
                  value={draft.id}
                  onChange={e => { setDraft(d => ({ ...d, id: e.target.value })) }}
                  placeholder="my-agent（slug 格式）"
                  disabled={editingExisting !== null}
                />
              </div>

              <div className={css.formSection}>
                <label className={css.formLabel}>System Prompt</label>
                <textarea
                  className={css.formTextarea}
                  value={draft.prompt}
                  onChange={e => { setDraft(d => ({ ...d, prompt: e.target.value })) }}
                  rows={4}
                  placeholder="Agent 的系统提示词..."
                />
              </div>

              <div className={css.formRow}>
                <div className={css.formSection}>
                  <label className={css.formLabel}>Provider</label>
                  <select
                    className={css.formSelect}
                    value={draft.provider}
                    onChange={e => {
                      const prov = providers.find(p => p.id === e.target.value)
                      setDraft(d => ({ ...d, provider: e.target.value, model: prov?.models[0]?.id ?? '' }))
                    }}
                  >
                    {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className={css.formSection}>
                  <label className={css.formLabel}>Model</label>
                  <select
                    className={css.formSelect}
                    value={draft.model}
                    onChange={e => { setDraft(d => ({ ...d, model: e.target.value })) }}
                  >
                    {currentProvider?.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <div className={css.formSection}>
                  <label className={css.formLabel}>Reasoning Effort</label>
                  <select
                    className={css.formSelect}
                    value={draft.reasoningEffort}
                    onChange={e => { setDraft(d => ({ ...d, reasoningEffort: e.target.value })) }}
                  >
                    <option value="">默认</option>
                    {reasoningEfforts.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
              </div>

              <div className={css.formSection}>
                <label className={css.formLabel}>
                  Skills
                  {availableSkills.length > 0 && <span className={css.formLabelCount}>{availableSkills.length} 个可用</span>}
                  {draft.skills.length > 0 && <span className={css.formLabelCount}>已选 {draft.skills.length}</span>}
                </label>
                {availableSkills.length === 0 ? (
                  <div className={css.skillsEmpty}>
                    暂无可用 Skill。请在 Skill 管理 tab 中导入 skill，
                    或在 skills 目录下创建含 SKILL.md 的子目录。
                  </div>
                ) : (
                  <div className={css.skillList}>
                    {availableSkills.map(sk => {
                      const checked = isSkillChecked(sk.name)
                      return (
                        <label key={sk.name} className={css.skillItem} data-checked={checked || undefined}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => { toggleSkill(sk) }}
                          />
                          <div className={css.skillItemBody}>
                            <div className={css.skillItemHead}>
                              <span className={css.skillName}>{sk.name}</span>
                              <span className={css.skillGit}>
                                {sk.currentVersion ?? '无版本'} · {sk.versionCount} 个版本
                              </span>
                              {checked && <span className={css.skillImportBadge}>已绑定</span>}
                            </div>
                            <span className={css.skillDesc}>{sk.description}</span>
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className={css.formSection}>
                <label className={css.formLabel}>Terminal Mode</label>
                <select
                  className={css.formSelect}
                  value={draft.terminalMode}
                  onChange={e => { setDraft(d => ({ ...d, terminalMode: e.target.value as 'sandbox' | 'host' })) }}
                >
                  <option value="sandbox">sandbox</option>
                  <option value="host">host</option>
                </select>
              </div>

              {/* MCP 提示（后续增量） */}
              <div className={css.formHint}>
                <Wrench size={12} /> MCP 服务器配置将在后续增量接入；当前编辑器已支持 prompt / model / skills / terminal。
              </div>

              <div className={css.formActions}>
                <button type="button" className={css.saveBtn} disabled={busy} onClick={() => { void onSaveProfile() }}>
                  <Save size={14} /> 保存 Profile
                </button>
                {editingExisting !== null && (
                  <button type="button" className={css.dangerBtn} disabled={busy} onClick={() => { void onDeleteProfile(editingExisting) }}>
                    <Trash2 size={14} /> 删除
                  </button>
                )}
                {editingExisting !== null && (
                  <button type="button" className={css.chatStartBtn} disabled={busy} onClick={() => { void onChatStart(editingExisting) }}>
                    <MessageSquare size={14} /> 创建 Agent 并对话
                  </button>
                )}
              </div>
            </main>
          </div>
        )}

        {/* ── Tab 2: 对话 ── */}
        {tab === 'chat' && (
          <div className={css.chatLayout}>
            {/* 左侧：选择 Profile */}
            <aside className={css.chatSidebar}>
              <div className={css.profileListHeader}>
                <span className={css.sidebarTitle}>选择 Profile</span>
              </div>
              <div className={css.profileList}>
                {profiles.map(p => (
                  <div
                    key={p.id}
                    className={css.profileCard}
                    data-selected={chatProfile === p.id || undefined}
                    onClick={() => { setChatProfile(p.id); setChatMessages([]) }}
                  >
                    <div className={css.profileCardHead}>
                      <span className={css.profileId}>{p.id}</span>
                      {agents.some(a => a.profileId === p.id) && (
                        <span className={css.agentBadge}><Activity size={10} /> 已创建</span>
                      )}
                    </div>
                    <div className={css.profileModel}>{p.model.provider}/{p.model.model}</div>
                  </div>
                ))}
              </div>
              {chatProfile !== null && !isAgentCreated && (
                <button type="button" className={css.chatStartBtn} disabled={busy} onClick={() => { void onChatStart(chatProfile) }}>
                  <Bot size={14} /> 创建 Agent
                </button>
              )}
            </aside>

            {/* 右侧：聊天区 */}
            <main className={css.chatMain}>
              {chatProfile === null ? (
                <div className={css.emptyText}>请从左侧选择一个 Profile</div>
              ) : !isAgentCreated ? (
                <div className={css.emptyText}>
                  Agent 尚未创建，点击左侧「创建 Agent」按钮
                </div>
              ) : (
                <>
                  <div className={css.chatMessages} ref={chatScrollRef}>
                    {chatMessages.length === 0 && (
                      <div className={css.emptyText}>输入消息开始与 Agent 对话</div>
                    )}
                    {chatMessages.map((msg, i) => (
                      <ChatMessageView key={i} message={msg} />
                    ))}
                    {chatRunning && (
                      <div className={css.chatLoading}>
                        <RefreshCw size={14} className={css.spinning} /> Agent 思考中...
                      </div>
                    )}
                  </div>
                  <div className={css.chatInputBar}>
                    <textarea
                      className={css.chatInput}
                      value={chatInput}
                      onChange={e => { setChatInput(e.target.value) }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          if (!chatRunning) void onChatSend()
                        }
                      }}
                      rows={1}
                      placeholder="输入消息，Enter 发送，Shift+Enter 换行..."
                      disabled={chatRunning}
                    />
                    <button type="button" className={css.sendBtn} disabled={chatRunning || chatInput.trim() === ''} onClick={() => { void onChatSend() }}>
                      <Send size={14} />
                    </button>
                  </div>
                </>
              )}
            </main>
          </div>
        )}

        {/* ── Tab 3: Skill 管理（独立组件，可复用到 IDE） ── */}
        {tab === 'skill-manager' && (
          <SkillManagerPanel />
        )}

        {/* ── Tab 4: 日志 ── */}
        {tab === 'logs' && (
          <div className={css.logFullList}>
            <div className={css.logHeader}>
              <span className={css.logTitle}>操作日志</span>
              <button type="button" className={css.logClear} onClick={() => { setLogs([]) }}>清空</button>
            </div>
            <div className={css.logList}>
              {logs.length === 0 && <div className={css.logEmpty}>暂无日志</div>}
              {logs.map((entry, i) => (
                <div key={i} className={css.logEntry} data-level={entry.level}>
                  <span className={css.logTime}>{entry.time}</span>
                  <span className={css.logMessage}>{entry.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── 聊天消息渲染 ────────────────────────────────────────────────────

function ChatMessageView({ message }: { message: ChatMessage }): ReactNode {
  const [showEvents, setShowEvents] = useState(false)
  if (message.role === 'user') {
    return (
      <div className={css.msgUser}>
        <div className={css.msgBubbleUser}>{message.text}</div>
      </div>
    )
  }
  return (
    <div className={css.msgAssistant}>
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
          {message.events.map((ev, i) => (
            <div key={i} className={css.eventRow}>
              <span className={css.eventType}>{ev.type}</span>
              <span className={css.eventData}>{JSON.stringify(ev.data)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
