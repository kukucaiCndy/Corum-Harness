/**
 * fork（corum）：终端卡 —— 替换官方 bash 行的 corum 毛玻璃卡（2026-09-15）。
 *
 * 设计源（唯一权威）：`doc/UXDesign/design.pen` 帧 qLyn3（dark theme A）：
 *   - 帧 sCrmX = terminal-card-expanded
 *   - 帧 j8ZUL = terminal-card-collapsed
 *
 * 注册面：keyed slot `tool.call.toolview`（key = 'bash'，priority -1 遮蔽官方行，
 * 见 apply.ts）。keyed 命中 = **整行替换**官方行（官方 renderSlot 契约），所以本
 * 组件必须自己覆盖全部子态。
 *
 * 复制：复用官方 `writeClipboard`（`@deepseek-ai/dsh-client-ui-primitives`），
 * 与官方 CodeBlock 同款 1000ms copied 态。两个独立复制控件（复制命令 / 复制输出）
 * 保持分离——它们复制不同的东西。**位置不同**（2026-09-15 用户定调）：
 * 「复制命令」在头部（两态都在），「复制输出」在**展开体的框内底部右侧**
 * （设计源 = design.pen 帧 sCrmX 的 `term > out-actions`），**折叠态不出现**。
 *
 * 折叠态默认（与 FileToolCard / SubagentCard 的 disclosure 惯例一致）。折叠态
 * 命令全文 **必须完整可见、换行、不截断、不用 ellipsis**（验收标准 #1）。
 *
 * model=null 时（后台 bash / persistent shell / 错误 / 非法参数）→ 渲染 fallback
 * 壳（同一玻璃卡 + 原文可见），绝不崩、绝不吞错——与 FileToolCard 的降级同款。
 */
import { memo, useCallback, useState } from 'react'
import { Check, ChevronDown, ChevronUp, ClipboardList, Copy, SquareTerminal } from 'lucide-react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../locale.ts'
import {
  classifyLines, countLines, deriveShellName, stripAnsi, terminalCardModel, terminalFailed,
  type LineRole,
} from './terminal-card.ts'
import css from './TerminalCard.module.css'

/** 框架按注册 locale 注入的 t（key 集 = 'chat' namespace 的 ChatKey 联合）。 */
type TFunc = PropsLocale<'chat'>['t']

/** 展开体逐行 → className 映射。 */
function bodyLineClass(role: LineRole): string {
  switch (role) {
    case 'command': return css.bodyLineCommand
    case 'dim': return css.bodyLineDim
    case 'success': return css.bodyLineSuccess
    case 'failure': return css.bodyLineFailure
    case 'plain': return css.bodyLinePlain
  }
}

/**
 * 终端卡主体（model 非 null 时渲染）。
 */
