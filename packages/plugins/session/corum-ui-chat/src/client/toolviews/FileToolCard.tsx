/**
 * fork（corum）：文件工具卡 —— read / edit / write 三类调用共用的毛玻璃卡（2026-09-14）。
 *
 * 设计源（唯一权威）：`doc/UXDesign/design.pen` §1.1 `row-文件工具卡` 的六个
 * reusable 组件 + 设计报告 `docs/analysis/file-tool-card-design-2026-09-14.md`
 * §2（统一壳 + 卡内四段）与 §2.1（六态逐条落点）。
 *
 * 注册面：keyed slot `tool.call.toolview`（key = 'read' / 'edit' / 'write'，
 * priority -1 遮蔽官方行，见 apply.ts）。keyed 命中 = **整行替换**官方行
 * （官方 renderSlot 契约），所以本组件必须自己覆盖三个工具的全部子态。
 *
 * 组件纪律：**卡片本体是纯组件**（不感知 cordis / 服务）；`openLineAt` 由注册壳
 * （FileToolView）经 chatRuntime 桥注入，与 SubagentCard 的 chatRuntimeRef 同款。
 *
 * 复用官方公开积木（不复制官方整行实现）：ReadBlock / DiffBlock / diffTotals /
 * StateDot / Pill / Tooltip。
 *
 * 数据来源一律走 file-tool-card.ts 的窄化解析（本文件不散落正则）。
 */
import { memo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, FilePen, FilePlus, FileText, FileX, Scissors, ShieldAlert, type LucideIcon } from 'lucide-react'
import {
  DiffBlock, Pill, ReadBlock, StateDot, Tooltip, diffTotals,
  type DiffBlockLabels, type DiffHunk, type ReadBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../locale.ts'
import { parseEditNotFound } from './edit-not-found.ts'
import {
  classifyFailure, DEFAULT_FILE_CARD_READ_LINES, filePathFromArgs,
  intendedEditHunk, intendedWriteHunk, nonEmptyDiffs, readCallArgs, readMeta, readRange,
  resultText, shortenPath, writeCallArgs, writeOutcome,
  type FileCardCause,
} from './file-tool-card.ts'
import css from './FileToolCard.module.css'

/** 框架按注册 locale 注入的 t（key 集 = 'chat' namespace 的 ChatKey 联合）。 */
type TFunc = PropsLocale<'chat'>['t']

/** 注册壳（FileToolView）额外注入的 props。 */
export interface FileToolCardExtraProps {
  /** 行号点击 → corumEditor.openFile + revealLine 跳转（壳经 chatRuntime 桥注入）。 */
  openLineAt?: (path: string | undefined, line: number) => void
}

/** 卡的视觉状态档（与官方 toolRowModel 的 state 同口径）。 */
type CardState = 'running' | 'ok' | 'error' | 'stopped'

/** chip 色档（design.pen 的 state/cause/sim 共用同一套状态变量）。 */
type Tone = 'success' | 'error' | 'warn' | 'idle'

/** 状态 chip 的档位 → 文案 / 色 / 圆点。 */
function stateChipOf(state: CardState, t: TFunc): { label: string; tone: Tone; dot: 'done' | 'warning' | 'ongoing' | 'error' } {
  switch (state) {
    case 'running': return { label: t('fileCard.state.running'), tone: 'idle', dot: 'ongoing' }
    case 'stopped': return { label: t('fileCard.state.stopped'), tone: 'warn', dot: 'warning' }
    case 'error': return { label: t('fileCard.state.failed'), tone: 'error', dot: 'error' }
    case 'ok': return { label: t('fileCard.state.success'), tone: 'success', dot: 'done' }
  }
}

/** 失败原因分档 → i18n 键（取舍点 D：非路径类错误同一张失败卡，只换标签）。 */
function causeKindKey(kind: FileCardCause['kind']): Parameters<TFunc>[0] {
  switch (kind) {
    case 'not-found': return 'fileCard.cause.notFound'
    case 'no-permission': return 'fileCard.cause.noPermission'
    case 'is-directory': return 'fileCard.cause.isDirectory'
    case 'encoding': return 'fileCard.cause.encoding'
    case 'sandbox': return 'fileCard.cause.sandbox'
    case 'unknown': return 'fileCard.cause.unknown'
  }
}

/* ── chip 族（design.pen 的 path/range/state/mode/stats/flag/cause/sim 同底）── */

/** 通用 chip：官方 `Pill` + 本卡的壳样式（$glass-2 + 描边 + r8 + pad [3,8]）。 */
function Chip({ tone, className, children, title }: { tone?: Tone; className?: string; children: ReactNode; title?: string }) {
  return (
    <Pill className={[css.chip, className].filter(Boolean).join(' ')} {...tone === undefined ? {} : { 'data-tone': tone }} {...title === undefined ? {} : { title }}>
      {children}
    </Pill>
  )
}

/**
 * 状态 chip：6px 圆点 + 11px 文案（design.pen 的 `state`）。
 * 两个入口——按 CardState 取文案（读语言包），或直接给定文案（未命中档的「未命中」）。
 */
function StateChip(props: { t: TFunc; state: CardState } | { t: TFunc; label: string; tone: Tone; dot: 'done' | 'warning' | 'ongoing' | 'error' }) {
  const resolved = 'state' in props ? stateChipOf(props.state, props.t) : { label: props.label, tone: props.tone, dot: props.dot }
  return (
    <Chip tone={resolved.tone}>
      <StateDot state={resolved.dot} size={6} />
      <span className={css.chipLabel}>{resolved.label}</span>
    </Chip>
  )
}

/* ── 输入窄化：三工具同口径，避免各卡重复解析 ─────────────────────── */

interface CardInput {
  readonly settled: boolean
  readonly argsRaw: string
  readonly state: CardState
  readonly errorText: string | undefined
  readonly errorCode: string | undefined
  readonly filePath: string | undefined
  readonly displayPath: string | undefined
  readonly meta: unknown
  readonly openFile: (path: string) => void
  readonly openLineAt: ((path: string | undefined, line: number) => void) | undefined
}

/** 从 toolview props 窄化出三工具共用的输入（running/settled 联合按 `kind` 判别）。 */
function cardInput(props: ToolCallViewProps & FileToolCardExtraProps): CardInput {
  const { block, cwd, openFile } = props
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : ('argsRaw' in block ? block.argsRaw : '')) ?? ''
  const state: CardState = !settled
    ? 'running'
    : block.error?.code === 'interrupted' ? 'stopped' : block.isError ? 'error' : 'ok'
  const filePath = filePathFromArgs(argsRaw)
  return {
    settled,
    argsRaw,
    state,
    errorText: settled ? resultText(props) : undefined,
    errorCode: settled ? block.error?.code : undefined,
    filePath,
    displayPath: filePath === undefined ? undefined : shortenPath(filePath, cwd),
    meta: settled ? block.meta : undefined,
    openFile,
    openLineAt: props.openLineAt,
  }
}

