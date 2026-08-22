/**
 * SkillManagerPanel —— 独立 Skill 管理面板。
 *
 * 功能：
 *   1. 从文件导入 skill（skill 名称 + 源目录路径）
 *   2. 从文本导入 skill（skill 名称 + SKILL.md 内容）
 *   3. 列出所有已安装 skill（含版本信息）
 *   4. 删除 skill
 *   5. 查看版本历史
 *   6. 锁定（pin）指定版本
 *
 * 通过桌面 IPC 桥调 /api/skillManager/* RPC 端点。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { FileText, GitBranch, History, Lock, Package, RefreshCw, Trash2, Upload } from 'lucide-react'
import css from './SkillManagerPanel.module.css'

// ── RPC 类型（与 @corum/dev-skill-manager/types 对齐） ─────────────

interface SkillInfo {
  name: string
  description: string
  path: string
  currentVersion?: string
  versionCount: number
  createdAt?: string
}

interface ImportResult {
  ok: boolean
  error?: string
  skill?: SkillInfo
}

interface SkillVersion {
  id: string
  date: string
  label: string
}

interface SkillBinding {
  name: string
  versionId: string
}

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

// ── RPC 桥 ──────────────────────────────────────────────────────────

async function callRemote<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const bridge = (window as unknown as {
    corumDesktop?: { unary?: (pathname: string, body?: string) => Promise<{ status: number; body: string }> }
  }).corumDesktop
  if (bridge?.unary === undefined) throw new Error('desktop bridge unavailable')
  const rpcId = crypto.randomUUID()
  const message = { type: 'client-request', rpcId, method: `skillManager/${method}`, payload: { args } }
  const { status, body } = await bridge.unary(`/api/skillManager/${method}`, JSON.stringify(message))
  if (status !== 200) throw new Error(`skillManager/${method}: HTTP ${status}`)
  const envelope = JSON.parse(body) as { type: string; rpcId: string; result: RpcResult<T> }
  if (envelope.rpcId !== rpcId) throw new Error(`skillManager/${method}: rpcId mismatch`)
  if (!envelope.result.ok) throw new Error(`${envelope.result.error.code}: ${envelope.result.error.message}`)
  return envelope.result.value
}

// ── 主组件 ──────────────────────────────────────────────────────────

export function SkillManagerPanel(): ReactNode {
  const [skills, setSkills] = useState<readonly SkillInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // 从文件导入表单
  const [fileSkillName, setFileSkillName] = useState('')
  const [fileSourcePath, setFileSourcePath] = useState('')

  // 从文本导入表单
  const [textSkillName, setTextSkillName] = useState('')
  const [textContent, setTextContent] = useState('')

  // 版本历史状态
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null)
  const [versions, setVersions] = useState<readonly SkillVersion[]>([])
  const [pinnedBinding, setPinnedBinding] = useState<SkillBinding | null>(null)

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const { skills: list } = await callRemote<{ skills: SkillInfo[] }>('listAll', {})
      setSkills(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // 自动清除 success 消息
  useEffect(() => {
    if (success === null) return
    const timer = setTimeout(() => { setSuccess(null) }, 3000)
    return () => { clearTimeout(timer) }
  }, [success])

  // ── 导入操作 ──

  const onImportFromFile = useCallback(async () => {
    if (fileSkillName.trim() === '' || fileSourcePath.trim() === '') {
      setError('Skill 名称和源路径不能为空')
      return
    }
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const result = await callRemote<ImportResult>('importFromFile', {
        skillName: fileSkillName.trim(),
        sourcePath: fileSourcePath.trim(),
      })
      if (result.ok && result.skill) {
        setSuccess(`Skill "${result.skill.name}" 导入成功`)
        setFileSkillName('')
        setFileSourcePath('')
        await refresh()
      } else {
        setError(result.error ?? '导入失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [fileSkillName, fileSourcePath, refresh])

  const onImportFromText = useCallback(async () => {
    if (textSkillName.trim() === '' || textContent.trim() === '') {
      setError('Skill 名称和内容不能为空')
      return
    }
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const result = await callRemote<ImportResult>('importFromText', {
        skillName: textSkillName.trim(),
        content: textContent,
      })
      if (result.ok && result.skill) {
        setSuccess(`Skill "${result.skill.name}" 导入成功`)
        setTextSkillName('')
        setTextContent('')
        await refresh()
      } else {
        setError(result.error ?? '导入失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [textSkillName, textContent, refresh])

  // ── 删除操作 ──

  const onDeleteSkill = useCallback(async (skillName: string) => {
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const { ok, error: deleteError } = await callRemote<{ ok: boolean; error?: string }>('deleteSkill', {
        name: skillName,
      })
      if (ok) {
        setSuccess(`Skill "${skillName}" 已删除`)
        if (expandedSkill === skillName) {
          setExpandedSkill(null)
          setVersions([])
        }
        await refresh()
      } else {
        setError(deleteError ?? '删除失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [refresh, expandedSkill])

  // ── 版本历史操作 ──

  const onToggleHistory = useCallback(async (skillName: string) => {
    if (expandedSkill === skillName) {
          setExpandedSkill(null)
          setVersions([])
          setPinnedBinding(null)
          return
        }
        setExpandedSkill(skillName)
        setPinnedBinding(null)
        setBusy(true)
        setError(null)
        try {
          const { versions: v } = await callRemote<{ versions: SkillVersion[] }>('getSkillHistory', {
            name: skillName,
          })
          setVersions(v)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
          setVersions([])
        } finally {
          setBusy(false)
        }
  }, [expandedSkill])

  const onPinVersion = useCallback(async (skillName: string, versionId: string) => {
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const { binding } = await callRemote<{ binding: SkillBinding }>('pinVersion', {
        name: skillName,
        versionId,
      })
      setPinnedBinding(binding)
      setSuccess(`已锁定 Skill "${binding.name}" 到版本 ${binding.versionId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <div className={css.root}>
      {/* 标题栏 */}
      <header className={css.header}>
        <div className={css.headerLeft}>
          <Package size={20} />
          <span className={css.title}>Corum Skill Manager</span>
          <span className={css.badge}>skill manager</span>
        </div>
        <div className={css.headerRight}>
          <button type="button" className={css.headerBtn} disabled={busy} onClick={() => { void refresh() }}>
            <RefreshCw size={14} /> 刷新
          </button>
        </div>
      </header>

      <div className={css.body}>
        {/* 通知区 */}
        {error !== null && (
          <div className={css.alert} data-level="error">{error}</div>
        )}
        {success !== null && (
          <div className={css.alert} data-level="success">{success}</div>
        )}

        {/* 导入区 */}
        <div className={css.sections}>
          {/* 从文件导入 */}
          <div className={css.section}>
            <div className={css.sectionTitle}>
              <Upload size={14} /> 从文件导入
            </div>
            <div className={css.sectionForm}>
              <input
                className={css.input}
                value={fileSkillName}
                onChange={e => { setFileSkillName(e.target.value) }}
                placeholder="Skill 名称"
                disabled={busy}
              />
              <input
                className={css.input}
                value={fileSourcePath}
                onChange={e => { setFileSourcePath(e.target.value) }}
                placeholder="skill 源目录路径（如 /path/to/my-skill）"
                disabled={busy}
              />
              <button type="button" className={css.primaryBtn} disabled={busy} onClick={() => { void onImportFromFile() }}>
                <Upload size={14} /> 导入
              </button>
            </div>
          </div>

          {/* 从文本导入 */}
          <div className={css.section}>
            <div className={css.sectionTitle}>
              <FileText size={14} /> 从文本导入
            </div>
            <div className={css.sectionForm}>
              <input
                className={css.input}
                value={textSkillName}
                onChange={e => { setTextSkillName(e.target.value) }}
                placeholder="Skill 名称"
                disabled={busy}
              />
              <textarea
                className={css.textarea}
                value={textContent}
                onChange={e => { setTextContent(e.target.value) }}
                rows={6}
                placeholder="粘贴 SKILL.md 内容..."
                disabled={busy}
              />
              <button type="button" className={css.primaryBtn} disabled={busy} onClick={() => { void onImportFromText() }}>
                <FileText size={14} /> 导入
              </button>
            </div>
          </div>
        </div>

        {/* Skill 列表 */}
        <div className={css.section}>
          <div className={css.sectionTitle}>
            <Package size={14} /> 已安装 Skill
            {skills.length > 0 && <span className={css.count}>{skills.length} 个</span>}
          </div>
          {skills.length === 0 ? (
            <div className={css.empty}>暂无已安装 Skill。使用上方导入功能添加 skill。</div>
          ) : (
            <div className={css.skillList}>
              {skills.map(sk => (
                <div key={sk.name} className={css.skillCard}>
                  <div className={css.skillCardBody}>
                    <div className={css.skillCardHead}>
                      <span className={css.skillName}>{sk.name}</span>
                      <span className={css.gitBadge}>
                        <GitBranch size={10} />
                        {sk.currentVersion ?? '无版本'} · {sk.versionCount} 个版本
                      </span>
                    </div>
                    <span className={css.skillDesc}>{sk.description}</span>

                    {/* 版本历史展开区 */}
                    {expandedSkill === sk.name && (
                      <div className={css.historyList}>
                        {versions.length === 0 ? (
                          <div className={css.empty}>暂无版本历史</div>
                        ) : versions.map(ver => (
                          <div key={ver.id} className={css.historyEntry}>
                            <span className={css.historyHash}>{ver.id}</span>
                            <span className={css.historyMessage}>{ver.label}</span>
                            <span className={css.historyDate}>{ver.date}</span>
                            <button
                              type="button"
                              className={css.pinBtn}
                              disabled={busy}
                              onClick={() => { void onPinVersion(sk.name, ver.id) }}
                            >
                              <Lock size={12} /> 锁定此版本
                            </button>
                          </div>
                        ))}
                        {pinnedBinding !== null && pinnedBinding.name === sk.name && (
                          <div className={css.pinnedBinding}>
                            已锁定：{pinnedBinding.name} @ {pinnedBinding.versionId}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className={css.skillCardActions}>
                    <button
                      type="button"
                      className={css.headerBtn}
                      disabled={busy}
                      onClick={() => { void onToggleHistory(sk.name) }}
                    >
                      <History size={14} /> 版本
                    </button>
                    <button
                      type="button"
                      className={css.deleteBtn}
                      disabled={busy}
                      onClick={() => { void onDeleteSkill(sk.name) }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
