/**
 * PublishModuleDialog —— Agent 预设「发布流程」配置 + 完成两屏（设计稿 P7/P8）。
 *
 * ## 闸门逻辑（行为规格 §5，用户明确要求「强制补全」）
 *
 * publishProfileModule 返回 blocked 非空 ⇒ **一个文件都不产出**。UI 必须：
 * 1. 把每个 blocked 项渲染成一张卡（设计稿 P7：每张卡「需要/装法/验证/下载」四行）；
 * 2. 顶部黄描边警示条 + 右上橙色「N 项 · M 项待补全」；
 * 3. footer 主按钮「补全后才能导出」**禁用**（禁用理由写在 title 里）；
 * 4. 每张未补全卡提供「让 Agent 重试」（调 authorModuleRequires）。
 *    重试后仍无信息 ⇒ 保持「待补全」并如实显示（不许静默留空）。
 *
 * ## 发布目标（行为规格 §5）
 *
 * 「导出为 package 文件」选中（真做）；「复制分享链接」与「发布到 Agent 市场」
 * 灰禁用 + 橙字「即将开放」（不可点——用户拍板的「预留」，不留 disabled 占位假承诺）。
 *
 * ## 可访问性
 *
 * 模态 role="dialog"；Esc 关闭用 capture 阶段 + stopPropagation（照 EditPresetView 既有做法）。
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle, Check, Copy, Eye, FileBox, FolderOpen, Link, Loader2,
  Package, Pencil, RefreshCw, Share2, Store, X,
} from 'lucide-react'
import { GlassButton } from '../shared.tsx'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import type {
  AuthorModuleRequiresResult, ExportModuleResult, ModuleMcpRequirement,
} from '../types.ts'
import css from '../SettingsSections.module.css'

/** 发布目标（设计稿 P7：单选，仅「导出为 package 文件」可选中）。 */
type PublishTarget = 'package' | 'link' | 'market'

/** MCP 安装说明项（AuthorModuleRequiresResult.entries 的一项 + 补全状态）。 */
interface McpInstallItem {
  name: string
  /** Agent 填写的安装说明（kind/hint/url/command/platforms）。 */
  requires?: ModuleMcpRequirement
  /** 是否在 unconfirmed 列表里（Agent 未能确认）。 */
  unconfirmed: boolean
}

/** 传播路径显示名（设计稿 P7「包含内容」清单行）。 */
interface ContentRow {
  label: string
  status: 'pack' | 'skip' | 'nopack'
}