/** 打开文件的回调（仅成功态可点：官方同样在失败态抑制文件链接）。 */
function openHandler(input: CardInput): (() => void) | undefined {
  if (input.state !== 'ok' || input.filePath === undefined) return undefined
  const path = input.filePath
  return () => { input.openFile(path) }
}

/**
 * **失败态**路径 chip 的点击目标：打开源文件并定位（编辑器页），**不是** diff 比较页。
 *
 * 设计/裁定依据（2026-09-15 用户验收 #6）：「失败时点击链接应该进入**编辑页面**而不是
 * diff 比较页面」——失败卡没有落盘改动可对比，唯一有意义的动作是回到源文件看现场。
 * 走既有 `openLineAt` 桥（→ corumEditor.openFile + revealLine），与「编辑未命中」卡的
 * 行号跳转同一条路径；路径 chip 没有行号语义，统一定位到第 1 行。
 */
function openFailureHandler(input: CardInput): (() => void) | undefined {
  if (input.filePath === undefined || input.openLineAt === undefined) return undefined
  const path = input.filePath
  const openLineAt = input.openLineAt
  return () => { openLineAt(path, 1) }
}

/* ── 统一壳：head / content / note（缺段即删不留空）───────────────── */

/** 24×24 图标盒（design.pen 的 `iconbox`：$glass-2 + $glass-border + r7）。 */
function IconBox({ icon: Icon, tone }: { icon: LucideIcon; tone: 'brand' | 'error' | 'success' }) {
  return (
    <span className={css.iconBox} data-tone={tone}>
      <Icon size={14} strokeWidth={2} />
    </span>
  )
}

/**
 * 路径 chip（design.pen 的 `path`）。`onOpen` 存在时可点（行为等价清单：
 * 点击路径打开文件）；实机 monorepo 路径长 → 保尾部省略（取舍点 G）。
 */
function PathChip({ path, title, onOpen }: { path: string; title: string; onOpen?: (() => void) | undefined }) {
  const body = <span className={css.chipPathText}>{path}</span>
  if (onOpen === undefined) {
    return <Chip className={css.chipPath} title={title}>{body}</Chip>
  }
  return (
    <Tooltip label={title}>
      <button type="button" className={`${css.chip} ${css.chipPath} ${css.chipButton}`} onClick={onOpen}>
        {body}
      </button>
    </Tooltip>
  )
}

