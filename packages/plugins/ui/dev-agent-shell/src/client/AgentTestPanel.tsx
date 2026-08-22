/**
 * AgentTestPanel —— dev-agent combo 的测试交互面板。
 *
 * 通过桌面 IPC 桥调 /api/corumAgent/* RPC 端点（CorumAgentService @Remote），
 * 验证核心 Agent 对象的 listProfiles / createAgent / runPrompt / verify。
 *
 * 布局：单页全屏，左侧 profile 列表 + 右侧测试操作区。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Activity, Bot, FlaskConical, Play, RefreshCw, Send } from 'lucide-react'
import css from './AgentTestPanel.module.css'

// ── RPC 类型 ────────────────────────────────────────────────────────

/** Profile 摘要（CorumAgentService.listProfilesRemote 返回）。 */
interface ProfileSummary {
  id: string
  prompt: string
  model: { provider: string; model: string; reasoningEffort?: string }
  skills: string[]
  mcpServers: string[]
  terminal: { mode: string }
  version: number
  trust: string
}

/** Agent 状态。 */
interface AgentStatus {
  profileId: string
  created: boolean
}

/** RPC 信封。 */
type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

// ── RPC 桥 ──────────────────────────────────────────────────────────

/** 经桌面 IPC 桥调 corumAgent Remote（与 PluginManagerPanel 同一信封契约）。 */
async function callRemote<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const bridge = (window as unknown as {
    corumDesktop?: { unary?: (pathname: string, body?: string) => Promise<{ status: number; body: string }> }
  }).corumDesktop
  if (bridge?.unary === undefined) throw new Error('desktop bridge unavailable')
  const rpcId = crypto.randomUUID()
  const message = { type: 'client-request', rpcId, method: `corumAgent/${method}`, payload: { args } }
  const { status, body } = await bridge.unary(`/api/corumAgent/${method}`, JSON.stringify(message))
  if (status !== 200) throw new Error(`corumAgent/${method}: HTTP ${status}`)
  const envelope = JSON.parse(body) as { type: string; rpcId: string; result: RpcResult<T> }
  if (envelope.rpcId !== rpcId) throw new Error(`corumAgent/${method}: rpcId mismatch`)
  if (!envelope.result.ok) throw new Error(`${envelope.result.error.code}: ${envelope.result.error.message}`)
  return envelope.result.value
}

// ── 组件 ────────────────────────────────────────────────────────────

/** 日志条目。 */
interface LogEntry {
  time: string
  level: 'info' | 'error' | 'success'
  message: string
}