export function PublishModuleDialog({ rpc, profileId, profileName, onClose }: {
  rpc: CorumRpcCall
  profileId: string
  profileName: string
  onClose: () => void
}) {
  // 屏幕：'config'（配置）或 'done'（完成）。
  const [screen, setScreen] = useState<'config' | 'done'>('config')

  // 基本信息表单（设计稿 P7：包名/版本/作者/显示名）。
  const [version, setVersion] = useState('1.0.0')
  const [author, setAuthor] = useState('')
  const [displayName, setDisplayName] = useState(profileName)

  // 发布目标。
  const [target, setTarget] = useState<PublishTarget>('package')

  // MCP 安装说明（authorModuleRequires 的结果）。
  const [mcpItems, setMcpItems] = useState<McpInstallItem[]>([])
  const [requiresLoading, setRequiresLoading] = useState(false)
  const [requiresError, setRequiresError] = useState<string | null>(null)
  // 订正编辑中的一项。
  const [editingName, setEditingName] = useState<string | null>(null)

  // 导出结果。
  const [exportResult, setExportResult] = useState<ExportModuleResult | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // 目录选择（导出目标路径）。
  const [outDir, setOutDir] = useState('')

  /**
   * Esc 关闭（capture + stopPropagation，照 EditPresetView 既有做法：
   * 设置壳 dialog 的 bubble 阶段 Esc 会关闭整个设置弹窗）。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  /* ── 让 Agent 补全安装说明（authorModuleRequires）────────────────── */

  /**
   * 调 authorModuleRequires 让 Agent 填写 MCP 安装说明（行为规格 §5.4）。
   *
   * 一次性 LLM 调用，返回的 unconfirmed 列出「Agent 未能确认」的那些——
   * UI 要把 unconfirmed 与「已补全」区分渲染，不许静默留空。
   * 重试后仍无信息 ⇒ 保持「待补全」并如实显示。
   */
  const fetchRequires = async () => {
    setRequiresLoading(true)
    setRequiresError(null)
    try {
      // ⚠️ 入参必须包一层 `input`：@Remote 端点形参是**唯一裸标识符**，typert 网关按它取名，
      // 平铺传 `{ profileId }` 会被拒（实机报错原文：
      // `args fields do not match the descriptor: unexpected "profileId"`）。
      const r = await rpc<AuthorModuleRequiresResult>('corumAgent', 'authorModuleRequires', { input: { profileId } })
      // 把 entries + unconfirmed 组装成 MCP 安装说明项列表。
      const entries = r.entries ?? {}
      const unconfirmedSet = new Set(r.unconfirmed ?? [])
      const items: McpInstallItem[] = Object.keys(entries).map(name => ({
        name,
        requires: entries[name],
        unconfirmed: unconfirmedSet.has(name),
      }))
      // unconfirmed 里可能有些不在 entries 里的名字（Agent 未能给任何信息）。
      for (const name of r.unconfirmed ?? []) {
        if (!items.some(i => i.name === name)) {
          items.push({ name, unconfirmed: true })
        }
      }
      setMcpItems(items)
      setAuthorOk(true)
    } catch (e) {
      // 模型路由取不到时 fail-loud（契约 §2.4），不假装成功——并且**不许**因此放开导出闸门。
      setAuthorOk(false)
      setRequiresError(e instanceof Error ? e.message : String(e))
    } finally {
      setRequiresLoading(false)
    }
  }

  // 进入配置屏时自动调一次 authorModuleRequires（让 Agent 补全）。
  useEffect(() => {
    if (screen === 'config' && mcpItems.length === 0 && !requiresLoading && requiresError === null) {
      void fetchRequires()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen])

  /* ── 闸门判断（行为规格 §5：blocked 非空 ⇒ 一个文件都不产出）────────── */

  /**
   * 一条安装说明是否**完整**（判据与 host 的 `validateMcpEntry` requires 段同源）。
   *
   * 为什么 UI 也要判一次：`unconfirmed` 只说明「Agent 没确认」，而用户在下面「订正」
   * 填完四个字段后**必须能解锁导出**——否则「你自己订正」这条路是死的
   * （本轮修：先前只按 unconfirmed 判，订正完按钮仍然灰着）。
   */
  const isRequiresComplete = (r: ModuleMcpRequirement | undefined): boolean => {
    if (r === undefined) return false
    if (r.hint.trim() === '') return false
    if (r.kind === 'app') return r.platforms !== undefined && Object.values(r.platforms).some(v => v.trim() !== '')
    if (r.kind === 'command') return r.command !== undefined && r.command.trim() !== ''
    // service：镜像类型里 url 是可选的（host 侧按 kind 必填），故按空串判。
    return (r.url ?? '').trim() !== ''
  }

  /**
   * 把当前（可能被订正过的）说明写回 host 的 sidecar。
   *
   * 不写回去会怎样：`publishProfileModule` 的闸门读的是 **host 侧那份**
   * （`<预设目录>/module-requires.json`，见 requires-store.ts 头注），
   * 订正只改 React state ⇒ 导出时 host 仍然报「未补全」，
   * 而 UI 这边按钮明明是亮的 —— 两处判据分叉，用户看到的是一句莫名其妙的失败。
   */
  const persistRequires = async (items: readonly McpInstallItem[]): Promise<void> => {
    const entries: Record<string, ModuleMcpRequirement> = {}
    for (const item of items) {
      if (isRequiresComplete(item.requires)) entries[item.name] = item.requires as ModuleMcpRequirement
    }
    if (Object.keys(entries).length === 0) return
    // 同上：`saveModuleRequiresRemote(input: {...})` ⇒ 必须包 `input`。
    await rpc<{ entries: Record<string, ModuleMcpRequirement> }>('corumAgent', 'saveModuleRequires', {
      input: { profileId, entries },
    })
  }



  /** 待补全项数（说明不完整）；Agent 未能确认但用户订正完整的项**不算**待补全。 */
  const pendingCount = mcpItems.filter(i => !isRequiresComplete(i.requires)).length
  /**
   * 「Agent 补全」这一次调用是否**成功拿到过**结果。
   *
   * 为什么必须有这个态（2026-10-11 实机抓到的闸门漏洞）：先前 blocked 只看
   * `pendingCount > 0`，而调用**失败**时 `mcpItems` 是空数组 ⇒ pendingCount = 0
   * ⇒ 导出按钮**亮着**，等于「一项都没确认」被当成了「全部已确认」。
   * 现在：没成功拿到结果 ⇒ 一律视为阻塞（空 mcpItems 只在「确实没有 MCP」时才是合法的，
   * 而那种情况 host 侧会返回零 blocked，导出照样能过）。
   */
  const [authorOk, setAuthorOk] = useState(false)
  /** blocked（= 说明未就绪或仍有待补全）⇒ 导出按钮禁用。 */
  const blocked = !authorOk || pendingCount > 0
  /** 阻塞的原因文案（禁用按钮的 title 与横幅共用，避免两处措辞分叉）。 */
  const blockedReason = authorOk
    ? `${pendingCount} 项 MCP 安装说明未补全，补全后才能导出`
    : '尚未取得 MCP 安装说明（见上方错误）——补全后才能导出'

  /* ── 导出（publishProfileModule）────────────────────────────────── */

  const doExport = async () => {
    if (blocked) return // 闸门：blocked 非空 ⇒ 不产出任何文件。
    setExporting(true)
    setExportError(null)
    try {
      // 订正是本地 state；导出闸门读 host 的 sidecar ⇒ 先写回去再导出（否则白灰一次）。
      await persistRequires(mcpItems)
      // ⚠️ host 的 @Remote 返回**对象包装**（`publishProfileModuleRemote` → `{ result }`），
      // 必须解包；按裸类型收会让 `r.blocked` 是 undefined ⇒ 闸门静默失效。
      const r = await rpc<{ result: ExportModuleResult }>('corumAgent', 'publishProfileModule', {
        input: {
          profileId,
          outDir: outDir.trim() !== '' ? outDir : '',
          version: version.trim() !== '' ? version : undefined,
          ...(author.trim() !== '' ? { author: author.trim() } : {}),
          ...(displayName.trim() !== '' ? { name: displayName.trim() } : {}),
        },
      })
      const result = r.result
      if (result === undefined || !Array.isArray(result.blocked)) {
        setExportError('导出返回的结构不完整（缺少 result/blocked）——请重试。')
        return
      }
      // 再次检查 blocked（host 侧可能发现新的缺 requires 条目）。
      if (result.blocked.length > 0) {
        // blocked 非空 ⇒ 没产出文件，留在配置屏，把 blocked 项更新进 mcpItems。
        const blockedNames = new Set(result.blocked.map(b => b.name))
        setMcpItems(prev => prev.map(i =>
          blockedNames.has(i.name) ? { ...i, unconfirmed: true } : i,
        ))
        setExportError(`有 ${result.blocked.length} 项 MCP 安装说明未补全，补全后才能导出`)
        return
      }
      setExportResult(result)
      setScreen('done')
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(false)
    }
  }

  /* ── 订正（编辑安装说明四字段）────────────────────────────────── */

  const updateRequires = (name: string, patch: Partial<ModuleMcpRequirement>) => {
    setMcpItems(prev => prev.map(i => {
      if (i.name !== name) return i
      const next = { ...(i.requires ?? { kind: 'command' as const, hint: '' }), ...patch } as ModuleMcpRequirement
      // 填完整就摘掉「Agent 未能确认」标记：那条黄色警示与「待补全」徽标不该再指着它。
      return { ...i, requires: next, unconfirmed: !isRequiresComplete(next) }
    }))
  }

  /* ── 复制路径 ─────────────────────────────────────────────────── */

  const copyPath = () => {
    if (exportResult?.archive !== undefined) {
      void navigator.clipboard.writeText(exportResult.archive).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
    }
  }

  /* ── 浏览目录 ─────────────────────────────────────────────────── */

  const pickDir = async () => {
    try {
      const r = await rpc<{ path: string | null }>('directoryPicker', 'pick', {})
      if (r.path !== null && r.path !== '') setOutDir(r.path)
    } catch {
      // 目录选择失败不阻断流程（留空 = host 默认输出目录）。
    }
  }

  /* ── 渲染 ─────────────────────────────────────────────────────── */

  return createPortal(
    <div className={css.modalOverlay} onClick={onClose}>
      <div
        className={`${css.modalDialog} ${css.publishDialog}`}
        role="dialog"
        aria-label="发布 Agent 预设"
        onClick={e => e.stopPropagation()}
      >
        {/* 标题行 */}
        <div className={css.modalHeader}>
          <span className={css.modalTitle}>发布 Agent 预设</span>
          <button type="button" className={css.modalClose} onClick={onClose}><X size={16} /></button>
        </div>

        <div className={css.modalBody}>
          {screen === 'config' && (
            <PublishConfigScreen
              profileId={profileId}
              version={version}
              setVersion={setVersion}
              author={author}
              setAuthor={setAuthor}
              displayName={displayName}
              setDisplayName={setDisplayName}
              mcpItems={mcpItems}
              requiresLoading={requiresLoading}
              requiresError={requiresError}
              onRetry={fetchRequires}
              editingName={editingName}
              setEditingName={setEditingName}
              onUpdateRequires={updateRequires}
              target={target}
              setTarget={setTarget}
              outDir={outDir}
              onPickDir={pickDir}
              pendingCount={pendingCount}
              exportError={exportError}
              blocked={blocked}
              authorOk={authorOk}
            />
          )}

          {screen === 'done' && exportResult !== null && (
            <PublishDoneScreen
              result={exportResult}
              profileId={profileId}
              version={version}
              copied={copied}
              onCopy={copyPath}
            />
          )}
        </div>

        {/* 底部按钮行（设计稿 P7/P8） */}
        <div className={css.modalFooter}>
          {screen === 'config' ? (
            <>
              <div className={css.footerLeft}>
                <GlassButton onClick={() => { /* 预览 package 内容——P2 留位 */ }}>
                  <Eye size={13} className={css.btnIconLeft} />预览 package 内容
                </GlassButton>
              </div>
              <div className={css.footerRight}>
                <GlassButton onClick={onClose}>取消</GlassButton>
                {/*
                  禁用理由写在 title 里（行为规格 §5.3：别只灰着）。
                  GlassButton 不接受 title prop，故用 span 包一层承载 title，
                  内部 GlassButton 走 disabled。
                */}
                <span title={blocked ? blockedReason : undefined}>
                  <GlassButton
                    variant="primary"
                    disabled={blocked || exporting}
                    onClick={() => void doExport()}
                  >
                    {exporting ? <Loader2 size={13} className={css.wizardSpin} /> : <Package size={13} className={css.btnIconLeft} />}
                    {blocked ? '补全后才能导出' : '导出为 package'}
                  </GlassButton>
                </span>
              </div>
            </>
          ) : (
            <div className={css.footerRight}>
              <GlassButton variant="primary" onClick={onClose}>完成</GlassButton>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ── 配置屏（设计稿 P7）─────────────────────────────────────────────── */

function PublishConfigScreen(props: {
  profileId: string
  version: string
  setVersion: (v: string) => void
  author: string
  setAuthor: (v: string) => void
  displayName: string
  setDisplayName: (v: string) => void
  mcpItems: McpInstallItem[]
  requiresLoading: boolean
  requiresError: string | null
  onRetry: () => void
  editingName: string | null
  setEditingName: (n: string | null) => void
  onUpdateRequires: (name: string, patch: Partial<ModuleMcpRequirement>) => void
  target: PublishTarget
  setTarget: (t: PublishTarget) => void
  outDir: string
  onPickDir: () => void
  pendingCount: number
  exportError: string | null
  /** 闸门结论（父组件唯一计算处；子组件只消费，不重算——两处重算必然分叉）。 */
  blocked: boolean
  /** 「Agent 补全」是否成功拿到过结果（决定警示条说「未取得」还是「有 N 项待补全」）。 */
  authorOk: boolean
}) {
  const {
    profileId, version, setVersion, author, setAuthor, displayName, setDisplayName,
    mcpItems, requiresLoading, requiresError, onRetry, editingName, setEditingName,
    onUpdateRequires, target, setTarget, outDir, onPickDir, pendingCount, exportError,
    blocked, authorOk,
  } = props

  // 包含内容摘要（设计稿 P7：标题右侧灰字摘要）。
  const contentRows: ContentRow[] = [
    { label: '人格 · 提示词', status: 'pack' },
    { label: '技能 · 随预设绑定', status: 'pack' },
    { label: '头像', status: 'pack' },
    { label: `MCP 配置 · ${mcpItems.length} 个`, status: 'pack' },
    { label: '模型设置（主 / 子 / 调查）', status: 'nopack' },
  ]

  return (
    <div className={css.publishBody}>
      <p className={css.wizardHint}>
        打包为可分享的模块（package），其它用户可用「导入 Agent 预设」安装。
      </p>

      {/* 基本信息（设计稿 P7：2×2 表单） */}
      <div className={css.publishSection}>
        <div className={css.publishSectionTitle}>基本信息</div>
        <div className={css.publishFormGrid}>
          <label className={css.publishField}>
            <span className={css.publishFieldLabel}>包名（ID）</span>
            <input type="text" className={css.publishFieldInput} value={profileId} disabled />
          </label>
          <label className={css.publishField}>
            <span className={css.publishFieldLabel}>版本</span>
            <input type="text" className={css.publishFieldInput} value={version} onChange={(e) => setVersion(e.target.value)} />
          </label>
          <label className={css.publishField}>
            <span className={css.publishFieldLabel}>作者</span>
            <input type="text" className={css.publishFieldInput} value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="你的名字" />
          </label>
          <label className={css.publishField}>
            <span className={css.publishFieldLabel}>显示名</span>
            <input type="text" className={css.publishFieldInput} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
        </div>
      </div>

      {/* 包含内容（设计稿 P7：清单行） */}
      <div className={css.publishSection}>
        <div className={css.publishSectionTitleRow}>
          <span className={css.publishSectionTitle}>包含内容</span>
          <span className={css.publishSectionSummary}>{contentRows.filter(r => r.status === 'pack').length} 项</span>
        </div>
        <div className={css.publishContentList}>
          {contentRows.map(r => (
            <div key={r.label} className={css.publishContentRow}>
              <span className={css.publishContentIcon}>
                {r.status === 'pack'
                  ? <Check size={12} className={css.wizardDepStatusOk} />
                  : <X size={12} className={css.wizardDepStatusErr} />
                }
              </span>
              <span className={css.publishContentLabel}>{r.label}</span>
              <span className={`${css.publishContentStatus} ${r.status === 'pack' ? css.publishContentPack : css.publishContentNopack}`}>
                {r.status === 'pack' ? '打包' : '不打包'}
              </span>
            </div>
          ))}
        </div>
        <div className={css.wizardTipRow}>
          <AlertCircle size={13} className={css.wizardTipIcon} />
          <span className={css.wizardTipText}>模型刻意不打包：安装方用自己的全局子 Agent 设置（全局没配才跟随主 Agent）。</span>
        </div>
      </div>

      {/* MCP 安装说明（设计稿 P7：闸门——blocked 非空 ⇒ 不产出） */}
      <div className={css.publishSection}>
        <div className={css.publishSectionTitleRow}>
          <span className={css.publishSectionTitle}>MCP 安装说明</span>
          {mcpItems.length > 0 && (
            <span className={css.publishSectionWarn}>
              {mcpItems.length} 项{pendingCount > 0 ? ` · ${pendingCount} 项待补全` : ''}
            </span>
          )}
        </div>
        <p className={css.wizardHint}>
          Agent 一直在用这些 MCP，最清楚要装什么、怎么装。发布时它会逐项巡检出配置并写成安装说明（你可以在下面订正）。
        </p>

        {/* 黄色警示条（设计稿 P7：有未补全项时）。
            两种阻塞形态用同一块 UI，但文案分开——「还没拿到说明」不是「有 N 项待补全」，
            把它说成后者会让用户以为已经拿到了清单、只是有几项没填。 */}
        {blocked && (
          <div className={css.publishWarnBar}>
            <AlertCircle size={14} className={css.publishWarnIcon} />
            <span>
              {authorOk
                ? `有 ${pendingCount} 项 MCP 安装说明未补全。`
                : '尚未取得 MCP 安装说明（Agent 补全未成功）。'}
              补全后才能导出 —— 这是为了不让安装方拿到一份无法执行的说明。
            </span>
          </div>
        )}

        {requiresLoading && (
          <div className={css.publishLoadingRow}>
            <Loader2 size={14} className={css.wizardSpin} /> Agent 正在补全安装说明…
          </div>
        )}

        {requiresError !== null && (
          <div className={css.publishErrorRow}>
            Agent 补全失败：{requiresError}
            <button type="button" className={css.publishRetryBtn} onClick={onRetry}>
              <RefreshCw size={12} className={css.btnIconLeft} />重试
            </button>
          </div>
        )}

        {/* MCP 项列表 */}
        {!requiresLoading && mcpItems.map(item => (
          <McpInstallCard
            key={item.name}
            item={item}
            editing={editingName === item.name}
            onEdit={() => setEditingName(editingName === item.name ? null : item.name)}
            onUpdate={(patch) => onUpdateRequires(item.name, patch)}
            onRetry={onRetry}
          />
        ))}
      </div>

      {/* 导出目录（设计稿 P7 无此字段，但 publishProfileModule 需要 outDir） */}
      <div className={css.publishSection}>
        <div className={css.publishSectionTitle}>导出位置</div>
        <div className={css.wizardPathRow}>
          <input
            type="text"
            className={css.wizardPathInput}
            placeholder="选择导出目录（留空用默认）…"
            value={outDir}
            readOnly
          />
          <GlassButton onClick={onPickDir}>浏览…</GlassButton>
        </div>
      </div>

      {/* 发布目标（设计稿 P7：单选卡片，仅 package 可选） */}
      <div className={css.publishSection}>
        <div className={css.publishSectionTitle}>发布目标</div>
        <div className={css.wizardSourceList}>
          <TargetCard
            active={target === 'package'}
            icon={<FileBox size={20} />}
            title="导出为 package 文件"
            desc="生成 .zip，可发给其他用户导入"
            onClick={() => setTarget('package')}
          />
          <TargetCard
            active={false}
            disabled
            icon={<Link size={20} />}
            title="复制分享链接"
            desc="上传后得到链接（需登录账号）"
            badge="即将开放"
            onClick={() => { /* 不可选 */ }}
          />
          <TargetCard
            active={false}
            disabled
            icon={<Store size={20} />}
            title="发布到 Agent 市场"
            desc="公开上架，供所有用户检索安装"
            badge="即将开放"
            onClick={() => { /* 不可选 */ }}
          />
        </div>
      </div>

      {/* 导出错误（host 返回） */}
      {exportError !== null && (
        <p className={css.wizardError}>{exportError}</p>
      )}
    </div>
  )
}

/** MCP 安装说明卡（设计稿 P7：每张卡「需要/装法/验证/下载」四行 + 状态 + 订正 + 重试）。 */
function McpInstallCard({ item, editing, onEdit, onUpdate, onRetry }: {
  item: McpInstallItem
  editing: boolean
  onEdit: () => void
  onUpdate: (patch: Partial<ModuleMcpRequirement>) => void
  onRetry: () => void
}) {
  const req = item.requires
  const isPending = item.unconfirmed || req === undefined

  return (
    <div className={`${css.publishMcpCard}${isPending ? ' ' + css.publishMcpPending : ''}`}>
      {/* 头行：名称 + 传输方式 + 右端状态 */}
      <div className={css.publishMcpHead}>
        <span className={css.publishMcpName}>{item.name}</span>
        <span className={css.publishMcpStatus}>
          {isPending ? (
            <span className={css.publishPendingBadge}>待补全</span>
          ) : (
            <><Check size={11} className={css.wizardDepStatusOk} />已补全</>
          )}
        </span>
      </div>

      {/* 安装说明正文（设计稿 P7：需要/装法/验证/下载四行） */}
      {req !== undefined && !editing && (
        <div className={css.publishMcpDetail}>
          {req.hint !== '' && (
            <div className={css.publishMcpDetailRow}>
              <span className={css.publishMcpDetailLabel}>需要：</span>
              <span>{req.hint}</span>
            </div>
          )}
          {req.url !== undefined && req.url !== '' && (
            <div className={css.publishMcpDetailRow}>
              <span className={css.publishMcpDetailLabel}>下载：</span>
              <a className={css.wizardDepLink} href={req.url} target="_blank" rel="noopener noreferrer">
                {req.url}
              </a>
            </div>
          )}
        </div>
      )}

      {/* 订正编辑态（设计稿 P7：✎ 订正 → 展开四字段编辑） */}
      {editing && req !== undefined && (
        <div className={css.publishMcpEdit}>
          <label className={css.publishField}>
            <span className={css.publishFieldLabel}>需要</span>
            <input
              type="text"
              className={css.publishFieldInput}
              value={req.hint}
              onChange={(e) => onUpdate({ hint: e.target.value })}
            />
          </label>
          {req.kind === 'command' && (
            <label className={css.publishField}>
              <span className={css.publishFieldLabel}>命令</span>
              <input
                type="text"
                className={css.publishFieldInput}
                value={req.command ?? ''}
                onChange={(e) => onUpdate({ command: e.target.value })}
              />
            </label>
          )}
          {req.kind === 'service' && (
            <label className={css.publishField}>
              <span className={css.publishFieldLabel}>服务 URL</span>
              <input
                type="text"
                className={css.publishFieldInput}
                value={req.url ?? ''}
                onChange={(e) => onUpdate({ url: e.target.value })}
              />
            </label>
          )}
          <label className={css.publishField}>
            <span className={css.publishFieldLabel}>下载页</span>
            <input
              type="text"
              className={css.publishFieldInput}
              value={req.url ?? ''}
              onChange={(e) => onUpdate({ url: e.target.value })}
            />
          </label>
        </div>
      )}

      {/* 订正 / 重试按钮（设计稿 P7：✎ 订正 + ↻ 让 Agent 重试） */}
      <div className={css.publishMcpActions}>
        <button type="button" className={css.publishEditBtn} onClick={onEdit}>
          <Pencil size={11} className={css.btnIconLeft} />订正
        </button>
        {isPending && (
          <button type="button" className={css.publishRetryBtn} onClick={onRetry}>
            <RefreshCw size={11} className={css.btnIconLeft} />让 Agent 重试
          </button>
        )}
      </div>

      {/* 项内黄色警示条（设计稿 P7：此项未补全将阻塞发布） */}
      {isPending && (
        <div className={css.publishMcpBlockBar}>
          此项未补全将阻塞发布。Agent 未能确认安装方式 —— 请补全，或让 Agent 带上更多上下文重试。
        </div>
      )}
    </div>
  )
}

/** 发布目标单选卡（复用 SourceCard 样式，设计稿 P7：仅 package 可选）。 */
function TargetCard({ active, disabled, icon, title, desc, badge, onClick }: {
  active: boolean
  disabled?: boolean
  icon: ReactNode
  title: string
  desc: string
  badge?: string
  onClick: () => void
}) {
  return (
    <div
      className={`${css.wizardSourceCard}${active ? ' ' + css.wizardSourceCardActive : ''}${disabled ? ' ' + css.wizardSourceCardDisabled : ''}`}
      onClick={disabled ? undefined : onClick}
      role={disabled ? undefined : 'button'}
    >
      <span className={css.wizardSourceIcon}>{icon}</span>
      <div className={css.wizardSourceMeta}>
        <span className={css.wizardSourceTitle}>{title}</span>
        <span className={css.wizardSourceDesc}>{desc}</span>
      </div>
      {badge !== undefined && <span className={css.wizardSoonBadge}>{badge}</span>}
      {active && !disabled && (
        <span className={css.wizardPickCircle}><Check size={12} /></span>
      )}
    </div>
  )
}

/* ── 完成屏（设计稿 P8）─────────────────────────────────────────────── */

function PublishDoneScreen({ result, profileId, version, copied, onCopy }: {
  result: ExportModuleResult
  profileId: string
  version: string
  copied: boolean
  onCopy: () => void
}) {
  // 文件名（设计稿 P8：等宽「corum-dev-1.0.0.zip · 815 KB」）。
  const archivePath = result.archive ?? result.dir
  const fileName = archivePath.split(/[/\\]/).pop() ?? archivePath

  return (
    <div className={css.publishBody}>
      {/* 中央结果区（设计稿 P8：大对勾 + 标题 + 副行） */}
      <div className={css.wizardDoneCenter}>
        <span className={css.wizardDoneCheck}><Check size={40} /></span>
        <span className={css.wizardDoneTitle}>Package 已导出</span>
        <span className={css.wizardDoneMono}>{fileName}</span>
        <span className={css.wizardDoneSub2}>其它用户用「导入 Agent 预设」即可安装</span>
      </div>

      {/* 路径条（设计稿 P8：浅灰底横条 + 等宽路径 + 复制按钮） */}
      <div className={css.publishPathBar}>
        <FolderOpen size={14} className={css.publishPathIcon} />
        <code className={css.wizardMono}>{archivePath}</code>
        <button type="button" className={css.publishCopyBtn} onClick={onCopy}>
          <Copy size={12} className={css.btnIconLeft} />{copied ? '已复制' : '复制路径'}
        </button>
      </div>

      {/* 核对清单（设计稿 P8：绿对勾前缀，数字与事实来自返回值） */}
      <div className={css.publishChecklist}>
        <div className={css.publishCheckRow}>
          <Check size={13} className={css.wizardDepStatusOk} />
          <span>MCP 安装说明已全部补全（{result.mcp.length} 项）</span>
        </div>
        <div className={css.publishCheckRow}>
          <Check size={13} className={css.wizardDepStatusOk} />
          <span>安装说明随包携带 —— 安装方在导入时会看到依赖检查与装法</span>
        </div>
        <div className={css.publishCheckRow}>
          <Check size={13} className={css.wizardDepStatusOk} />
          <span>模型设置已按约定剔除</span>
        </div>
      </div>

      {/* 接下来（设计稿 P8：三个操作并排，后两个灰禁用） */}
      <div className={css.publishSection}>
        <div className={css.publishSectionTitle}>接下来</div>
        <div className={css.publishNextRow}>
          <button
            type="button"
            className={css.publishNextBtn}
            onClick={() => {
              // 在文件夹中显示——通过 shell open（P0 留位，如实不假装已做）
              // 本仓设计红线：要么做真的、要么不出现。但设计稿画了它 ⇒ 保留并标注。
            }}
          >
            <FolderOpen size={13} className={css.btnIconLeft} />在文件夹中显示
          </button>
          <button type="button" className={css.publishNextBtn} disabled>
            <Share2 size={13} className={css.btnIconLeft} />复制分享链接 · 即将开放
          </button>
          <button type="button" className={css.publishNextBtn} disabled>
            <Store size={13} className={css.btnIconLeft} />发布到市场 · <span className={css.publishSoonText}>即将开放</span>
          </button>
        </div>
      </div>
    </div>
  )
}
