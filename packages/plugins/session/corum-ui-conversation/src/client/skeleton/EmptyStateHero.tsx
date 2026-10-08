/**
 * EmptyStateHero —— 会话区空态（2026-08-30 重设计定稿，设计稿 DjFev 重排版式）。
 *
 * 版式（更品牌 · 保留大 logo）：大 logo + 「新建任务」**大按钮**（ic 44×44 左 +
 * 标题/副标题右，宽 360、高 97）+ 「最近」列（任务泳道按时间倒序，icon + 标题 +
 * kind + 时间，宽 420）。每次启动显示空态，用户再打开想要的任务。
 *
 * 数据流：动作经 ConversationInjected.emptyActions（apply.ts 注入，RPC/目录
 * 选择器/sessions.open 通路）。最近任务泳道经 recentTasks prop（AppFrame/
 * ConversationRoot 投影 sessions.list corum-task-*）。大 logo 深/浅主题各一张
 * （big_brand_dark/light，拷入 desktop assets，corumapp:// 协议可达）。
 *
 * 项目模式剥离（2026-09-26）：原「新建项目」卡与「最近项目」卡列表（数据源
 * emptyActions.listProjects → corumProject RPC）已随项目模式迁到闭源仓
 * Corum-Harness-Project 的 `@corum/corum-ide-project-ui`（那里提供项目模式的
 * 空态入口）。开源侧空态只留任务模式。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Clock, Folder, Lock, MessageSquarePlus, ShieldAlert, X } from 'lucide-react'
import { basenameOf } from '@corum/corum-ui-base/client'
import type { AgentOption, ConversationInjected, ModelProviderGroup, NewTaskOptions, PermissionOption, WorkspaceOption } from '../contract/slots.ts'
import { AgentTwoLevelSelect } from './AgentTwoLevelSelect.tsx'
import { ModelSelectWithEffort, type ModelRouteSelection } from './ModelSelectWithEffort.tsx'
import css from './EmptyStateHero.module.css'

/** 路径末段（用于「选择新目录」按钮上显示已选目录名）。同时认 `/` 与 `\`
 *  （P2 收口，原只认 `/`）；实现见 ui-base platform-paths。 */
const basename = basenameOf

/** 三个权限档位的图标（按 preset id 映射；未知档位回落到 Lock）。
 *  完全访问用 ShieldAlert（盾牌内叹号 = 放开限制的风险提示）——用户走查选的
 *  语义，比 ShieldOff（禁用盾）更贴合「不受限制」而非「无保护」。 */
const PERMISSION_ICONS: Record<string, React.ReactNode> = {
  'read-only': <Lock size={16} />,
  'workspace-write': <Folder size={16} />,
  'danger-full-access': <ShieldAlert size={16} />,
}

/** 一个横排大按钮（设计稿 card-*：360×97、ic 44×44 r12 左 + 标题 20/600 +
 *  副标题 15 secondary 右，横排 ic 左 tx 右）。两卡 ic 统一 $brand-primary
 *  实底 + on-brand 白 icon 同尺寸（2026-08-30 用户走查：图标大小/颜色要一致）。 */