export function AgentTestPanel(): ReactNode {
  const [profiles, setProfiles] = useState<readonly ProfileSummary[]>([])
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null)
  const [agents, setAgents] = useState<readonly AgentStatus[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [prompt, setPrompt] = useState('Reply with exactly the single word "ok".')
  const [reply, setReply] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [verifyResult, setVerifyResult] = useState<string | null>(null)

  const log = useCallback((level: LogEntry['level'], message: string) => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    setLogs(prev => [...prev, { time, level, message }])
  }, [])

  // 初始加载 profile 列表 + agent 列表。
  const refresh = useCallback(async () => {
    try {
      const { profiles: p } = await callRemote<{ profiles: ProfileSummary[] }>('listProfiles', {})
      setProfiles(p)
      if (selectedProfile === null && p.length > 0) setSelectedProfile(p[0].id)
      log('info', `已加载 ${p.length} 个 Profile`)
    } catch (error) {
      log('error', `加载 Profile 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const { agents: a } = await callRemote<{ agents: AgentStatus[] }>('listAgents', {})
      setAgents(a)
    } catch {
      // listAgents 失败静默（可能服务还没就绪）
    }
  }, [log, selectedProfile])

  useEffect(() => { void refresh() }, [refresh])

  // 冒烟测试。
  const onVerify = useCallback(async () => {
    setBusy(true)
    setVerifyResult(null)
    log('info', '开始冒烟测试...')
    try {
      const result = await callRemote<{ ok: boolean; reply?: string; error?: string }>('verify', {})
      if (result.ok) {
        setVerifyResult(`✓ 通过 — Agent 回复: ${JSON.stringify(result.reply)}`)
        log('success', `冒烟测试通过 — ${JSON.stringify(result.reply)}`)
      } else {
        setVerifyResult(`✗ 失败 — ${result.error}`)
        log('error', `冒烟测试失败 — ${result.error}`)
      }
    } catch (error) {
      setVerifyResult(`✗ 异常 — ${error instanceof Error ? error.message : String(error)}`)
      log('error', `冒烟测试异常 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [log])

  // 创建 Agent。
  const onCreateAgent = useCallback(async () => {
    if (selectedProfile === null) return
    setBusy(true)
    log('info', `创建 Agent (profile: ${selectedProfile})...`)
    try {
      await callRemote('createAgent', { profileId: selectedProfile })
      log('success', `Agent 已创建 (profile: ${selectedProfile})`)
      const { agents: a } = await callRemote<{ agents: AgentStatus[] }>('listAgents', {})
      setAgents(a)
    } catch (error) {
      log('error', `创建 Agent 失败 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [selectedProfile, log])

  // 运行 Prompt。
  const onRunPrompt = useCallback(async () => {
    if (selectedProfile === null || prompt.trim() === '') return
    setBusy(true)
    setReply(null)
    log('info', `发送 Prompt (profile: ${selectedProfile})...`)
    try {
      const { reply: r } = await callRemote<{ reply: string }>('runPrompt', {
        profileId: selectedProfile,
        prompt,
      })
      setReply(r)
      log('success', `Agent 回复: ${r.slice(0, 200)}${r.length > 200 ? '...' : ''}`)
    } catch (error) {
      log('error', `运行失败 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [selectedProfile, prompt, log])

  const isAgentCreated = agents.some(a => a.profileId === selectedProfile)

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
          <button type="button" className={css.headerBtn} disabled={busy} onClick={() => { void refresh() }}>
            <RefreshCw size={14} /> 刷新
          </button>
          <button type="button" className={css.headerBtn} disabled={busy} onClick={() => { void onVerify() }}>
            <FlaskConical size={14} /> 冒烟测试
          </button>
        </div>
      </header>

      <div className={css.body}>
        {/* 左侧：Profile 列表 */}
        <aside className={css.sidebar}>
          <div className={css.sidebarHeader}>
            <span className={css.sidebarTitle}>AgentProfile 列表</span>
            <span className={css.sidebarCount}>{profiles.length}</span>
          </div>
          <div className={css.profileList}>
            {profiles.length === 0 && (
              <div className={css.emptyText}>暂无 Profile（冒烟测试会自动创建 smoke-test）</div>
            )}
            {profiles.map(p => (
              <button
                key={p.id}
                type="button"
                className={css.profileCard}
                data-selected={selectedProfile === p.id || undefined}
                onClick={() => { setSelectedProfile(p.id) }}
              >
                <div className={css.profileCardHead}>
                  <span className={css.profileId}>{p.id}</span>
                  {agents.some(a => a.profileId === p.id) && (
                    <span className={css.agentBadge}><Activity size={10} /> 已创建</span>
                  )}
                </div>
                <div className={css.profileModel}>{p.model.provider}/{p.model.model}</div>
                <div className={css.profilePrompt}>{p.prompt.slice(0, 80)}{p.prompt.length > 80 ? '...' : ''}</div>
                <div className={css.profileMeta}>
                  {p.skills.length > 0 && <span>skills: {p.skills.length}</span>}
                  {p.mcpServers.length > 0 && <span>mcp: {p.mcpServers.length}</span>}
                  <span>terminal: {p.terminal.mode}</span>
                  <span>v{p.version}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* 右侧：测试操作区 */}
        <main className={css.main}>
          {/* 冒烟测试结果 */}
          {verifyResult !== null && (
            <div className={css.verifyResult} data-ok={verifyResult.startsWith('✓') || undefined}>
              {verifyResult}
            </div>
          )}

          {/* Profile 详情 + Agent 操作 */}
          {selectedProfile !== null && (
            <section className={css.section}>
              <h2 className={css.sectionTitle}>
                <Bot size={16} />
                <span>{selectedProfile}</span>
                {isAgentCreated && <span className={css.statusBadge}>Agent 已创建</span>}
              </h2>
              <div className={css.actions}>
                <button type="button" className={css.actionBtn} disabled={busy || isAgentCreated} onClick={() => { void onCreateAgent() }}>
                  <Play size={14} /> {isAgentCreated ? 'Agent 已创建' : '创建 Agent'}
                </button>
              </div>

              {/* Prompt 输入 */}
              <div className={css.promptArea}>
                <label className={css.promptLabel} htmlFor="prompt-input">发送 Prompt</label>
                <textarea
                  id="prompt-input"
                  className={css.promptInput}
                  value={prompt}
                  onChange={e => { setPrompt(e.target.value) }}
                  rows={3}
                  placeholder="输入要发送给 Agent 的提示词..."
                  disabled={busy}
                />
                <button
                  type="button"
                  className={css.sendBtn}
                  disabled={busy || prompt.trim() === ''}
                  onClick={() => { void onRunPrompt() }}
                >
                  <Send size={14} /> {busy ? '运行中...' : '发送'}
                </button>
              </div>

              {/* 回复 */}
              {reply !== null && (
                <div className={css.replyBox}>
                  <span className={css.replyLabel}>Agent 回复</span>
                  <pre className={css.replyText}>{reply}</pre>
                </div>
              )}
            </section>
          )}

          {/* 日志区 */}
          <section className={css.logSection}>
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
          </section>
        </main>
      </div>
    </div>
  )
}