/** 行尾展开 / 折叠控件（design.pen 的 `act-expand` 24×24；aria-expanded 必须正确）。 */
function ExpandAction({ open, onToggle, t }: { open: boolean; onToggle: () => void; t: TFunc }) {
  const label = open ? t('fileCard.diff.collapseAria') : t('fileCard.diff.expandAriaAll')
  return (
    <Tooltip label={label}>
      <button type="button" className={css.action} aria-expanded={open} aria-label={label} onClick={onToggle}>
        {open ? <ChevronUp size={14} strokeWidth={2} /> : <ChevronDown size={14} strokeWidth={2} />}
      </button>
    </Tooltip>
  )
}

/** 统一壳（六态完全一致，只有内容与状态色不同）。 */
function Shell({ icon, tone, title, path, pathTitle, onOpenPath, chips, stateChip, trailingChip, action, content, note }: {
  icon: LucideIcon
  tone: 'brand' | 'error' | 'success'
  title: string
  path: string | undefined
  pathTitle: string
  onOpenPath?: (() => void) | undefined
  chips?: ReactNode
  /** 状态 chip：edit-ok / write-ok 按设计不渲染（缺段即删不留空）。 */
  stateChip?: ReactNode
  /** 状态 chip **之后**的附赠 chip（design.pen 的 edit-miss：state → flag 这个顺序）。 */
  trailingChip?: ReactNode
  action?: ReactNode
  content?: ReactNode
  note?: ReactNode
}) {
  return (
    <div className={css.card} data-file-card="">
      <div className={css.head}>
        <IconBox icon={icon} tone={tone} />
        <span className={css.title}>{title}</span>
        {path !== undefined && path !== '' && (
          <PathChip path={path} title={pathTitle} {...onOpenPath === undefined ? {} : { onOpen: onOpenPath }} />
        )}
        {/* 弹性空白：吃满剩余宽度，把右侧这一组整体推到卡片右端（右侧成组对齐，
            见 FileToolCard.module.css 的 .spacer 文档）。位置**必须**紧接路径之后 ——
            放在最前会把 chip 推到右边但让路径跟着飘，放在中间才是「左锚定 + 右成组」。 */}
        <span className={css.spacer} />
        {chips}
        {stateChip}
        {trailingChip}
        {action}
      </div>
      {content !== undefined && content}
      {note !== undefined && note}
    </div>
  )
}

/** 第三段 note（截断提示 / 失败脚注）。 */
function Note({ icon: Icon, text, tone }: { icon?: LucideIcon; text: string; tone: 'warn' | 'muted' }) {
  return (
    <div className={css.note} data-tone={tone}>
      {Icon !== undefined && <span className={css.noteIcon}><Icon size={12} strokeWidth={2} /></span>}
      <span>{text}</span>
    </div>
  )
}

/* ── 子态 1 / 2：read 成功、read 失败 ──────────────────────────────── */

/** ReadBlock 的本地化 chrome（labels 契约见 primitives ReadBlock.d.ts）。 */
function readLabels(t: TFunc): ReadBlockLabels {
  return {
    codeLabel: t('fileCard.codeLabel'),
    wrapLabel: t('fileCard.wrapLabel'),
    unwrapLabel: t('fileCard.unwrapLabel'),
    window: (shown, total) => t('fileCard.read.window', { shown, total }),
    copy: t('fileCard.copy'),
    copied: t('fileCard.copied'),
    collapseAria: t('fileCard.diff.collapseAria'),
    expandAria: (hidden) => t('fileCard.diff.expandAria', { hidden }),
    collapse: t('fileCard.collapse'),
    expand: (hidden) => t('fileCard.diff.expand', { hidden }),
  }
}

/** DiffBlock 的本地化 chrome。 */
function diffLabels(t: TFunc): DiffBlockLabels {
  return {
    codeLabel: t('fileCard.codeLabel'),
    wrapLabel: t('fileCard.wrapLabel'),
    unwrapLabel: t('fileCard.unwrapLabel'),
    copy: t('fileCard.copy'),
    copied: t('fileCard.copied'),
    collapseAria: t('fileCard.diff.collapseAria'),
    expandAria: (hidden) => t('fileCard.diff.expandAria', { hidden }),
    collapse: t('fileCard.collapse'),
    expand: (hidden) => t('fileCard.diff.expand', { hidden }),
  }
}

