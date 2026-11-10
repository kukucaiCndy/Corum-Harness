/**
 * ConfirmDialog —— 统一确认提示框（设置域所有「确认/取消」场景复用）。
 *
 * 两种形态：
 * - placement="center"：全屏遮罩 + 居中玻璃对话框（默认，适合打断性确认，如删除技能）。
 * - placement="inline"：内联气泡弹窗（适合就地二次确认，如 Agent 预设 footer 删除，
 *   对应设计稿 DKRwC confirm-pop；调用方负责定位容器 position:relative）。
 *
 * 视觉 token 全部走设计变量，深浅主题随 body[data-ds-dark-theme] 自动翻转。
 * @module corum-ide-ui/client/settings/ConfirmDialog
 */
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import css from './ConfirmDialog.module.css'

export interface ConfirmDialogProps {
  /** 标题（如「删除技能」「删除该预设？」）。 */
  title: string
  /** 主文案（确认问题）。 */
  message: ReactNode
  /** 警示补充（如「已绑定 N 个 Agent，删除后不可恢复」；可选）。 */
  warning?: ReactNode
  /** 内联错误信息（确认动作失败时展示；可选）。 */
  error?: string | null
  /** 主操作文案（默认「确认」）。 */
  confirmLabel?: ReactNode
  /** 次操作文案（默认「取消」）。 */
  cancelLabel?: ReactNode
  /** 主操作色调：danger=危险（删除等），primary=主操作（默认 danger）。 */
  tone?: 'danger' | 'primary'
  /** 形态：center=居中模态（默认） / inline=内联气泡。 */
  placement?: 'center' | 'inline'
  /** 主操作进行中（禁用按钮并显示 busy 文案）。 */
  busy?: boolean
  /** busy 时主操作文案（默认沿用 confirmLabel）。 */
  busyLabel?: ReactNode
  /** 主操作额外禁用条件。 */
  confirmDisabled?: boolean
  /** 点主操作。 */
  onConfirm: () => void
  /** 点次操作 / 遮罩 / ×。 */
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  warning,
  error,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'danger',
  placement = 'center',
  busy = false,
  busyLabel,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const body = (
    <>
      <div className={css.title}>{title}</div>
      <div className={css.message}>{message}</div>
      {warning !== undefined && <div className={css.warning}>{warning}</div>}
      {error !== undefined && error !== null && error !== '' && <div className={css.warning}>{error}</div>}
      <div className={css.row}>
        {/* `data-slot` = 稳定语义锚点（黑盒自测定位用）。为什么需要：确认/取消两个按钮**只有文案**，
            而同一时刻页面上往往还有别的「删除」「取消」按钮（例如主题列表里的行内删除）——
            按文案定位会打错目标。这里给这一对按钮加语义锚点，只加属性、不改行为。
            容器本身已有标准 ARIA 面 `role="alertdialog"`（确认框），锚点只用于按钮。 */}
        <button type="button" data-slot="confirm.cancel" className={css.cancelBtn} onClick={onCancel} disabled={busy}>{cancelLabel}</button>
        <button
          type="button"
          data-slot="confirm.ok"
          className={tone === 'primary' ? css.confirmBtnPrimary : css.confirmBtnDanger}
          onClick={onConfirm}
          disabled={busy || confirmDisabled}
        >{busy ? (busyLabel ?? confirmLabel) : confirmLabel}</button>
      </div>
    </>
  )

  if (placement === 'inline') {
    return <div className={css.inlinePop}>{body}</div>
  }

  return createPortal(
    <div className={css.overlay} onClick={onCancel}>
      <div className={css.dialog} onClick={e => e.stopPropagation()} role="alertdialog" aria-modal="true">
        <button type="button" className={css.closeBtn} onClick={onCancel} aria-label="关闭"><X size={16} /></button>
        {body}
      </div>
    </div>,
    document.body,
  )
}