function TerminalCardBody({ model, t }: { model: NonNullable<ReturnType<typeof terminalCardModel>>; t: TFunc }) {
  const [expanded, setExpanded] = useState(false)
  const [copiedCmd, setCopiedCmd] = useState(false)
  const [copiedOut, setCopiedOut] = useState(false)

  const shell = deriveShellName(model.command)
  const failed = terminalFailed(model)
  const lines = classifyLines(model.output)
  const { commands, outputLines } = countLines({
    command: model.command,
    output: model.output,
    isTerminalSend: model.isTerminalSend,
  })

  const onCopyCmd = useCallback(() => {
    if (copiedCmd) return
    void writeClipboard(model.command).then((ok) => {
      if (!ok) return
      setCopiedCmd(true)
      window.setTimeout(() => { setCopiedCmd(false) }, 1000)
    })
  }, [copiedCmd, model.command])

  const onCopyOut = useCallback(() => {
    if (copiedOut || model.output === undefined) return
    // Copy the STRIPPED text (what the user sees), not the raw bytes — copying
    // escape garbage is useless. stripAnsi removes OSC, non-CSI, CSI sequences,
    // inert controls, and resolves `\r` progress rewrites.
    const clean = stripAnsi(model.output)
    void writeClipboard(clean).then((ok) => {
      if (!ok) return
      setCopiedOut(true)
      window.setTimeout(() => { setCopiedOut(false) }, 1000)
    })
  }, [copiedOut, model.output])

  const toggle = useCallback(() => { setExpanded(v => !v) }, [])

  // 状态 pill 文案 / 色档
  const statusKey = model.running
    ? 'terminalCard.status.running'
    : failed
      ? 'terminalCard.status.failed'
      : 'terminalCard.status.success'
  const statusClass = model.running
    ? css.statusText
    : failed
      ? css.statusTextError
      : css.statusTextSuccess

  // 行数 chip：展开 = 命令行数 + 输出行数；折叠 = 仅输出行数
  const linesChip = expanded
    ? t('terminalCard.lines.expanded', { commands, output: outputLines })
    : t('terminalCard.lines.collapsed', { output: outputLines })

  return (
    <div className={css.card} data-corum-terminal-card="">
      <div className={css.head}>
        <span className={css.iconBox}>
          <SquareTerminal size={14} strokeWidth={2} className={css.iconBoxIcon} />
        </span>
        <span className={css.title}>{t('terminalCard.title')}</span>
        {/* 命令行收进头部（2026-10-22 修订）：原为单独占一行（`.cmdRow`），那是折叠态
            74px 的成因；现在与文件卡的 path chip 同位置、同规格，长命令尾部省略，
            全文靠 title（hover）与右侧「复制命令」按钮给到。 */}
        <span className={css.cmdChip} data-corum-terminal-cmd="" title={model.command}>
          <span className={css.cmdChipText}>$ {model.command}</span>
        </span>
        {/* 无需 spacer：命令 chip 自身 flex:1 吃掉全部剩余宽度，右侧这一组
            自然贴到卡片右端（右侧成组对齐）。留着 spacer 只会与命令抢空间。 */}
        <span className={css.chip}>{linesChip}</span>
        <span className={css.statusPill}>
          <span className={statusClass}>{t(statusKey, { shell })}</span>
        </span>
        <button
          type="button"
          className={css.iconBtn}
          title={copiedCmd ? t('terminalCard.copied') : t('terminalCard.copyCmd')}
          aria-label={t('terminalCard.copyCmd')}
          onClick={onCopyCmd}
        >
          {copiedCmd
            ? <Check size={14} strokeWidth={2} />
            : <Copy size={14} strokeWidth={2} />}
        </button>
        <button
          type="button"
          className={css.chevronBtn}
          title={expanded ? t('terminalCard.collapse') : t('terminalCard.expand')}
          aria-label={expanded ? t('terminalCard.collapse') : t('terminalCard.expand')}
          aria-expanded={expanded}
          onClick={toggle}
        >
          {expanded
            ? <ChevronUp size={14} strokeWidth={2} />
            : <ChevronDown size={14} strokeWidth={2} />}
        </button>
      </div>
      {expanded && (
        <div className={css.body} data-corum-terminal-body="">
          {lines.filter(line => line.role !== 'command').map((line, i) => (
            <div className={`${css.bodyLine} ${bodyLineClass(line.role)}`} key={i}>
              {line.text}
            </div>
          ))}
          {model.output === undefined && (
            <div className={`${css.bodyLine} ${css.bodyLineDim}`}>{t('terminalCard.noOutput')}</div>
          )}
          {/*
            「复制输出」在**展开体的框内、底部右侧**（2026-09-15 用户定调：
            「展开后**框内**有复制输出比较合理」）。
            设计源：design.pen 帧 sCrmX 的 `term > out-actions`（spacer + copy-output）。
            ⚠️ 本块**推翻了卡片初版**（当时它和「复制命令」并排放在头部）—— 两条定调：
              ① 折叠态**不得**出现它（头部现在只剩「复制命令」+ 折叠 chevron）；
              ② 它复制的是**输出**，与「复制命令」是两个语义不同的控件，始终分开。
          */}
          <div className={css.outActions} data-corum-terminal-out-actions="">
            <span className={css.outActionsSpacer} />
            <button
              type="button"
              className={css.btn}
              title={t('terminalCard.copyOutput')}
              aria-label={t('terminalCard.copyOutput')}
              onClick={onCopyOut}
              disabled={model.output === undefined}
            >
              <ClipboardList size={13} strokeWidth={2} className={css.btnIcon} />
              <span className={css.btnLabel}>{copiedOut ? t('terminalCard.copied') : t('terminalCard.copyOutput')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Fallback（model=null）—— 后台 bash / persistent shell / 错误 / 非法参数。
 *
 * 与 FileToolCard 的降级同款：同一玻璃壳 + 头行（图标 + 标题 + 状态）+ 原文可见。
 * 绝不崩、绝不吞错。官方 bash-sample.tsx 在 model=null 时走 genericBody（展开后看
 * input/output 段）；本卡在折叠态就展示 command 摘要，展开后展示完整 bodyRaw /
 * output 原文——保证用户永远看得到 AI 发出去的命令。
 */
function FallbackCard({ props, t }: { props: ToolCallViewProps & { t: TFunc }; t: TFunc }) {
  const { block, toolName } = props
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : ('argsRaw' in block ? block.argsRaw : '')) ?? ''
  // 尝试取 command（即使 model=null，argsRaw 里通常还有 command 字段）
  let command = ''
  try {
    const parsed = JSON.parse(argsRaw)
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.command === 'string') {
      command = parsed.command
    }
  } catch {
    // 非 JSON → 用 argsRaw 首行
    command = argsRaw.split('\n')[0] ?? ''
  }
  // output：settled 时取结果文本，strip ANSI so escape bytes don't render as garbage.
  let output = ''
  if (settled) {
    for (const c of block.content) {
      if (c.type === 'text') { output = stripAnsi(c.text); break }
    }
  }
  const isError = settled && block.isError
  const [expanded, setExpanded] = useState(false)
  const shell = deriveShellName(command)
  const statusKey = !settled
    ? 'terminalCard.status.running'
    : isError
      ? 'terminalCard.status.failed'
      : 'terminalCard.status.success'
  const statusClass = !settled
    ? css.statusText
    : isError
      ? css.statusTextError
      : css.statusTextSuccess

  const body = expanded ? (output || command) : command

  return (
    <div className={css.fallback} data-corum-terminal-card="" data-terminal-fallback="">
      <div className={css.fallbackHead}>
        <span className={css.iconBox}>
          <SquareTerminal size={14} strokeWidth={2} className={css.iconBoxIcon} />
        </span>
        <span className={css.title}>{t('terminalCard.title')}</span>
        {/* 与主体同骨架：命令行收进头部 chip（2026-10-22 修订）。 */}
        <span className={css.cmdChip} data-corum-terminal-cmd="" title={command}>
          <span className={css.cmdChipText}>$ {command}</span>
        </span>
        <span className={css.statusPill}>
          <span className={statusClass}>{t(statusKey, { shell })}</span>
        </span>
        <button
          type="button"
          className={css.chevronBtn}
          title={expanded ? t('terminalCard.collapse') : t('terminalCard.expand')}
          aria-label={expanded ? t('terminalCard.collapse') : t('terminalCard.expand')}
          aria-expanded={expanded}
          onClick={() => { setExpanded(v => !v) }}
        >
          {expanded
            ? <ChevronUp size={14} strokeWidth={2} />
            : <ChevronDown size={14} strokeWidth={2} />}
        </button>
      </div>
      {expanded && output !== undefined && output !== '' && (
        <div className={css.fallbackBody}>{output}</div>
      )}
    </div>
  )
}

/**
 * 终端卡 toolview（key = 'bash'）。
 *
 * model=null（后台 bash / persistent shell / 错误 / 非法参数）→ 渲染 fallback 壳，
 * 绝不返回 null/空白（keyed 命中 = 整行替换，空白行是回退）。
 */
export const TerminalCardView = memo(function TerminalCardView(props: ToolCallViewProps & { t: TFunc }) {
  const { block, cwd } = props
  const model = terminalCardModel(block as import('../contract/snapshot.ts').ToolCallBlock, cwd)
  if (model === null) return <FallbackCard props={props} t={props.t} />
  return <TerminalCardBody model={model} t={props.t} />
})