/** read 卡：成功档 = 行号 + 内容块 + 截断提示；失败档 = 原因面板。 */
function ReadCard({ input, t }: { input: CardInput; t: TFunc }) {
  const meta = input.state === 'ok' ? readMeta(input.meta) : undefined
  // 2026-09-15 用户定调：read 卡同样**默认收起**（与 diff 卡一致），点击展开看内容。
  const [expanded, setExpanded] = useState(false)
  if (input.state === 'ok' && meta !== undefined) {
    const range = readRange(meta)
    const shown = meta.lines.length
    const truncated = shown < meta.totalLines
    return (
      <Shell
        icon={FileText}
        tone="brand"
        title={t('fileCard.title.read')}
        path={meta.path}
        pathTitle={t('fileCard.openFile')}
        onOpenPath={openHandler(input)}
        // 设计稿 read-ok（`nXoV9`）头部**只有一个** `L1–60` chip。2026-09-15 我曾额外加过
        // 一枚「已读 N / 共 M 行」并自认与区间 chip「互补」—— 用户验收判定为**重复**，已删除。
        chips={range === undefined ? undefined : <Chip className={css.chipMono}>L{range.start}–{range.end}</Chip>}
        stateChip={<StateChip t={t} state="ok" />}
        action={(
          <ExpandAction open={expanded} onToggle={() => { setExpanded(value => !value) }} t={t} />
        )}
        content={expanded
          ? (
            <div className={css.content} data-file-card-content="">
              <ReadBlock
                lines={meta.lines}
                totalLines={meta.totalLines}
                labels={readLabels(t)}
                maxLines={DEFAULT_FILE_CARD_READ_LINES}
                {...meta.lang === undefined ? {} : { lang: meta.lang }}
              />
            </div>
          )
          : undefined}
        // 截断提示改为**仅在展开态**渲染（2026-10-22 修订）。原为无条件显示，
        // 于是折叠态仍多出一行小字（实测 68px，占掉「折叠态 40px」的一大半）：
        // 「已截断」描述的是展开后看到的内容，收起时没有内容可截断，属于噪音。
        // 与 MutationCard 的 `footExpandedOnly` 同一口径（脚注只服务展开态）。
        note={truncated && expanded
          ? <Note icon={Scissors} tone="warn" text={t('fileCard.read.truncated', { shown, total: meta.totalLines })} />
          : undefined}
      />
    )
  }
  if (input.state === 'running') {
    return (
      <Shell
        icon={FileText}
        tone="brand"
        title={t('fileCard.title.read')}
        path={input.displayPath}
        pathTitle={t('fileCard.openFile')}
        stateChip={<StateChip t={t} state="running" />}
        chips={meta === undefined ? undefined : undefined}
      />
    )
  }
  // 非成功态（含 meta 缺失的降级）→ 同一张失败壳（取舍点 D）；原文照旧可见，不吞错。
  return <FailureCard icon={FileText} title={t('fileCard.title.read')} input={input} foot={t('fileCard.foot.readFailed')} t={t} />
}

/* ── 子态 3 / 4：edit 成功、edit 未命中 ────────────────────────────── */

/**
 * 未命中卡（`edit-miss`，组件 `bCGwp`）。
 *
 * **默认折叠**（2026-09-15 用户验收 #6：「默认应该为折叠，当前是展开」）——
 * 折叠态只有头部一行（`wUNO8` 的 `edit-miss` 折叠卡：图标 + 标题 + 路径 +
 * 行数/增删 + 状态点 + 展开 chevron，**没有 foot**）；候选锚点 / mismatch /
 * 原文与 footnote 都属**展开态**内容。
 *
 * 三项能力不得回退：候选行号跳转、相似度标签、footnote 说明。
 */
