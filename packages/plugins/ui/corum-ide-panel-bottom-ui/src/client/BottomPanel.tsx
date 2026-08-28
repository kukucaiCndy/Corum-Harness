/**
 * BottomPanel — the IDE terminal region (design.pen ⑥, 浅 xGd58 / 深 mOtXy).
 * A normal grid leaf like every other region — resizable and freely composable
 * with the rest, no special floating/fixed semantics. Structure follows the
 * design frame: tabs (bU2zf: pt-终端 active glass-2 + active-border r10
 * pad[6,12] + spacer + × close) → term (JYZCL: JetBrains Mono 11px lines with
 * design colors). The × close hides this leaf via `corum:close-region`.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { X } from 'lucide-react'
import css from './BottomPanel.module.css'

/** Composed props: the shell's owner share (终端已纳入网格，× 经 corum:close-region 自关闭)。 */
export type BottomPanelProps = PropsRuntime<'corum.panel'>

/**
 * The terminal line set (design ⑥ term, JetBrains Mono 11px).
 * 注意：▲/✓ 为终端程序原生输出字符（内容，如 vercel/turbo 的输出），
 * 非 UI 图标，故保留文本字符而不替换为图标组件。
 */
const TERM_LINES: { text: string; tone: 'primary' | 'secondary' | 'success' | 'brand' }[] = [
  { text: '$ pnpm dev', tone: 'primary' },
  { text: '  ▲ corum-harness dev server ready on :3717', tone: 'secondary' },
  { text: '  ✓ compiled packages/layout in 812ms', tone: 'success' },
  { text: '$ ', tone: 'brand' },
]

/** The IDE floating terminal panel (see module doc). */
export function BottomPanel(_props: BottomPanelProps) {
  return (
    <div className={css.panel}>
      <div className={css.tabs}>
        <span className={css.tabActive}>终端</span>
        <span className={css.spacer} />
        {/* × 关闭：终端已纳入网格，隐藏本叶子（可在状态栏「添加区域」恢复）。 */}
        <button
          type="button"
          className={css.close}
          title="关闭此区域（可在状态栏「添加区域」恢复）"
          onClick={() => window.dispatchEvent(new CustomEvent('corum:close-region', { detail: { slot: 'corum.panel' } }))}
        >
          <X size={17} strokeWidth={2} />
        </button>
      </div>
      <div className={css.term}>
        {TERM_LINES.map((line, i) => (
          <span key={i} className={css.line} data-tone={line.tone}>{line.text}</span>
        ))}
      </div>
    </div>
  )
}
