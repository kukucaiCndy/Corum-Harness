/**
 * ImportModuleWizard —— Agent 预设「导入向导」5 步模态（设计稿 P2–P6）。
 *
 * ## 为什么单独成文件
 *
 * 向导是一个自洽的 5 步状态机（选择来源 → 预览内容 → 依赖检查 → 冲突处理 → 完成），
 * 逻辑密度高、门禁规则多，塞进 SettingsAgentPresetsSection 会让它从「列表页」变成
 * 「列表页 + 向导」的混合体——可读性骤降。单独成文件后，状态机、门禁、第 ③ 步的
 * 「第 ② 层必须用户点测试才跑」等行为决定全部集中在这一处，便于审查与回归。
 *
 * ## 关键行为决定（逐条来自行为规格 §2/§3/§4，改前先读它）
 *
 * 1. **步骤推进必须由真实数据门禁**（设计稿的禁用态就是这条）：
 *    ①→② 未选来源/路径空 ⇒ 禁用；②→③ inspection===null ⇒ 禁用；
 *    ③→④ **永远允许**（跳过是正常路径）；④→⑤ installProfileModule 成功才推进。
 * 2. **第 ③ 步只自动跑第 ① 层**（inspectProfileModule 返回的 mcp[].status）：
 *    第 ② 层（真起进程/真连 HTTP）必须由用户点「测试」触发——自动跑会把用户
 *    本机所有 MCP 各起一遍，代价与副作用不该由一次预览产生（行为规格 §3）。
 * 3. **第 ④ 步默认值 = 设计稿选中的那个**（行为规格 §4）：
 *    MCP=保留现有、技能=保留我改过的、预设=跳过这个预设。
 *    只有真正存在同名的项才渲染该组。
 *
 * ## 可访问性（行为规格 §6.5）
 *
 * 模态 role="dialog"；Esc 关闭用 **capture 阶段 + stopPropagation**
 * （设置壳的 Esc 处理器在 bubble 阶段，不拦会把整个设置弹窗关掉——照 EditPresetView 既有做法）。
 */

import { useEffect, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft, ArrowRight, BookOpen, Check, ExternalLink, FileBox, Info, Link,
  Loader2, Minus, Server, Star, Terminal, TriangleAlert, X, ChevronRight,
} from 'lucide-react'
import { GlassButton } from '../shared.tsx'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
// 人格标签的唯一事实源在 Agent 预设 section（导出的那个函数），这里复用而不另建一份表。
import { personaPresetLabel } from './SettingsAgentPresetsSection.tsx'
import type {
  ModuleInspection, InstallModuleInput, InstallModuleResult,
  ModuleRequirementStatus, ReachabilityResult,
  FileDiffResult, DiffHunk, DiffHunkLine,
} from '../types.ts'
import css from '../SettingsSections.module.css'

/* ── 向导状态机（行为规格 §2）────────────────────────────────────────── */

type WizardSource = 'dir' | 'library' | 'link'

interface WizardState {
  step: 1 | 2 | 3 | 4 | 5
  /** 来源类型：dir=从文件导入、library=从内置模块库、link=从链接导入（即将开放，不可选）。 */
  source: WizardSource
  /** 从 directoryPicker 得到或手输的目录路径（契约 §7.3：是服务器侧不透明字符串）。 */
  dirPath: string
  /** 内置模块库选中的模块 dir（source==='library' 时）。 */
  libraryDir: string
  /** 第 ② 步拿到的检查结果。 */
  inspection: ModuleInspection | null
  /** 第 ④ 步冲突策略（行为规格 §4：默认值 = 设计稿选中的那个）。 */
  conflict: InstallModuleInput['conflict']
  /** 第 ③ 步每 MCP 的「测试」结果（第 ② 层 + 第 ③ 层）。 */
  probe: Record<string, { busy: boolean; reach?: ReachabilityResult; test?: { ok: boolean; error?: string }; error?: string }>
  /** 第 ⑤ 步安装结果。 */
  result: InstallModuleResult | null
  /** 全局错误（底栏上方显示）。 */
  error: string | null
}

const STEPS: { num: 1 | 2 | 3 | 4 | 5; label: string }[] = [
  { num: 1, label: '选择来源' },
  { num: 2, label: '预览内容' },
  { num: 3, label: '依赖检查' },
  { num: 4, label: '冲突处理' },
  { num: 5, label: '完成' },
]

/**
 * 第 ④ 步冲突默认值（行为规格 §4 = 设计稿选中的那个）。
 *
 * `skills`/`mcp` 是 **per-item**（key=名称）。空对象 `{}` = 全部走默认
 * （skills→'skip'、mcp→'keep'，安装函数取不到时自带的默认值），与设计稿
 * 「默认保留你现有的配置」一致。用户在第④步逐项选，选择写进对应 key。
 * `profile` 仍全局一档（同名预设只有一个）。
 */
const DEFAULT_CONFLICT: InstallModuleInput['conflict'] = {
  profile: 'skip',
  skills: {},
  mcp: {},
}

/* ── 导入向导主组件 ──────────────────────────────────────────────────── */