function MissCard({ model, input, t }: { model: NonNullable<ReturnType<typeof parseEditNotFound>>; input: CardInput; t: TFunc }) {
  const [expanded, setExpanded] = useState(false)
  const openLine = (line: number): void => { input.openLineAt?.(input.filePath, line) }
  // 失败/未命中态的路径 chip → 打开源文件并定位（编辑页），与 FailureCard 同口径。
  const onOpenPath = openFailureHandler(input) ?? openHandler(input)
  const footnote = ((): string => {
    switch (model.reason) {
      case 'anchor-miss':
        return model.anchorLines > 1
          ? t('editMiss.footnote.anchorMissMulti', { n: model.anchorLines })
          : t('editMiss.footnote.anchorMiss')
      case 'no-previous-content': return t('editMiss.footnote.noPrevious')
      case 'insufficient-context': return t('editMiss.footnote.insufficient')
    }
  })()
  return (
    <Shell
      icon={FileX}
      tone="error"
      title={t('fileCard.title.edit')}
      path={input.displayPath}
      pathTitle={t('fileCard.openFile')}
      {...onOpenPath === undefined ? {} : { onOpenPath }}
      stateChip={<StateChip t={t} label={t('fileCard.state.miss')} tone="warn" dot="warning" />}
      trailingChip={<Chip className={css.chipFlag}>{t('fileCard.edit.noChanges')}</Chip>}
      action={<ExpandAction open={expanded} onToggle={() => { setExpanded(value => !value) }} t={t} />}
      content={!expanded ? undefined : (
        <>
          {model.candidates.length > 0 && (
            <div className={css.panel} data-file-card-candidates="">
              {model.candidates.map((candidate, index) => (
                <div className={css.candidateRow} key={`${candidate.line}-${index}`} data-file-card-candidate="">
                  <LineLink
                    label={candidate.span > 1
                      ? `L${candidate.line}-${candidate.line + candidate.span - 1}`
                      : candidate.duplicates.length > 0
                        ? `L${[candidate.line, ...candidate.duplicates].join(', ')}`
                        : `L${candidate.line}`}
                    title={t('editMiss.jumpTitle')}
                    onClick={() => { openLine(candidate.line) }}
                  />
                  {candidate.duplicates.length > 0 && <Chip className={css.chipFlag}>{t('editMiss.duplicate')}</Chip>}
                  <span className={css.snippet} title={candidate.text}>{candidate.text}</span>
                  <Chip tone={candidate.sameText ? 'success' : 'warn'} className={css.chipSim}>
                    {candidate.sameText ? t('editMiss.sameText') : `${Math.round(candidate.similarity * 100)}%`}
                  </Chip>
                </div>
              ))}
            </div>
          )}
          {model.mismatch !== undefined && (
            <div className={css.panel} data-file-card-mismatch="">
              <div className={css.mismatchRow}>
                <span className={css.mismatchKey}>{t('editMiss.mismatchAnchor', { n: model.mismatch.anchorLine })}</span>
                <span className={css.snippet} title={model.mismatch.anchorText}>{model.mismatch.anchorText}</span>
              </div>
              <div className={css.mismatchRow}>
                <LineLink
                  label={t('editMiss.mismatchFile', { n: model.mismatch.fileLine })}
                  title={t('editMiss.jumpTitle')}
                  onClick={() => { if (model.mismatch !== undefined) openLine(model.mismatch.fileLine) }}
                />
                <span className={css.snippet} title={model.mismatch.fileText}>{model.mismatch.fileText}</span>
                <Chip tone="warn" className={css.chipSim}>{Math.round(model.mismatch.similarity * 100)}%</Chip>
              </div>
            </div>
          )}
          {/* 降级态：有分档但零候选 → 附人读原文（截断标记行之外的部分）。 */}
          {model.candidates.length === 0 && (
            <div className={css.fallbackText}>
              {input.errorText?.split('\n').filter(line => !line.startsWith('<<<corum-edit-not-found')).join('\n') ?? ''}
            </div>
          )}
        </>
      )}
      note={expanded ? <Note tone="muted" text={footnote} /> : undefined}
    />
  )
}

/** 行号跳转 chip（可点、键盘可达；品牌色）。 */
function LineLink({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <Tooltip label={title}>
      <button type="button" className={css.lineLink} onClick={onClick}>{label}</button>
    </Tooltip>
  )
}

/**
 * edit 卡分流（**绝不吞错**）：
 *   - 成功 → diff 卡（落盘 diff；空数组回落参数派生的 intended diff）
 *   - 运行中 → diff 卡（intended diff 预览）
 *   - FS_EDIT_NOT_FOUND → **未命中档**：解析出候选 → MissCard（能力全）；
 *     解析不出（如「Nothing is close」）→ 未命中降级档（徽标 + 原文 + 通用说明）
 *   - 其它失败（如 FS_NOT_OBSERVED「file has not been read」）→ 失败档（原因面板 / 原文）
 */
function EditCard({ input, t }: { input: CardInput; t: TFunc }) {
  if (input.state === 'error' || input.state === 'stopped') {
    if (input.errorCode === 'FS_EDIT_NOT_FOUND') {
      const model = input.errorText === undefined ? undefined : parseEditNotFound(input.errorText)
      if (model !== undefined) return <MissCard model={model} input={input} t={t} />
      return <DegradedMissCard input={input} t={t} />
    }
    // FS_NOT_OBSERVED「未读先改」：与未命中同级的**轻提示**（非红色失败档）——
    // 这个文件本轮还没读过，先读再改即可（2026-09-16，todo.edit-card.not-observed-state）。
    if (input.errorCode === 'FS_NOT_OBSERVED') {
      return <NotObservedCard input={input} t={t} icon={FilePen} title={t('editMiss.notObserved.title')} footnote={t('editMiss.notObserved.footnote')} />
    }
    return <FailureCard icon={FileX} title={t('fileCard.title.edit')} input={input} foot={t('fileCard.foot.editFailed')} openInEditor t={t} />
  }
  // 成功态用落盘 diff；运行中用 intended diff（官方 intendedDiff 的 edit 分支同口径）。
  const settledHunks = input.state === 'ok' ? nonEmptyDiffs(input.meta) : undefined
  const intended = settledHunks !== undefined
    ? undefined
    : input.state === 'running'
      ? intendedEditHunk(input.argsRaw)
      : undefined
  const hunks = settledHunks ?? (intended === undefined ? undefined : [intended])
  return (
    <MutationCard
      icon={FilePen}
      tone="brand"
      title={t('fileCard.title.edit')}
      input={input}
      hunks={hunks}
      mode={undefined}
      foot={t('fileCard.foot.editDiff')}
      footExpandedOnly={t('fileCard.foot.editDiff')}
      t={t}
    />
  )
}

