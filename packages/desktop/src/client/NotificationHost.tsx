/**
 * NotificationHost — corum-desktop 通知的渲染层（design.pen「row-通知框」YbfO9）。
 *
 * 订阅 NotificationStore，把通知栈经 createPortal 挂到 document.body 右下角
 * （摆脱网格 .leaf 的 will-change:transform + overflow:hidden 合成层裁剪，
 * 同 SettingsShell 的 portal 模式）。结构 1:1 对齐设计稿 toast：icon-box +
 * title/msg + 关闭 ×（r1 行），时间戳 + 主/次操作（r2 行）。样式走设计 token
 * （深/浅主题随 body[data-ds-dark-theme] 翻转），lucide 图标。
 * @module corum-desktop/client/NotificationHost
 */

import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CircleCheck, Hourglass, Info, X } from 'lucide-react'
import type { CorumNotification, NotificationStore, NotificationTone } from './notifications.ts'
import css from './NotificationHost.module.css'

/** tone → lucide 图标（设计稿：success=circle-check，warn=hourglass）。 */
const TONE_ICON: Record<NotificationTone, typeof Info> = {
  success: CircleCheck,
  warn: Hourglass,
  error: AlertTriangle,
  info: Info,
}

/** tone → icon-box 配色类（显式映射，避免动态键在 CSS Modules 下失配）。 */
const TONE_CLASS: Record<NotificationTone, string> = {
  success: css.toneSuccess,
  warn: css.toneWarn,
  error: css.toneError,
  info: css.toneInfo,
}

/** r2 行时间戳的相对时间标签（对齐侧栏 timeLabel 语义）。 */
function relTime(createdAt: number): string {
  const diff = Date.now() - createdAt
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function Toast({ notification, onDismiss }: {
  notification: CorumNotification
  onDismiss: (id: string) => void
}) {
  const Icon = TONE_ICON[notification.tone]
  return (
    <div className={css.toast} data-tone={notification.tone} role="status">
      {/* r1 行：icon-box + title/msg + 关闭 × */}
      <div className={css.r1}>
        <span className={`${css.iconBox} ${TONE_CLASS[notification.tone]}`}>
          <Icon size={16} strokeWidth={2} />
        </span>
        <div className={css.col}>
          <span className={css.title}>{notification.title}</span>
          {notification.message !== undefined && notification.message !== '' && (
            <span className={css.msg}>{notification.message}</span>
          )}
        </div>
        <button
          type="button"
          className={css.btnX}
          aria-label="关闭通知"
          onClick={() => onDismiss(notification.id)}
        >
          <X size={10} strokeWidth={2} />
        </button>
      </div>
      {/* r2 行：时间戳 + 主/次操作（有操作或需时间戳时渲染） */}
      <div className={css.r2}>
        <span className={css.time}>{relTime(notification.createdAt)}</span>
        <span className={css.spacer} />
        {(notification.actions ?? []).map((action, i) => (
          <button
            key={`${notification.id}-a${i}`}
            type="button"
            className={action.kind === 'primary' ? css.a1 : css.a2}
            onClick={() => {
              const keep = action.onClick()
              if (keep !== false) onDismiss(notification.id)
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 通知栈宿主：portal 到 body 右下角纵向堆叠（设计稿 alignItems=end）。 */
export function NotificationHost({ store }: { store: NotificationStore }) {
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot)
  if (items.length === 0) return null
  return createPortal(
    <div className={css.stack} aria-live="polite">
      {items.map(n => (
        <Toast key={n.id} notification={n} onDismiss={(id) => store.dismiss(id)} />
      ))}
    </div>,
    document.body,
  )
}