export function ImportModuleWizard({ rpc, onClose, onInstalled }: {
  rpc: CorumRpcCall
  onClose: () => void
  onInstalled: () => void
}) {
  const [state, setState] = useState<WizardState>({
    step: 1,
    source: 'dir',
    dirPath: '',
    libraryDir: '',
    inspection: null,
    conflict: { ...DEFAULT_CONFLICT },
    probe: {},
    result: null,
    error: null,
  })

  // 内置模块库列表（第 ① 步 source==='library' 时加载）。
  const [libraryModules, setLibraryModules] = useState<{ dir: string; manifest: { name: string; version: string; description?: string; id: string } }[] | null>(null)
  const [libLoading, setLibLoading] = useState(false)

  // 第 ② 步检查加载中。
  const [inspecting, setInspecting] = useState(false)

  // 第 ④ 步安装加载中。
  const [installing, setInstalling] = useState(false)

  // 路径输入（手输，不通过 directoryPicker 时也允许）。
  const [pathInput, setPathInput] = useState('')

  /** patch 状态（局部更新工具）。 */
  const patch = (p: Partial<WizardState>) => setState(s => ({ ...s, ...p }))

  /**
   * 统一关闭入口：安装成功后（已到第 ⑤ 步且有非 skipped 结果），任何关闭路径
   * （Esc / 遮罩 / 取消 / 完成）都必须刷新预设列表——否则列表停在安装前的快照，
   * 用户看到的是没装上（2026-10-14 实机：点「完成」→列表空→误判失败→重启才有）。
   *
   * 走 `onInstalled`（= setImportOpen(false) + reload()）而非 `onClose`（只关不刷新）；
   * 未成功安装时退回 `onClose`，避免一次无谓的 RPC。
   */
  const handleClose = () => {
    const installed = state.step === 5 && state.result !== null && !state.result.skipped
    if (installed) onInstalled()
    else onClose()
  }

  /**
   * Esc 关闭（capture 阶段 + stopPropagation，照 EditPresetView 既有注释的做法：
   * 设置壳 dialog 的 bubble 阶段 Esc 处理器会关闭整个设置弹窗，capture 先拿到并拦住）。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      handleClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [handleClose])

  /* ── 第 ① 步：加载内置模块库 ──────────────────────────────────────── */

  const loadLibrary = async () => {
    setLibLoading(true)
    try {
      const r = await rpc<{ modules: { dir: string; manifest: { name: string; version: string; description?: string; id: string } }[] }>(
        'corumAgent', 'listShippedModules', {},
      )
      // 读不到返回空数组（dev 布局下目录可能不存在，不抛——契约 §7.2）。
      setLibraryModules(r.modules ?? [])
    } catch {
      setLibraryModules([])
    } finally {
      setLibLoading(false)
    }
  }

  /**
   * 挂载即加载内置模块库。
   *
   * 为什么不能懒加载（2026-10-11 实机发现）：卡片上的副标题是
   * 「随产品分发 · N 个模块可用」——不预先加载就只能写 0，那是**假信息**
   * （本机实际有 1 个），用户会以为内置库是空的而根本不去点它。
   * 代价只是一次本地目录读，可忽略。
   */
  useEffect(() => {
    void loadLibrary()
    // 只在挂载时跑一次：库内容是随包资源，会话内不会变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── 第 ② 步：预览内容（inspectProfileModule）────────────────────────── */

  const doInspect = async (sourcePath: string) => {
    if (sourcePath.trim() === '') return
    setInspecting(true)
    patch({ error: null })
    try {
      // ⚠️ host 的 @Remote 一律返回**对象包装**（`inspectProfileModuleRemote` → `{ inspection }`），
      // 与本仓其它端点（`{ profiles }` / `{ servers }` / `{ entries }`）同款。
      // 2026-10-11 实机事故：这里曾按裸 `ModuleInspection` 收（`patch({ inspection: r })`），
      // 于是 `inspection.manifest` 是 undefined ⇒ `StepPreview` 里读 `manifest.name` 抛错
      // ⇒ **整个「Agent 预设」设置页变空白**（React 把该 slot 子树卸掉了）。
      // 两道防线：① 解包对；② 形状不对就报错，绝不让预览组件拿到半截对象。
      const r = await rpc<{ inspection: ModuleInspection }>('corumAgent', 'inspectProfileModule', { sourcePath })
      const inspection = r.inspection
      if (inspection === undefined || inspection.manifest === undefined) {
        patch({ error: '模块检查返回的结构不完整（缺少 inspection/manifest）——请重试或检查该模块目录。', inspection: null })
        return
      }
      patch({ inspection, step: 2 })
    } catch (e) {
      patch({ error: e instanceof Error ? e.message : String(e), inspection: null })
    } finally {
      setInspecting(false)
    }
  }

  /* ── 第 ③ 步：依赖检查 — 第 ② 层可达性测试（用户点触发）────────────── */

  /**
   * 第 ② 层可达性测试（行为规格 §3：必须由用户点击触发，不自动跑）。
   *
   * 理由（写死在代码里）：第 ② 层会**真的把用户的 MCP server 启动起来**
   * （npx -y xxx 这类命令会联网下载并启动真进程）。自动跑 = 用户只是「打开
   * 向导看一眼」就把本机所有 MCP 各起一遍，代价与副作用都不该由一次预览产生。
   */
  const testMcp = async (name: string) => {
    // 先标记 busy。
    setState(s => ({ ...s, probe: { ...s.probe, [name]: { busy: true } } }))
    try {
      // 第 ② 层：可达性探测（host 侧 reachability RPC，W2 实现）。
      // ⚠️ 如果该 RPC 尚未交付，调用会抛错——此时如实显示，不假装成功。
      let reach: ReachabilityResult | undefined
      try {
        reach = await rpc<ReachabilityResult>('mcpManager', 'probeReachability', { name })
      } catch {
        // W2 尚未交付时跳过第 ② 层，直接走第 ③ 层——不阻断流程。
      }
      // 第 ③ 层：握手（mcpManager/testConnection）。
      const test = await rpc<{ ok: boolean; error?: string; tools?: unknown[] }>(
        'mcpManager', 'testConnection', { name },
      )
      // exactOptionalPropertyTypes 下，可选属性不接受 undefined 值，
      // 故用条件展开构造（reach 存在才写、test.error 存在才写）。
      const probeEntry: WizardState['probe'][string] = {
        busy: false,
        ...(reach !== undefined ? { reach } : {}),
        test: {
          ok: test.ok,
          ...(test.ok !== true && test.error !== undefined ? { error: test.error } : {}),
        },
      }
      setState(s => ({
        ...s,
        probe: { ...s.probe, [name]: probeEntry },
      }))
    } catch (e) {
      setState(s => ({
        ...s,
        probe: { ...s.probe, [name]: { busy: false, error: e instanceof Error ? e.message : String(e) } },
      }))
    }
  }

  /* ── 第 ④ → ⑤ 步：安装 ────────────────────────────────────────────── */

  const doInstall = async () => {
    if (state.inspection === null) return
    setInstalling(true)
    patch({ error: null })
    try {
      // 同 inspect：host 返回 `{ result }` 包装，必须解包（否则完成屏拿不到结果）。
      const r = await rpc<{ result: InstallModuleResult }>('corumAgent', 'installProfileModule', {
        input: {
          sourceDir: state.inspection.dir,
          home: '', // host 侧用 CORUM_HOME，UI 传空让 host 取默认值。
          conflict: state.conflict,
        },
      })
      if (r.result === undefined) {
        patch({ error: '安装返回的结构不完整（缺少 result）——请重试。' })
        return
      }
      patch({ result: r.result, step: 5 })
    } catch (e) {
      patch({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setInstalling(false)
    }
  }

  /* ── 门禁（行为规格 §2：步骤推进必须由真实数据门禁）────────────────── */

  /** 第 ①→②：未选来源/路径为空 ⇒ 「下一步」禁用。 */
  const step1Valid = (): boolean => {
    if (state.source === 'dir') return state.dirPath.trim() !== ''
    if (state.source === 'library') return state.libraryDir !== ''
    return false // link 永远不可选（即将开放）。
  }

  /** 第 ②→③：inspection === null ⇒ 禁用。 */
  const step2Valid = (): boolean => state.inspection !== null

  // 第 ③→④：永远允许（跳过是正常路径，不是错误）。

  /** 第 ④→⑤：installProfileModule 成功才推进（由 doInstall 直接 patch step）。 */

  /* ── 渲染 ────────────────────────────────────────────────────────── */

  return createPortal(
    <div className={css.modalOverlay} onClick={handleClose}>
      <div
        className={`${css.modalDialog} ${css.wizardDialog}`}
        role="dialog"
        aria-label="导入 Agent 预设"
        onClick={e => e.stopPropagation()}
      >
        {/* 标题行 */}
        <div className={css.modalHeader}>
          <span className={css.modalTitle}>导入 Agent 预设</span>
          <button type="button" className={css.modalClose} onClick={handleClose}><X size={16} /></button>
        </div>

        {/* 步骤指示器（设计稿跨图一致：当前=紫圆数+加粗，已完成=紫圆白对勾，未到=灰） */}
        <div className={css.wizardStepper}>
          {STEPS.map((s, i) => (
            <div key={s.num} className={css.wizardStep}>
              <span
                className={`${css.wizardStepDot}${
                  state.step === s.num ? ' ' + css.wizardStepDotCurrent
                  : state.step > s.num ? ' ' + css.wizardStepDotDone
                  : ''
                }`}
              >
                {state.step > s.num ? <Check size={12} /> : s.num}
              </span>
              <span className={`${css.wizardStepLabel}${
                state.step === s.num ? ' ' + css.wizardStepLabelCurrent
                : state.step > s.num ? ' ' + css.wizardStepLabelDone : ''
              }`}>{s.label}</span>
              {i < STEPS.length - 1 && <span className={css.wizardStepConnector} />}
            </div>
          ))}
        </div>

        {/* 步骤内容 */}
        <div className={css.modalBody}>
          {/* 全局错误（底栏上方——行为规格 §2 第 ④→⑤ 门禁） */}
          {state.error !== null && (
            <p className={css.wizardError}>{state.error}</p>
          )}

          {state.step === 1 && (
            <StepSource
              source={state.source}
              onSelect={(src) => {
                patch({ source: src })
                if (src === 'library' && libraryModules === null) void loadLibrary()
              }}
              dirPath={state.dirPath}
              pathInput={pathInput}
              setPathInput={setPathInput}
              onPickDir={async () => {
                try {
                  const r = await rpc<{ path: string | null }>('directoryPicker', 'pick', {})
                  if (r.path !== null && r.path !== '') {
                    setPathInput(r.path)
                    patch({ dirPath: r.path, source: 'dir' })
                  }
                } catch (e) {
                  patch({ error: e instanceof Error ? e.message : String(e) })
                }
              }}
              onPathConfirm={() => patch({ dirPath: pathInput.trim(), source: 'dir' })}
              libraryModules={libraryModules}
              libLoading={libLoading}
              libraryDir={state.libraryDir}
              onLibrarySelect={(dir) => patch({ libraryDir: dir, source: 'library' })}
            />
          )}

          {state.step >= 2 && !isValidInspection(state.inspection) && (
            <p className={css.hintText}>模块检查数据不可用（结构不完整）。请返回上一步重新选择模块。</p>
          )}
          {state.step === 2 && isValidInspection(state.inspection) && (
            <StepPreview inspection={state.inspection} />
          )}

          {state.step === 3 && isValidInspection(state.inspection) && (
            <StepDeps
              inspection={state.inspection}
              probe={state.probe}
              onTest={testMcp}
            />
          )}

          {state.step === 4 && isValidInspection(state.inspection) && (
            <StepConflict
              inspection={state.inspection}
              conflict={state.conflict}
              onChange={(c) => patch({ conflict: c })}
            />
          )}

          {state.step === 5 && state.result !== null && state.inspection !== null && (
            <StepDone result={state.result} inspection={state.inspection} />
          )}
        </div>

        {/* 底部按钮行（设计稿跨图一致：左=上一步/辅助，右=主行动+次行动） */}
        <div className={css.modalFooter}>
          <div className={css.footerLeft}>
            {state.step > 1 && state.step < 5 && (
              <GlassButton onClick={() => patch({ step: (state.step - 1) as WizardState['step'] })}>
                <ArrowLeft size={13} className={css.btnIconLeft} />上一步
              </GlassButton>
            )}
          </div>
          <div className={css.footerRight}>
            <GlassButton onClick={handleClose}>取消</GlassButton>

            {state.step === 1 && (
              <GlassButton
                variant="primary"
                disabled={!step1Valid() || inspecting}
                onClick={() => {
                  // library 选中 ⇒ 用 libraryDir 作 sourcePath；dir ⇒ 用 dirPath。
                  const sp = state.source === 'library' ? state.libraryDir : state.dirPath
                  if (sp.trim() !== '') void doInspect(sp)
                }}
              >
                下一步 <ArrowRight size={13} className={css.btnIconRight} />
              </GlassButton>
            )}

            {state.step === 2 && (
              <GlassButton
                variant="primary"
                disabled={!step2Valid()}
                onClick={() => patch({ step: 3 })}
              >
                下一步 <ArrowRight size={13} className={css.btnIconRight} />
              </GlassButton>
            )}

            {state.step === 3 && (
              <>
                {/* 跳过是正常路径（行为规格 §2 第 ③→④ 门禁：永远允许） */}
                <GlassButton onClick={() => patch({ step: 4 })}>跳过，稍后再装</GlassButton>
                <GlassButton variant="primary" onClick={() => patch({ step: 4 })}>
                  安装并继续
                </GlassButton>
              </>
            )}

            {state.step === 4 && (
              <GlassButton
                variant="primary"
                disabled={installing}
                onClick={() => void doInstall()}
              >
                {installing ? '安装中…' : '开始安装'}
              </GlassButton>
            )}

            {state.step === 5 && state.result !== null && (
              <>
                <GlassButton onClick={() => { onInstalled() }}>查看预设</GlassButton>
                <GlassButton variant="primary" onClick={handleClose}>完成</GlassButton>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ── 第 ① 步：选择来源（设计稿 P2）───────────────────────────────────── */

function StepSource({ source, onSelect, dirPath, pathInput, setPathInput, onPickDir, onPathConfirm, libraryModules, libLoading, libraryDir, onLibrarySelect }: {
  source: WizardSource
  onSelect: (s: WizardSource) => void
  dirPath: string
  pathInput: string
  setPathInput: (v: string) => void
  onPickDir: () => void
  onPathConfirm: () => void
  libraryModules: { dir: string; manifest: { name: string; version: string; description?: string; id: string } }[] | null
  libLoading: boolean
  libraryDir: string
  onLibrarySelect: (dir: string) => void
}) {
  return (
    <div className={css.wizardStepBody}>
      <p className={css.wizardHint}>
        模块包含 Agent 的人格、提示词、技能与 MCP 配置。
      </p>

      {/* 来源选项（设计稿 P2：单选卡片组，选中=描边+右端圆对勾） */}
      <div className={css.wizardSourceList}>
        <SourceCard
          active={source === 'dir'}
          icon={<FileBox size={20} />}
          title="从文件导入"
          desc=".zip 或解压后的模块目录"
          onClick={() => onSelect('dir')}
        />
        <SourceCard
          active={source === 'library'}
          icon={<BookOpen size={20} />}
          title="从内置模块库"
          desc={`随产品分发 · ${libraryModules?.length ?? 0} 个模块可用`}
          onClick={() => onSelect('library')}
        />
        <SourceCard
          active={false}
          disabled
          icon={<Link size={20} />}
          title="从链接导入"
          desc="粘贴模块下载地址"
          badge="即将开放"
          onClick={() => { /* 不可选 */ }}
        />
      </div>

      {/* 从文件导入：路径选择 */}
      {source === 'dir' && (
        <div className={css.wizardPathRow}>
          <input
            type="text"
            className={css.wizardPathInput}
            placeholder="选择或输入模块目录路径…"
            value={pathInput}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setPathInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onPathConfirm() }}
          />
          <GlassButton onClick={onPickDir}>浏览…</GlassButton>
          {dirPath !== '' && <span className={css.wizardPathConfirmed}>已选：{dirPath}</span>}
        </div>
      )}

      {/* 从内置模块库：列表 */}
      {source === 'library' && (
        <div className={css.wizardLibraryList}>
          {libLoading && <p className={css.hintText}>加载中…</p>}
          {!libLoading && libraryModules !== null && libraryModules.length === 0 && (
            <p className={css.hintText}>暂无内置模块（dev 布局下目录可能不存在）。</p>
          )}
          {!libLoading && libraryModules !== null && libraryModules.length > 0 && (
            libraryModules.map(m => (
              <div
                key={m.dir}
                className={`${css.wizardLibraryItem}${libraryDir === m.dir ? ' ' + css.wizardLibraryItemActive : ''}`}
                onClick={() => onLibrarySelect(m.dir)}
                role="button"
              >
                <div className={css.wizardLibraryMeta}>
                  <span className={css.wizardLibraryName}>{m.manifest.name}</span>
                  <span className={css.wizardLibraryVer}>v{m.manifest.version}</span>
                </div>
                {m.manifest.description !== undefined && (
                  <span className={css.wizardLibraryDesc}>{m.manifest.description}</span>
                )}
                {libraryDir === m.dir && <Check size={14} className={css.wizardPickCheck} />}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/**
 * `inspection` 的形状护栏。
 *
 * 为什么需要它（2026-10-11 实机事故的直接产物）：`StepPreview` 读 `manifest.name`，
 * 一旦 `inspection` 是半截对象（例如 RPC 包装没解），**抛错会把整个「Agent 预设」
 * 设置页卸成空白**（slot entry crashed），用户看到的是整页没了，而不是一行错误。
 * 故渲染前三步的每一个入口都先过这道判据：形状不对 ⇒ 显示可读提示，绝不进组件。
 */
function isValidInspection(value: ModuleInspection | null): value is ModuleInspection {
  return value !== null && value.manifest !== undefined && value.profile !== undefined
    && Array.isArray(value.skills) && Array.isArray(value.mcp)
}

/** 来源单选卡（设计稿 P2：选中=描边+右端圆对勾；未开放项灰化）。 */
function SourceCard({ active, disabled, icon, title, desc, badge, onClick }: {
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

/* ── 第 ② 步：预览内容（设计稿 P3）───────────────────────────────────── */

function StepPreview({ inspection }: { inspection: ModuleInspection }) {
  const { manifest, profile, skills, mcp, hasAvatar } = inspection
  return (
    <div className={css.wizardStepBody}>
      {/* 模块摘要卡（设计稿 P3：图标+名称+副行+标签行） */}
      <div className={css.wizardModuleCard}>
        <span className={css.wizardModuleIcon}><Terminal size={20} /></span>
        <div className={css.wizardModuleMeta}>
          <span className={css.wizardModuleName}>{manifest.name}</span>
          <span className={css.wizardModuleSub}>
            {profile.name}{manifest.author !== undefined ? ` · ${manifest.author}` : ''}
          </span>
        </div>
        <div className={css.wizardModuleTags}>
          <span className={css.wizardVerTag}>v{manifest.version}</span>
          {hasAvatar && <span className={css.wizardBadge}>头像</span>}
        </div>
      </div>

      {/* 人格段（设计稿 P3：「人格 · … 职责提示词 N 字」+ 摘录截断）
          ⚠️ 模块常**只带 personaPreset 不带自由文本 persona**（导出时两者都保留，
          但内置 corum-dev 就是 preset 形态）——只看 persona 会让这一整段消失，
          而「人格被打包」正是用户要模块化的三个理由之一，看不见就等于没交代。 */}
      {(profile.persona !== undefined || profile.personaPreset !== undefined) && (
        <div className={css.wizardSection}>
          <div className={css.wizardSectionTitle}>
            人格 · {profile.persona ?? personaPresetLabel(profile.personaPreset ?? '')}
            {profile.duties !== undefined && (
              <span className={css.wizardSectionCount}>　职责提示词 {countChars(profile.duties)} 字</span>
            )}
          </div>
          {profile.duties !== undefined && (
            <p className={css.wizardPromptExcerpt}>{profile.duties}</p>
          )}
        </div>
      )}

      {/* 技能列表（设计稿 P3：「将安装 N 个技能」） */}
      {skills.length > 0 && (
        <div className={css.wizardSection}>
          <div className={css.wizardSectionTitle}>将安装 {skills.length} 个技能</div>
          {skills.map(s => (
            <div key={s.name} className={css.wizardListItem}>
              <span className={css.wizardListIcon}><Star size={12} /></span>
              <span className={css.wizardListName}>{s.name}</span>
              <span className={css.wizardListBadge}>
                {s.exists ? '已存在 · 跳过' : '新增'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* MCP 列表（设计稿 P3：「需要 N 个 MCP 服务」） */}
      {mcp.length > 0 && (
        <div className={css.wizardSection}>
          <div className={css.wizardSectionTitle}>需要 {mcp.length} 个 MCP 服务</div>
          {mcp.map(m => (
            <div key={m.name} className={css.wizardListItem}>
              <span className={css.wizardListIcon}><Server size={12} /></span>
              <span className={css.wizardListName}>{m.name}</span>
              <span className={css.wizardListBadgeWarn}>待检查</span>
            </div>
          ))}
        </div>
      )}

      {/* 检查差异（清单与磁盘实况不一致时逐条报出来——契约 §2.1） */}
      {inspection.warnings.length > 0 && (
        <div className={css.wizardWarnings}>
          {inspection.warnings.map((w, i) => (
            <p key={i} className={css.wizardWarningLine}>⚠ {w}</p>
          ))}
        </div>
      )}

      {/* 提示行（设计稿 P3：圆圈 i 图标） */}
      <div className={css.wizardTipRow}>
        <Info size={13} className={css.wizardTipIcon} />
        <span className={css.wizardTipText}>模型不随模块携带：安装后跟随你的全局子 Agent 设置（全局没配才跟随主 Agent）。</span>
      </div>
    </div>
  )
}

/* ── 第 ③ 步：依赖检查（设计稿 P4）────────────────────────────────────── */

/**
 * 依赖检查步（行为规格 §3：本功能最容易做错的地方）。
 *
 * 进入本步时只自动跑第 ① 层（inspection.mcp[].status 就是它）。
 * 第 ② 层必须由用户点击触发（见 testMcp 的注释）。
 */
function StepDeps({ inspection, probe, onTest }: {
  inspection: ModuleInspection
  probe: WizardState['probe']
  onTest: (name: string) => void
}) {
  const { mcp } = inspection
  // 需处理项数（第 ① 层未就绪的）。
  const needAttention = mcp.filter(m => !m.status.ok).length

  return (
    <div className={css.wizardStepBody}>
      <p className={css.wizardHint}>
        MCP 配置需要对应的程序或服务在本机可用。逐项检查结果如下 —— 未就绪的项可跳过，装好后在「MCP 与集成」里点「测试连接」复验。
      </p>

      {mcp.map(m => (
        <DepCard
          key={m.name}
          name={m.name}
          status={m.status}
          probe={probe[m.name]}
          onTest={() => onTest(m.name)}
        />
      ))}

      {/* 汇总警示行（设计稿 P4：「N 项需处理」） */}
      {needAttention > 0 && (
        <div className={css.wizardSummaryWarn}>
          <TriangleAlert size={14} className={css.wizardSummaryIcon} />
          <span>{needAttention} 项需处理。可以继续安装（这些 MCP 暂不可用），也可以先处理再继续。</span>
        </div>
      )}
    </div>
  )
}

/** 一张 MCP 依赖卡（设计稿 P4：三档状态卡 + 第 ② 层测试结果）。 */
function DepCard({ name, status, probe, onTest }: {
  name: string
  status: ModuleRequirementStatus
  probe: WizardState['probe'][string]
  onTest: () => void
}) {
  // 第 ① 层就绪态。
  const layer1Ok = status.ok
  const cardClass = layer1Ok
    ? css.wizardDepOk
    : status.kind === 'service'
      ? css.wizardDepError
      : css.wizardDepWarn

  return (
    <div className={`${css.wizardDepCard} ${cardClass}`}>
      {/* 头行：图标 + 名称 + 右端状态 */}
      <div className={css.wizardDepHead}>
        <span className={css.wizardDepIcon}><Server size={14} /></span>
        <span className={css.wizardDepName}>{name}</span>
        <span className={css.wizardDepStatus}>
          {layer1Ok ? (
            <><Check size={12} className={css.wizardDepStatusOk} />已就绪</>
          ) : status.kind === 'service' ? (
            <><Minus size={12} className={css.wizardDepStatusErr} />不可用 · 需运行期验证</>
          ) : (
            <><TriangleAlert size={12} className={css.wizardDepStatusWarn} />未就绪</>
          )}
        </span>
      </div>

      {/* 检查行（等宽，终端样式） */}
      <div className={css.wizardDepCheck}>
        <span className={css.wizardTerminalPrefix}>&gt;_</span>
        <code className={css.wizardMono}>{status.detail}</code>
      </div>

      {/* 安装指引 + 下载链接（设计稿 P4） */}
      {status.hint !== undefined && (
        <p className={css.wizardDepHint}>{status.hint}</p>
      )}
      {status.url !== undefined && (
        <a
          className={css.wizardDepLink}
          href={status.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink size={11} className={css.btnIconLeft} />{status.url}
        </a>
      )}

      {/* 第 ②③ 层测试按钮 + 结果（行为规格 §3：用户点触发） */}
      <div className={css.wizardDepTestRow}>
        <button
          type="button"
          className={css.wizardTestBtn}
          disabled={probe?.busy === true}
          onClick={onTest}
        >
          {probe?.busy === true ? <Loader2 size={12} className={css.wizardSpin} /> : '测试'}
        </button>
        {probe?.reach !== undefined && (
          <span className={css.wizardProbeResult}>
            {probe.reach.started
              ? <><Check size={11} className={css.wizardDepStatusOk} />程序可启动</>
              : <><Minus size={11} className={css.wizardDepStatusErr} />启动失败：{probe.reach.detail}</>
            }
          </span>
        )}
        {probe?.test !== undefined && (
          <span className={css.wizardProbeResult}>
            {probe.test.ok
              ? <><Check size={11} className={css.wizardDepStatusOk} />连接成功</>
              : <><Minus size={11} className={css.wizardDepStatusErr} />握手失败：{probe.test.error ?? ''}</>
            }
          </span>
        )}
        {probe?.error !== undefined && (
          <span className={css.wizardProbeError}>{probe.error}</span>
        )}
      </div>
    </div>
  )
}

/* ── 第 ④ 步：冲突处理（设计稿 P5）────────────────────────────────────── */

/**
 * 冲突处理步（行为规格 §4：默认值 = 设计稿选中的那个）。
 *
 * **per-item 冲突策略**（本轮改造）：每个 `exists===true` 的技能/MCP 独立成一项，
 * 默认收起，每项有「查看详情 ▸ · N 行变更」入口（点击弹出 split-view diff 面板）
 * + per-item 的保留/覆盖单选。同名预设仍全局一档（同名预设只有一个）。
 *
 * 只有真正存在同名的项才渲染（inspection 里的 exists 字段）。
 * 没有冲突 ⇒ 显示「没有冲突，可以直接安装」。
 */
function StepConflict({ inspection, conflict, onChange }: {
  inspection: ModuleInspection
  conflict: InstallModuleInput['conflict']
  onChange: (c: InstallModuleInput['conflict']) => void
}) {
  const { mcp, skills } = inspection
  // 同名 MCP（注册表已有）。
  const conflictMcp = mcp.filter(m => m.exists)
  // 同名技能（本机已有）。
  const conflictSkills = skills.filter(s => s.exists)
  // 同名预设：**由 host 的 profile.exists 回答**（2026-10-11 实机补漏）。
  // 先前这里按 `warnings` 里有没有「预设已存在」字样猜，而 host 从不发那条 warning
  // ⇒ 该组永不渲染 ⇒ 默认的 `conflict.profile`（skip）看起来"没被用上"，
  // 而一旦默认改回 overwrite 就会静默覆盖用户已有预设。
  const profileExists = inspection.profile.exists

  const hasConflict = conflictMcp.length > 0 || conflictSkills.length > 0 || profileExists

  // 当前打开的 diff 详情面板（null=没打开）。一个面板一次只显示一项的 diff。
  const [diffOpen, setDiffOpen] = useState<{ kind: 'skill' | 'mcp'; name: string } | null>(null)

  return (
    <div className={css.wizardStepBody}>
      {hasConflict ? (
        <p className={css.wizardHint}>检测到同名项。逐项选择保留哪一份 —— 默认保留你现有的配置。</p>
      ) : (
        <p className={css.wizardHint}>没有冲突，可以直接安装。</p>
      )}

      {/* 同名 MCP：每项独立成组（per-item：保留现有 / 用模块的覆盖） */}
      {conflictMcp.map(m => {
        // 把 host 的单个 `diff?: FileDiffResult` 归一成数组（无 diff ⇒ 空数组）。
        const mcpDiff: readonly FileDiffResult[] = m.diff !== undefined ? [m.diff] : []
        return (
          <ConflictItemRow
            key={`mcp-${m.name}`}
            kind="mcp"
            name={m.name}
            diff={mcpDiff}
            selected={conflict.mcp[m.name] ?? 'keep'}
            onSelect={(v) => onChange({
              ...conflict,
              mcp: { ...conflict.mcp, [m.name]: v as 'keep' | 'overwrite' },
            })}
            onViewDetail={() => setDiffOpen({ kind: 'mcp', name: m.name })}
          />
        )
      })}

      {/* 同名技能：每项独立成组（per-item：保留我改过的 / 用模块的覆盖） */}
      {conflictSkills.map(s => {
        // 技能的 `diff` 已是 `readonly FileDiffResult[]`，无 diff 时 undefined ⇒ 空数组。
        const skillDiff: readonly FileDiffResult[] = s.diff ?? []
        return (
          <ConflictItemRow
            key={`skill-${s.name}`}
            kind="skill"
            name={s.name}
            diff={skillDiff}
            selected={conflict.skills[s.name] ?? 'skip'}
            onSelect={(v) => onChange({
              ...conflict,
              skills: { ...conflict.skills, [s.name]: v as 'skip' | 'overwrite' },
            })}
            onViewDetail={() => setDiffOpen({ kind: 'skill', name: s.name })}
          />
        )
      })}

      {/* 同名预设（设计稿 P5 第三组：仍全局一档——同名预设只有一个） */}
      {profileExists && (
        <ConflictGroup label="同名 Agent 预设 · 已存在" items={[inspection.manifest.id]} warn>
          <SegmentedOptions
            options={[
              {
                id: 'overwrite',
                label: '覆盖现有',
                desc: inspection.profile.existingNickname !== undefined
                  ? `覆盖会替换「${inspection.profile.existingNickname}」的人格、提示词与技能绑定；你的模型设置与 MCP 绑定保持不变`
                  : '覆盖会替换该预设的人格、提示词与技能绑定；你的模型设置与 MCP 绑定保持不变',
              },
              { id: 'rename', label: `另存为 ${inspection.manifest.id}-2` },
              { id: 'skip', label: '跳过这个预设' },
            ]}
            selected={conflict.profile}
            onSelect={(v) => onChange({ ...conflict, profile: v as 'overwrite' | 'rename' | 'skip' })}
          />
        </ConflictGroup>
      )}

      {/* diff 详情面板（模态，createPortal 到 document.body） */}
      {diffOpen !== null && (() => {
        // 把 host 的 diff 形态归一成数组：技能=diff（已是数组）；MCP=单个 diff 包进 [diff]。
        // 按 kind 分支处理，避免 TS 把 `item.diff` 推成 `FileDiffResult | readonly FileDiffResult[]`
        // 的并集（两种形态的 diff 字段类型不同——技能是数组、MCP 是单个）。
        let files: readonly FileDiffResult[]
        if (diffOpen.kind === 'skill') {
          const item = skills.find(s => s.name === diffOpen.name)
          files = item?.diff ?? []
        } else {
          const item = mcp.find(m => m.name === diffOpen.name)
          files = item?.diff !== undefined ? [item.diff] : []
        }
        if (files.length === 0) {
          // 理论上不会发生（diffOpen 只在有 diff 的项上可点）；防御性不渲染。
          return null
        }
        const cur = diffOpen.kind === 'skill'
          ? (conflict.skills[diffOpen.name] ?? 'skip')
          : (conflict.mcp[diffOpen.name] ?? 'keep')
        return (
          <DiffDetailPanel
            name={diffOpen.name}
            kind={diffOpen.kind}
            files={files}
            selected={cur}
            onSelect={(v) => onChange(
              diffOpen.kind === 'skill'
                ? { ...conflict, skills: { ...conflict.skills, [diffOpen.name]: v as 'skip' | 'overwrite' } }
                : { ...conflict, mcp: { ...conflict.mcp, [diffOpen.name]: v as 'keep' | 'overwrite' } },
            )}
            onClose={() => setDiffOpen(null)}
          />
        )
      })()}
    </div>
  )
}

/**
 * per-item 冲突项行（设计稿 P5 收起态 `OkYeq` 节点：名称 + 已存在徽标 +
 * 「查看详情 ▸ · N 行变更」按钮 + per-item 保留/覆盖单选）。
 *
 * `diff` 是**非空则非空数组**（调用方把 host 的 `diff?:` 归一成数组：MCP 单个
 * diff 包进 `[diff]`，技能直接用 `diff`，无 diff 传 `[]`）。`diff.length === 0`
 * 即「没有差异文件」⇒ 隐藏「查看详情」入口。这样避开了 exactOptionalPropertyTypes
 * 下「向可选属性传 undefined」的类型陷阱。
 */
function ConflictItemRow({ kind, name, diff, selected, onSelect, onViewDetail }: {
  kind: 'skill' | 'mcp'
  name: string
  diff: readonly FileDiffResult[]
  selected: 'skip' | 'keep' | 'overwrite'
  onSelect: (v: 'skip' | 'keep' | 'overwrite') => void
  onViewDetail: () => void
}) {
  // 统计总变更行数（跨所有文件求和）。
  const totalChanges = diff.reduce((sum, f) => sum + f.added + f.removed, 0)
  const totalAdded = diff.reduce((s, f) => s + f.added, 0)
  const totalRemoved = diff.reduce((s, f) => s + f.removed, 0)
  // 技能=保留我改过的(skip)/覆盖；MCP=保留现有(keep)/覆盖。
  const keepLabel = kind === 'skill' ? '保留我改过的' : '保留现有'
  const keepId = kind === 'skill' ? 'skip' : 'keep'
  const hasDiff = diff.length > 0
  return (
    <div className={css.wizardConflictGroup}>
      {/* 头行：名称 + 已存在徽标 */}
      <div className={css.wizardConflictHead}>
        <span className={css.wizardConflictItemName}>{name}</span>
        <span className={css.wizardConflictChip}>已存在</span>
      </div>

      {/* 查看详情入口（有 diff 才显示） */}
      {hasDiff && (
        <button
          type="button"
          className={css.diffToggleBtn}
          onClick={onViewDetail}
        >
          <ChevronRight size={12} className={css.diffToggleArrow} />
          <span className={css.diffToggleLabel}>查看详情</span>
          <span className={css.diffToggleHint}>
            · {totalChanges} 行变更（{totalRemoved} 删 {totalAdded} 增）
          </span>
        </button>
      )}

      {/* per-item 保留/覆盖单选 */}
      <SegmentedOptions
        options={[
          { id: keepId, label: keepLabel },
          { id: 'overwrite', label: '用模块的覆盖' },
        ]}
        selected={selected}
        onSelect={(id) => onSelect(id as 'skip' | 'keep' | 'overwrite')}
      />
    </div>
  )
}

/**
 * split-view diff 详情面板（设计稿 `ysfAN` 节点：全屏模态）。
 *
 * 左右两列对照现有侧（左）与模块侧（右）。**对齐要点**：每条 `DiffHunkLine`
 * 在左右各渲染一行——`del` 行左有内容、右为占位空行；`add` 行左为占位、
 * 右有内容；`same` 行两侧都显示。占位空行用同高度（不渲染内容、只占位），
 * 保证左右两列行等高对齐。`folded` 段渲染成「··· N 行相同 ···」折叠条（跨两列）。
 *
 * Esc 关闭用 capture + stopPropagation（照 ImportModuleWizard 既有 Esc 做法，
 * 别让设置壳的 Esc 把整个设置弹窗关了）。
 */
function DiffDetailPanel({ name, kind, files, selected, onSelect, onClose }: {
  name: string
  kind: 'skill' | 'mcp'
  files: readonly FileDiffResult[]
  selected: 'skip' | 'keep' | 'overwrite'
  onSelect: (v: 'skip' | 'keep' | 'overwrite') => void
  onClose: () => void
}) {
  // 当前选中的文件 tab（技能有多文件，MCP 单个）。
  const [activeFile, setActiveFile] = useState(0)
  const file = files[Math.min(activeFile, files.length - 1)]

  // Esc 关闭（capture 阶段 + stopPropagation，照 ImportModuleWizard 既有做法）。
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

  // 底部选择：技能=skip/overwrite，MCP=keep/overwrite。
  // 两类都在面板底部显示「保留现有」（面板里不再区分「保留我改过的」措辞）。
  const keepId = kind === 'skill' ? 'skip' : 'keep'
  const keepLabel = '保留现有'

  // 统计。
  const totalFiles = files.length
  const totalAdded = files.reduce((s, f) => s + f.added, 0)
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0)

  return createPortal(
    <div className={css.diffPanelOverlay} onClick={onClose}>
      <div
        className={css.diffPanel}
        role="dialog"
        aria-label={`${name} 内容差异`}
        onClick={e => e.stopPropagation()}
      >
        {/* 标题栏：项名称 + 现有版本标签(绿) vs 模块版本标签(品牌色) + ✕ 关闭 */}
        <div className={css.diffPanelHeader}>
          <span className={css.diffPanelTitle}>{name} · 内容差异</span>
          <span className={css.diffPanelChips}>
            <span className={css.diffChipExisting}>现有（你本机）</span>
            <span className={css.diffChipVs}>vs</span>
            <span className={css.diffChipModule}>模块携带</span>
          </span>
          <button type="button" className={css.diffPanelClose} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* 工具栏：文件 tab + 统计 */}
        <div className={css.diffToolbar}>
          <div className={css.diffTabs}>
            {files.map((f, i) => (
              <button
                key={f.path}
                type="button"
                className={`${css.diffTab}${i === activeFile ? ' ' + css.diffTabActive : ''}`}
                onClick={() => setActiveFile(i)}
              >
                {f.path}
                <span className={css.diffTabCount}>{f.added + f.removed}</span>
              </button>
            ))}
          </div>
          <span className={css.diffStat}>
            共 {totalFiles} 个文件 · {totalAdded} 增 {totalRemoved} 删
          </span>
        </div>

        {/* 列头：左红底「现有（你本机）」/ 右绿底「模块携带」 */}
        <div className={css.diffColHeader}>
          <span className={css.diffColExistingHeader}>现有（你本机）</span>
          <span className={css.diffColDivider} />
          <span className={css.diffColModuleHeader}>模块携带</span>
        </div>

        {/* 主体：左右 split。逐 hunk 渲染，folded 段跨两列。 */}
        <div className={css.diffBody}>
          {file.hunks.length === 0 && (
            <p className={css.diffEmpty}>两份内容完全相同，无差异。</p>
          )}
          {file.hunks.map((hunk, hi) => (
            <DiffHunkView key={hi} hunk={hunk} />
          ))}
        </div>

        {/* 底部：看完选「保留现有」/「用模块覆盖」+ 关闭 */}
        <div className={css.diffPanelFooter}>
          <span className={css.diffPanelFooterNote}>看完差异后选择：</span>
          <div className={css.diffPanelFooterBtns}>
            <button
              type="button"
              className={`${css.diffFooterBtn}${selected === keepId ? ' ' + css.diffFooterBtnActive : ''}`}
              onClick={() => { onSelect(keepId); onClose() }}
            >{keepLabel}</button>
            <button
              type="button"
              className={`${css.diffFooterBtn}${selected === 'overwrite' ? ' ' + css.diffFooterBtnActiveBrand : ''}`}
              onClick={() => { onSelect('overwrite'); onClose() }}
            >用模块覆盖</button>
            <GlassButton onClick={onClose}>关闭</GlassButton>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * 一个 hunk 的 split 渲染。
 *
 * 对齐实现：对每条 `DiffHunkLine` 产出**一对**左右行（永远成对产出）：
 * - `same`：左=内容、右=内容（两侧都显示）。
 * - `del`：左=内容（红底）、右=占位空行（同高、灰底、无内容）。
 * - `add`：左=占位空行、右=内容（绿底）。
 * 用 CSS grid 的两列布局，每行一个 grid row，左右行天然等高（同行的两个 cell
 * 高度取较大者，空行与内容行等高）。`folded` 段渲染成一个跨两列的折叠条。
 */
function DiffHunkView({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className={css.diffHunk}>
      {hunk.folded !== undefined && (
        <div className={css.diffFolded}>
          ··· {hunk.folded.count} 行相同（{hunk.folded.startLeft}–{hunk.folded.startLeft + hunk.folded.count - 1}） ···
        </div>
      )}
      {hunk.lines.map((line, i) => (
        <DiffLineView key={i} line={line} />
      ))}
    </div>
  )
}

/**
 * 一条 diff 行的左右对照（grid 一行两 cell，等高对齐）。
 *
 * `leftNum`/`rightNum` 为 null 时该侧不显示内容（占位空行，保持高度对齐）。
 */
function DiffLineView({ line }: { line: DiffHunkLine }) {
  const leftHas = line.kind === 'same' || line.kind === 'del'
  const rightHas = line.kind === 'same' || line.kind === 'add'
  const leftBg = line.kind === 'del' ? css.diffDelBg : line.kind === 'same' ? css.diffSameBg : css.diffEmptyBg
  const rightBg = line.kind === 'add' ? css.diffAddBg : line.kind === 'same' ? css.diffSameBg : css.diffEmptyBg
  const leftSign = line.kind === 'del' ? '−' : ' '
  const rightSign = line.kind === 'add' ? '+' : ' '
  return (
    <div className={css.diffSplitRow}>
      {/* 左 cell（现有侧） */}
      <div className={`${css.diffColExisting} ${leftBg}`}>
        <span className={css.diffGutter}>{leftHas ? (line.leftNum ?? '') : ''}</span>
        <code className={`${css.diffCode} ${css.diffMono}`}>
          {leftHas ? `${leftSign} ${line.content}` : ''}
        </code>
      </div>
      {/* 右 cell（模块侧） */}
      <div className={`${css.diffColModule} ${rightBg}`}>
        <span className={css.diffGutter}>{rightHas ? (line.rightNum ?? '') : ''}</span>
        <code className={`${css.diffCode} ${css.diffMono}`}>
          {rightHas ? `${rightSign} ${line.content}` : ''}
        </code>
      </div>
    </div>
  )
}

/** 冲突组容器（设计稿 P5：标题 + 右上标注 + 选项）——同名预设组仍用它。 */
function ConflictGroup({ label, items, warn, children }: {
  label: string
  items: string[]
  warn?: boolean
  children: ReactNode
}) {
  return (
    <div className={`${css.wizardConflictGroup}${warn ? ' ' + css.wizardConflictWarn : ''}`}>
      <div className={css.wizardConflictHead}>
        <span className={css.wizardConflictLabel}>{label}</span>
        <span className={css.wizardConflictItems}>{items.join(', ')}</span>
      </div>
      {children}
    </div>
  )
}

/** 分段单选（设计稿 P5：选中=描边白底胶囊，未选中=无框灰字）。 */
function SegmentedOptions({ options, selected, onSelect }: {
  options: { id: string; label: string; desc?: string }[]
  selected: string
  onSelect: (id: string) => void
}) {
  return (
    <div className={css.wizardSegmented}>
      {options.map(opt => (
        <div key={opt.id} className={css.wizardSegmentRow}>
          <button
            type="button"
            className={`${css.wizardSegmentBtn}${selected === opt.id ? ' ' + css.wizardSegmentActive : ''}`}
            onClick={() => onSelect(opt.id)}
          >
            {opt.label}
          </button>
          {opt.desc !== undefined && selected === opt.id && (
            <span className={css.wizardSegmentDesc}>{opt.desc}</span>
          )}
        </div>
      ))}
    </div>
  )
}

/* ── 第 ⑤ 步：完成（设计稿 P6）────────────────────────────────────────── */

function StepDone({ result, inspection }: {
  result: InstallModuleResult
  inspection: ModuleInspection
}) {
  return (
    <div className={css.wizardStepBody}>
      {/* 中央结果区（设计稿 P6：大对勾 + 标题 + 副行） */}
      <div className={css.wizardDoneCenter}>
        <span className={css.wizardDoneCheck}><Check size={40} /></span>
        <span className={css.wizardDoneTitle}>导入完成</span>
        <span className={css.wizardDoneSub}>「{inspection.manifest.name}」已加入你的 Agent 预设</span>
        <span className={css.wizardDoneSub2}>
          {result.installedSkills.length} 个技能已安装 · {result.mcpKept.length + result.mcpApplied.length} 个 MCP 待处理
        </span>
      </div>

      {/* 结果列表（设计稿 P6：每行状态图标 + 条目 + 右端状态词） */}
      <div className={css.wizardDoneList}>
        <DoneRow icon="ok" label={`Agent 预设 · ${inspection.manifest.name}`} status="已安装" statusClass="ok" />
        {result.installedSkills.length > 0 && (
          <DoneRow icon="ok" label={`技能 · ${result.installedSkills[0]} 等 ${result.installedSkills.length} 个`} status="已安装" statusClass="ok" />
        )}
        {result.skippedSkills.length > 0 && (
          <DoneRow icon="skip" label={`技能 · ${result.skippedSkills.join(', ')}`} status="已跳过" statusClass="skip" />
        )}
        {result.mcpApplied.length > 0 && (
          <DoneRow icon="ok" label={`MCP · ${result.mcpApplied.join(', ')}`} status="已就绪" statusClass="ok" />
        )}
        {result.mcpKept.length > 0 && (
          <DoneRow icon="warn" label={`MCP · ${result.mcpKept.join(', ')}（保留现有）`} status="待处理" statusClass="warn" />
        )}
      </div>

      {/* 提示行（设计稿 P6：灯泡图标） */}
      <div className={css.wizardTipRow}>
        <Info size={13} className={css.wizardTipIcon} />
        <span className={css.wizardTipText}>
          装好依赖后，到「MCP 与集成」点「测试连接」即可复验，无需重新导入。
        </span>
      </div>

      {/* 安装 warnings（如实显示——契约 §2.1） */}
      {result.warnings.length > 0 && (
        <div className={css.wizardWarnings}>
          {result.warnings.map((w, i) => (
            <p key={i} className={css.wizardWarningLine}>⚠ {w}</p>
          ))}
        </div>
      )}
    </div>
  )
}

/** 完成步的一行（设计稿 P6：状态图标 + 条目 + 右端状态词）。 */
function DoneRow({ icon, label, status, statusClass }: {
  icon: 'ok' | 'skip' | 'warn'
  label: string
  status: string
  statusClass: 'ok' | 'skip' | 'warn'
}) {
  return (
    <div className={css.wizardDoneRow}>
      <span className={css.wizardDoneIcon}>
        {icon === 'ok' && <Check size={13} className={css.wizardDepStatusOk} />}
        {icon === 'skip' && <Minus size={13} className={css.wizardDoneIconSkip} />}
        {icon === 'warn' && <TriangleAlert size={13} className={css.wizardDepStatusWarn} />}
      </span>
      <span className={css.wizardDoneLabel}>{label}</span>
      <span className={`${css.wizardDoneStatus} ${css[`wizardDoneStatus_${statusClass}`]}`}>{status}</span>
    </div>
  )
}

/* ── 工具函数 ────────────────────────────────────────────────────────── */

/** 统计字符数（设计稿 P3：「职责提示词 N 字」）。 */
function countChars(s: string): number {
  // 按 Unicode 码点计数（中文一字一码点，与设计稿「214 字」口径一致）。
  return [...s].length
}