/**
 * 未命中降级档：确认是 FS_EDIT_NOT_FOUND，但错误原文给不出候选（「Nothing in the file
 * is close」这类）。与 MissCard 同一张壳、同一枚「未命中 / 文件未改动」徽标，
 * 只是候选区换成**原文可见**——原有的降级能力不回归，也不吞错。
 */
function DegradedMissCard({ input, t }: { input: CardInput; t: TFunc }) {
  // 与 MissCard 同口径：**默认折叠** + 两态恒有展开控件；原文与 footnote 属展开态。
  const [expanded, setExpanded] = useState(false)
  const onOpenPath = openFailureHandler(input) ?? openHandler(input)
  return (
    <Shell
      icon={FileX}
      tone="error"
      title={t('fileCard.title.edit')}
      path={input.displayPath}
      pathTitle={t('fileCard.openFile')}
      {...onOpenPath === undefined ? {} : { onOpenPath }}
      stateChip={<StateChip t={t} label={t('fileCard.state.miss')} tone="warn" dot="warning" />}
      trailingChip={<Chip className={css.chipFlag}>{t('fileCard.edit.noChanges')}</Chip>}
      action={<ExpandAction open={expanded} onToggle={() => { setExpanded(value => !value) }} t={t} />}
      content={expanded
        ? <div className={css.fallbackText} data-file-card-raw="">{input.errorText ?? ''}</div>
        : undefined}
      note={expanded ? <Note tone="muted" text={t('editMiss.footnote.anchorMiss')} /> : undefined}
    />
  )
}

/* ── 子态 4b：edit 未读先改（FS_NOT_OBSERVED）轻提示卡 ────────────────── */

/**
 * 未读先改轻提示卡（todo.edit-card.not-observed-state，2026-09-16）：
 * `FS_NOT_OBSERVED`（官方文案 `cannot modify "<path>": file has not been read — read the
 * file, then retry`）不是「编辑失败」，而是「先读文件」的前置提醒——与未命中同级，
 * 用 warn 调轻提示而非红色失败档。壳结构与 DegradedMissCard 同款（默认折叠 + 可点开
 * 跳文件），文案换成「先读一遍再编辑」。
 */
function NotObservedCard({ input, t, icon, title, footnote }: {
  input: CardInput
  t: TFunc
  /** 图标与文案按工具区分（edit=FilePen「编辑前未读」/ write=FilePlus「写入前未读」）。 */
  icon: LucideIcon
  title: string
  footnote: string
}) {
  const [expanded, setExpanded] = useState(false)
  const onOpenPath = openFailureHandler(input) ?? openHandler(input)
  return (
    <Shell
      icon={icon}
      tone="brand"
      title={title}
      path={input.displayPath}
      pathTitle={t('fileCard.openFile')}
      {...onOpenPath === undefined ? {} : { onOpenPath }}
      stateChip={<StateChip t={t} label={t('editMiss.notObserved.state')} tone="warn" dot="warning" />}
      trailingChip={<Chip className={css.chipFlag}>{t('fileCard.edit.noChanges')}</Chip>}
      action={<ExpandAction open={expanded} onToggle={() => { setExpanded(value => !value) }} t={t} />}
      content={expanded
        ? <div className={css.fallbackText} data-file-card-raw="">{input.errorText ?? ''}</div>
        : undefined}
      note={expanded ? <Note tone="muted" text={footnote} /> : undefined}
    />
  )
}

/* ── 子态 5 / 6：write 成功、write 失败 ────────────────────────────── */