function NewCard({ icon, title, desc, onClick }: {
  icon: React.ReactNode
  title: string
  desc: string
  onClick: () => void
}) {
  return (
    <button type="button" className={css.card} onClick={onClick}>
      <span className={css.ic}>{icon}</span>
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

/** 最近一条（任务泳道；项目模式剥离后只剩 task 一种）。 */
interface RecentItem {
  kind: 'task'
  id: string
  title: string
  updatedAt: number
}

/**
 * 新建任务表单（设计稿 btAJh，2026-08-30）：空态内嵌、不跳页。
 *
 * 三字段：Agent 下拉（listAgents）+ 工作目录（pickDirectory，必填无默认）+
 * 访问权限三档（listPermissions，官方 preset 表投影）。提交走
 * emptyActions.newTask(options) → createTaskAgent(cwd, profileId, permission)。
 *
 * 受控输入注意（PROGRESS §4 同类坑）：选项列表在挂载后异步拉取，缺省值在
 * **列表到达的边沿**初始化一次，不依赖列表引用——否则 store 更新换引用会在
 * 用户选择中途重置选择。
 */
function NewTaskForm({ emptyActions, onClose }: {
  emptyActions: ConversationInjected['emptyActions']
  onClose: () => void
}) {
  const [agents, setAgents] = useState<readonly AgentOption[]>([])
  const [permissions, setPermissions] = useState<readonly PermissionOption[]>([])
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceOption[]>([])
  const [modelGroups, setModelGroups] = useState<readonly ModelProviderGroup[]>([])
  const [profileId, setProfileId] = useState('')
  const [permission, setPermission] = useState('')
  const [cwd, setCwd] = useState('')
  const [submitting, setSubmitting] = useState(false)
  /** 模型选择当前值（provider/model/reasoningEffort）；null = 跟随 Agent 默认。 */
  const [modelSel, setModelSel] = useState<ModelRouteSelection | null>(null)
  /** 模型是否被用户手动改过——没改时选定 Agent 自动跟随其默认模型（含默认档）。 */
  const modelTouched = useRef(false)
  /** 工作区自绘下拉展开态 + 容器 ref（点击外部收起）。 */
  const [wsOpen, setWsOpen] = useState(false)
  const wsSelectRef = useRef<HTMLDivElement>(null)

  // 点击下拉外部收起面板。
  useEffect(() => {
    if (!wsOpen) return
    const onDown = (e: MouseEvent): void => {
      if (wsSelectRef.current !== null && !wsSelectRef.current.contains(e.target as Node)) setWsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [wsOpen])

  useEffect(() => {
    let alive = true
    // Agent 列表与默认预设并行拉取（同源 listProfiles RPC）：默认选中
    // agent-presets.default 指定的预设（在列表里找到才用；找不到或为空回落第一项）。
    Promise.all([
      emptyActions.listAgents(),
      emptyActions.defaultAgentPreset().catch(() => undefined),
    ])
      .then(([list, defaultId]) => {
        if (!alive) return
        // 官方基础模式不可作为新建任务入口（设置页定调：官方模式是继承模板，不可直接选中）。
        // 过滤只影响选项列表，不影响 defaultAgentPreset 的默认选中逻辑：若配置的默认预设
        // 被滤掉（官方 id），下方 list.some 判定自然落空 ⇒ 回落第一项，不写特例。
        const filtered = list.filter(a => a.source !== 'official')
        setAgents(filtered)
        setProfileId((cur) => {
          if (cur !== '') return cur
          if (defaultId !== undefined && filtered.some(a => a.id === defaultId)) return defaultId
          return filtered[0]?.id ?? ''
        })
      })
      .catch(() => { /* Agent 列表拉取失败：留空，提交时 host 用内置 task profile */ })
    emptyActions.listModelCatalog()
      .then((list) => { if (alive) setModelGroups(list) })
      .catch(() => { /* 模型目录拉取失败：留空，提交时跟随 Agent 默认 */ })
    emptyActions.listWorkspaces()
      .then((list) => { if (!alive) return; setWorkspaces(list); setCwd((cur) => cur === '' ? (list[0]?.path ?? '') : cur) })
      .catch(() => { /* 工作区列表拉取失败：留空，用户可用「选择新目录」 */ })
    emptyActions.listPermissions()
      .then((select) => {
        if (!alive) return
        setPermissions(select.presets)
        // 默认档位 = 官方 defaultPreset（组合默认 workspace-write），不是表里的
        // 第一项——表顺序是声明序，首项恰是 read-only，直接取首项会默认到最严档。
        const fallback = select.presets.find((p) => p.id === select.defaultPreset)?.id
          ?? select.presets[0]?.id ?? ''
        setPermission((cur) => cur === '' ? fallback : cur)
      })
      .catch(() => { /* 权限档位拉取失败：留空，提交时沿用全局默认 */ })
    return () => { alive = false }
  }, [emptyActions])

  /** 当前选中 Agent 的默认模型（选定 Agent 后模型选择默认跟随它，含默认档）。 */
  const agentDefault = useMemo(
    () => agents.find((a) => a.id === profileId)?.defaultModel,
    [agents, profileId],
  )
  /** 模型选择实际选中值：用户没手动改时跟随 Agent 默认（含其 reasoningEffort）；
   *  改过后保持用户选择（含用户选的推理档）。 */
  const effectiveModelSel: ModelRouteSelection | null = modelTouched.current
    ? modelSel
    : (agentDefault === undefined
      ? null
      : {
        provider: agentDefault.provider,
        model: agentDefault.model,
        ...(agentDefault.reasoningEffort === undefined ? {} : { reasoningEffort: agentDefault.reasoningEffort }),
      })

  const submit = (): void => {
    if (cwd === '' || submitting) return
    setSubmitting(true)
    // 模型解析：null（跟随 Agent 默认）时让 host 用 Agent 默认；有值则带
    // provider/model/reasoningEffort（含 Agent 默认档或用户选档），保证所选即所得。
    const model: NewTaskOptions['model'] = effectiveModelSel === null
      ? undefined
      : {
        provider: effectiveModelSel.provider,
        model: effectiveModelSel.model,
        ...(effectiveModelSel.reasoningEffort === undefined ? {} : { reasoningEffort: effectiveModelSel.reasoningEffort }),
      }
    const options: NewTaskOptions = {
      cwd,
      ...(profileId === '' ? {} : { profileId }),
      ...(permission === '' ? {} : { permission }),
      ...(model === undefined ? {} : { model }),
    }
    emptyActions.newTask(options)
      .then(() => {
        // 泳道建好并 open 后，会话仍是 **blank（未发过消息）**——官方 hero 条件
        // 包含「blank 且已 open」，所以空态（含本表单）**仍然挂载**。若不主动
        // 关闭，表单就定格在「创建中…」（用户实测反馈）。
        // 语义上此时任务已就绪：侧栏出现工作区父节点 + 新会话，用户在 composer
        // 里发第一条消息才真正留存（官方 blank → turn/start 翻转）。
        onClose()
      })
      .catch((e) => { console.error('[empty-hero] newTask failed', e); setSubmitting(false) })
  }

  const selectedWs = workspaces.find((w) => w.path === cwd)

  return (
    <form
      className={css.form}
      onSubmit={(e) => { e.preventDefault(); submit() }}
    >
      <div className={css.formHeader}>
        <span className={css.formTitle}>新建任务</span>
        <button type="button" className={css.iconBtn} onClick={onClose} aria-label="取消新建任务">
          <X size={14} />
        </button>
      </div>

      <div className={css.field}>
        <span className={css.label}>工作区</span>
        {/* 设计稿 1:1：工作区自绘下拉——trigger（folder icon + 名称/路径 + chevron）
            + 展开面板（顶部「选择新目录」，下方带选中态的已有工作区列表）。 */}
        <div className={css.wsSelect} ref={wsSelectRef}>
          <button
            type="button"
            className={css.wsTrigger}
            aria-haspopup="menu"
            aria-expanded={wsOpen}
            onClick={() => setWsOpen(o => !o)}
          >
            <Folder size={16} className={css.wsTriggerIcon} />
            <span className={css.wsTriggerTx}>
              <span className={css.wsTriggerName}>
                {selectedWs?.title ?? (cwd !== '' ? basename(cwd) : '选择工作区')}
              </span>
              {(selectedWs ?? (cwd !== '' ? { path: cwd } : undefined)) !== undefined && (
                <span className={css.wsTriggerPath}>{selectedWs?.path ?? cwd}</span>
              )}
            </span>
            <ChevronDown size={18} className={css.wsTriggerChevron} />
          </button>
          {wsOpen && (
            <div className={css.wsPanel} role="menu">
              {/* 2026-10-07 用户要求：新建任务表单里不再提供「选择新目录」。
                  注册工作区改由**侧栏「添加工作区」**承担（SessionsPane 的操作组），
                  表单只负责从已注册工作区里挑一个，避免同一动作两处入口。
                  pick() 仍保留：侧栏注册新工作区后本表单会经工作区列表刷新看到它。 */}
              {workspaces.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className={css.wsOpt}
                  data-active={w.path === cwd}
                  onClick={() => { setCwd(w.path); setWsOpen(false) }}
                >
                  <Folder size={16} />
                  <span className={css.wsOptTx}>
                    <span className={css.wsOptName}>{w.title}</span>
                    <span className={css.wsOptPath}>{w.path}</span>
                  </span>
                  {w.path === cwd && <Check size={16} className={css.wsOptCheck} />}
                </button>
              ))}
              {/* 当前选了「不在列表里」的新目录时，追加一项让它可见。 */}
              {cwd !== '' && selectedWs === undefined && (
                <button type="button" className={css.wsOpt} data-active onClick={() => setWsOpen(false)}>
                  <Folder size={16} />
                  <span className={css.wsOptTx}>
                    <span className={css.wsOptName}>{basename(cwd)}</span>
                    <span className={css.wsOptPath}>{cwd}</span>
                  </span>
                  <Check size={16} className={css.wsOptCheck} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={css.field}>
        <span className={css.label} id="new-task-agent-label">Agent</span>
        {/* 二级分组选择器（2026-09-07 用户定调：预置 25 角色后列表过长，收敛为
            通用 / Corum 内置 / 用户 三组 + 组内展开）。切换 Agent 时模型未手动
            改过则跟随其默认（modelTouched 复位）。 */}
        {agents.length === 0
          ? <span className={css.permEmpty}>加载中…</span>
          : (
            <AgentTwoLevelSelect
              agents={agents}
              value={profileId}
              onChange={(id) => { setProfileId(id); modelTouched.current = false }}
              ariaLabel="选择执行 Agent"
              css={{
                root: css.agentSelRoot,
                trigger: css.agentSelTrigger,
                triggerName: css.agentSelTriggerName,
                chevron: css.agentSelChevron,
                panel: css.agentSelPanel,
                searchRow: css.agentSelSearchRow,
                searchIcon: css.agentSelSearchIcon,
                searchInput: css.agentSelSearchInput,
                searchClear: css.agentSelSearchClear,
                groupHead: css.agentSelGroupHead,
                groupLabel: css.agentSelGroupLabel,
                groupCount: css.agentSelGroupCount,
                list: css.agentSelList,
                item: css.agentSelItem,
                itemCheck: css.agentSelItemCheck,
                itemHint: css.agentSelItemHint,
                empty: css.agentSelEmpty,
              }}
            />
          )}
      </div>

      <div className={css.field}>
        <span className={css.label} id="new-task-model-label">模型</span>
        {/* 模型 + 推理等级两级选择器（2026-09-07 用户定调：所有模型都支持推理
            等级，选择模型的交互与 composer 统一）。trigger 显示「模型名 · 档位
            名」，面板 root 层下钻模型列表（按 provider 分组）与推理等级（仅当前
            模型有 reasoning 时）；无 reasoning 的模型不显示档位入口。 */}
        {modelGroups.length === 0
          ? <span className={css.permEmpty}>加载中…</span>
          : (
            <ModelSelectWithEffort
              groups={modelGroups}
              value={effectiveModelSel}
              onChange={(sel) => { modelTouched.current = true; setModelSel(sel) }}
              ariaLabel="选择模型与推理等级"
              css={{
                root: css.modelSelRoot,
                trigger: css.modelSelTrigger,
                triggerName: css.modelSelTriggerName,
                triggerEffort: css.modelSelTriggerEffort,
                chevron: css.modelSelChevron,
                panel: css.modelSelPanel,
                cell: css.modelSelCell,
                cellLabel: css.modelSelCellLabel,
                cellValue: css.modelSelCellValue,
                cellChevron: css.modelSelCellChevron,
                backRow: css.modelSelBackRow,
                groupTitle: css.modelSelGroupTitle,
                list: css.modelSelList,
                item: css.modelSelItem,
                itemName: css.modelSelItemName,
                itemCheck: css.modelSelItemCheck,
              }}
            />
          )}
        {!modelTouched.current && agentDefault !== undefined && (
          <span className={css.fieldHint}>已按 Agent 默认模型自动选择</span>
        )}
      </div>

      <div className={css.field}>
        <span className={css.label}>访问权限</span>
        <div className={css.permGroup}>
          {permissions.length === 0 && <span className={css.permEmpty}>加载中…</span>}
          {permissions.map((p) => (
            <button
              key={p.id}
              type="button"
              className={css.permOpt}
              data-active={p.id === permission}
              aria-pressed={p.id === permission}
              onClick={() => setPermission(p.id)}
            >
              <span className={css.radio}>{p.id === permission && <span className={css.radioDot} />}</span>
              <span className={css.permIcon}>{PERMISSION_ICONS[p.id] ?? <Lock size={16} />}</span>
              <span className={css.permTx}>
                <span className={css.permName}>{p.name}</span>
                {p.description !== undefined && <span className={css.permDesc}>{p.description}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className={css.formFooter}>
        <button type="button" className={css.ghostBtn} onClick={onClose} disabled={submitting}>取消</button>
        <button type="submit" className={css.primaryBtn} disabled={cwd === '' || submitting}>
          {submitting ? '创建中…' : '开始'}
        </button>
      </div>
    </form>
  )
}

/**
 * 会话区空态。props：emptyActions（apply 注入的 RPC 通路）+ recentTasks
 * （最近任务泳道投影）+ dark（主题选大 logo 图）。
 */
export function EmptyStateHero({ emptyActions, newTaskForm, recentTasks, dark }: {
  emptyActions: ConversationInjected['emptyActions']
  newTaskForm: ConversationInjected['newTaskForm']
  recentTasks: readonly { id: string; title: string; updatedAt: number }[]
  dark: boolean
}) {
  const [formOpen, setFormOpen] = useState(false)

  // 侧栏顶部「新会话」按钮（corum-ide-sidebar-ui openNewTaskForm →
  // ctx.layout.openNewTaskForm）：回空态后打开新建任务表单——与点「新建任务」
  // 卡同一表单。两条通路：① 已在空态时的订阅直推（onOpen）；② 从会话视图
  // 切回空态时本组件刚挂载、信号已落空 → 挂载时认领 pending 标记。
  useEffect(() => {
    if (newTaskForm.consumePending()) setFormOpen(true)
    return newTaskForm.onOpen(() => { setFormOpen(true) })
  }, [newTaskForm])

  // 最近一列：只剩任务泳道，按 updatedAt 倒序取前 6。
  const recents: RecentItem[] = recentTasks
    .map((t) => ({ kind: 'task' as const, id: t.id, title: t.title, updatedAt: t.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6)

  const openRecent = (r: RecentItem): void => {
    void emptyActions.openTask(r.id).catch((e) => console.error('[empty-hero] openRecent failed', e))
  }

  // 表单态：点「新建任务」后两卡原位展开表单（设计稿 btAJh，不跳页）。
  if (formOpen) {
    return (
      <div className={css.emptyHero}>
        <NewTaskForm emptyActions={emptyActions} onClose={() => setFormOpen(false)} />
      </div>
    )
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

      {/* 新建卡（设计稿：横排大按钮，ic 左 + 标题/副标题右）。
          项目模式剥离后只剩「新建任务」一枚（项目模式入口在闭源 UI 插件里）。 */}
      <div className={css.actions}>
        <NewCard
          icon={<MessageSquarePlus size={20} />}
          title="新建任务"
          desc="单任务泳道 · 快速开始"
          onClick={() => setFormOpen(true)}
        />
      </div>

      {/* 最近一列（任务泳道按时间倒序）：icon + 标题 + kind + 时间。 */}
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
                  <Folder size={18} />
                </span>
                <span className={css.recentTitle}>{r.title}</span>
                <span className={css.recentKind}>任务</span>
                <span className={css.recentTime}>{relTime(r.updatedAt)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