/** write 卡：成功档 = 整文件 diff（新建 / 覆盖 由 head 的 mode 徽标区分）。 */
function WriteCard({ input, t }: { input: CardInput; t: TFunc }) {
  if (input.state === 'error' || input.state === 'stopped') {
    // FS_NOT_OBSERVED「写入前未读」（corum-fs-local fsio.ts:505/512 cannot overwrite...without
    // reading first）：与 edit 侧同级的轻提示卡（todo.edit-card.not-observed-state 收尾）。
    if (input.errorCode === 'FS_NOT_OBSERVED') {
      return <NotObservedCard input={input} t={t} icon={FilePlus} title={t('editMiss.notObserved.writeTitle')} footnote={t('editMiss.notObserved.writeFootnote')} />
    }
    return <FailureCard icon={ShieldAlert} title={t('fileCard.title.write')} input={input} foot={t('fileCard.foot.writeFailed')} t={t} />
  }
  const args = writeCallArgs(input.argsRaw)
  // 新建 / 内容完全相同 → 落盘 diffs 是**合法空数组**，此时官方口径回落到
  // 参数派生的整文件 diff（`nonEmptyDiffs` 把空数组当 undefined）。
  const settledHunks = input.state === 'ok' ? nonEmptyDiffs(input.meta) : undefined
  const intended = settledHunks !== undefined ? undefined : intendedWriteHunk(args)
  const hunks = settledHunks ?? (intended === undefined ? undefined : [intended])
  // 新建 / 覆盖：读结果信封的 Created/Updated file；运行中无法判定 → 不渲染徽标。
  const outcome = input.state === 'ok' ? writeOutcome(input.errorText) : undefined
  const totals = hunks === undefined ? undefined : diffTotals(hunks)
  const mode = outcome === undefined
    ? undefined
    : <Chip tone="warn" className={css.chipMode}>{outcome === 'create' ? t('fileCard.write.created') : t('fileCard.write.updated')}</Chip>
  const foot = totals === undefined || outcome === undefined
    ? t('fileCard.foot.writeDiff')
    : outcome === 'create'
      ? t('fileCard.foot.writeCreated', { added: totals.added, removed: totals.removed })
      : t('fileCard.foot.writeOverwritten', { added: totals.added, removed: totals.removed })
  return (
    <MutationCard
      icon={FilePlus}
      tone="success"
      title={t('fileCard.title.write')}
      input={input}
      hunks={hunks}
      mode={mode}
      foot={foot}
      // 与 edit 卡同口径：脚注**只服务展开态**（2026-10-22 修订）。
      // 「整文件覆盖写入 · 已生成 4 行 / 删除 2 行」描述的是展开后看到的 diff，
      // 收起时没有 diff 可见，这行小字会把折叠卡从 40px 撑到 68px —— 与本次
      // 「折叠态减半」的目标直接冲突。增删统计已在头部 stats chip 常驻，不丢信息。
      footExpandedOnly={foot}
      t={t}
    />
  )
}

/* ── 共用：diff 卡（edit / write）与失败卡（read / write）─────────── */

/** edit / write 共用：head(+mode +±统计 +展开控件) + diff 内容 + note。 */
function MutationCard({ icon, tone, title, input, hunks, mode, foot, footExpandedOnly, t }: {
  icon: LucideIcon
  tone: 'brand' | 'success'
  title: string
  input: CardInput
  hunks: readonly DiffHunk[] | undefined
  mode: ReactNode
  foot: string
  /**
   * **仅在展开态**渲染的脚注（与 `foot` 二选一，设了就不再用 `foot`）。
   *
   * 设计依据：编辑卡的脚注「点击右上角收起 diff；完整原文可展开查看。」是**展开态专用**
   * 语义 —— 已经收起了还叫用户「收起 diff」是荒谬的。
   * 设计稿里展开态是 `edit · 成功`（组件 `jjSBU`，含 chevron-up + 该 foot），
   * 折叠态是 `edit-ok`（`wUNO8` 里那张**只有头部一行、没有 foot** 的卡）。
   * 2026-09-15 用户验收报「收起时会有小字『点击右上角收起 diff…』」，即此。
   */
  footExpandedOnly?: string
  t: TFunc
}) {
  // 2026-09-15 用户定调：**默认收起**（原为 `useState(true)` 默认展开 ⇒ 长 diff 一屏占满；
  // 用户要求「默认收起，点击卡片展开再看详情，可卡片内滚动」）。
  // 设计稿的 edit-ok / write-ok 画的是展开态，但那只描述**展开后**的样式，不约束初始态；
  // 折叠能力一直在（行为等价清单：展开/折叠），本次只改初始值。
  const [expanded, setExpanded] = useState(false)
  const hasContent = hunks !== undefined && hunks.length > 0
  const totals = hasContent ? diffTotals([...hunks]) : undefined
  const chips = (
    <>
      {mode}
      {totals !== undefined && (
        <Chip className={css.chipStats}>
          <span className={css.statAdd}>+{totals.added}</span>
          <span className={css.statDel}>−{totals.removed}</span>
        </Chip>
      )}
    </>
  )
  const stateChip = input.state === 'running' ? <StateChip t={t} state="running" /> : undefined
  // 展开控件**恒渲染**：design.pen `wUNO8` 的六张折叠卡**每一张**头部末尾都有
  // `act-expand`（chevron），`jjSBU`（edit-ok）/ `H4jCs`（write-ok）的展开态则是 `chevron-up`。
  // 2026-09-15 用户验收 #7：「**折叠态没有收起到图标** —— 折叠态必须有那个展开 chevron 控件」。
  // 旧实现在 `hasContent === false`（diff 解析不出）时把控件整个吞掉，折叠卡就只剩标题
  // ⇒ 用户无从展开。故不再以「有内容」为渲染前提。
  const action = <ExpandAction open={expanded} onToggle={() => { setExpanded(value => !value) }} t={t} />
  // 展开态专用的脚注（见 `footExpandedOnly` 的文档）：收起时**不渲染**。
  const noteText = footExpandedOnly !== undefined ? (expanded ? footExpandedOnly : undefined) : foot
  return (
    <Shell
      icon={icon}
      tone={tone}
      title={title}
      path={input.displayPath}
      pathTitle={t('fileCard.openFile')}
      onOpenPath={openHandler(input)}
      chips={chips}
      stateChip={stateChip}
      action={action}
      content={hasContent && expanded
        ? (
          <div className={css.content} data-file-card-content="">
            <DiffBlock diffs={[...hunks]} labels={diffLabels(t)} />
          </div>
        )
        : undefined}
      note={noteText === undefined ? undefined : <Note tone="muted" text={noteText} />}
    />
  )
}

/** read 失败 / write 失败共用：head(+失败状态 chip) + 原因面板 + note（原文绝不吞掉）。 */
function FailureCard({ icon, title, input, foot, openInEditor = false, t }: {
  icon: LucideIcon
  title: string
  input: CardInput
  foot: string
  /**
   * 路径 chip 是否走「打开源文件并定位」（编辑页）。
   *
   * 只有**编辑**侧失败卡打开它：用户验收 #6 的原文是「失败时点击链接应该进入**编辑页面**
   * 而不是 diff 比较页面」——针对的是编辑卡。读取/写入失败卡保持**不可点**（与本次改动前
   * 一致）：读失败的文件可能根本不存在，写失败也不该引导用户去编辑那个路径。
   */
  openInEditor?: boolean
  t: TFunc
}) {
  // **默认折叠**（2026-09-15 用户验收 #2：「读取·失败卡默认是展开不是折叠」）。
  // 折叠态 = 只有头部一行（design.pen `wUNO8` 的六张折叠卡都是这个形态）；
  // 原因面板与 foot 都属**展开态**内容（`LBUMN` / `yer9p` 画的是带内容的展开态）。
  const [expanded, setExpanded] = useState(false)
  // 解析不出分档 → 回落纯文本原文（降级不崩；红线：绝不吞错）。
  const causes = input.errorText === undefined ? undefined : classifyFailure(input.errorText, input.errorCode)
  const structured = causes !== undefined && causes[0]?.kind !== 'unknown'
  const onOpenPath = openInEditor ? (openFailureHandler(input) ?? openHandler(input)) : openHandler(input)
  return (
    <Shell
      icon={icon}
      tone="error"
      title={title}
      path={input.displayPath}
      pathTitle={t('fileCard.openFile')}
      {...onOpenPath === undefined ? {} : { onOpenPath }}
      stateChip={<StateChip t={t} state={input.state} />}
      // 展开控件**两态恒在**（用户验收 #2：「保证折叠/展开两态都有可用的展开/收起按钮」）。
      action={<ExpandAction open={expanded} onToggle={() => { setExpanded(value => !value) }} t={t} />}
      content={!expanded
        ? undefined
        : structured
          ? (
            <div className={css.reasonPanel} data-file-card-reason="">
              {causes.map((cause, index) => (
                <div className={css.reasonRow} key={`${cause.kind}-${index}`} data-file-card-cause={cause.kind}>
                  <Chip {...index === 0 ? { tone: 'error' as const } : {}} className={css.chipCause}>{t(causeKindKey(cause.kind))}</Chip>
                  <span className={css.reasonText}>{cause.detail}</span>
                </div>
              ))}
            </div>
          )
          : input.errorText === undefined
            ? undefined
            : <div className={css.fallbackText} data-file-card-raw="">{input.errorText}</div>}
      note={expanded ? <Note tone="muted" text={foot} /> : undefined}
    />
  )
}

/* ── 导出：三工具共用的 keyed toolview 组件 ────────────────────────── */

/**
 * 文件工具卡（`tool.call.toolview`，key = 'read' / 'edit' / 'write'）。
 *
 * 按 toolName 选卡，每卡内部再按 state 分成功 / 运行 / 失败 / 未命中共态；
 * 任何解析失败都降级到「同一张玻璃壳 + 原文可见」，绝不崩、绝不吞错。
 */
export const FileToolCard = memo(function FileToolCard(props: ToolCallViewProps & FileToolCardExtraProps & { t: TFunc }) {
  const input = cardInput(props)
  if (props.toolName === 'read') return <ReadCard input={input} t={props.t} />
  if (props.toolName === 'write') return <WriteCard input={input} t={props.t} />
  return <EditCard input={input} t={props.t} />
})
