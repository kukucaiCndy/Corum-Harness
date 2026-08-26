/**
 * corum-desktop 通知服务（框架级）：任何 combo 可用的应用内 toast 通知。
 *
 * 设计来源：design.pen「row-通知框」（YbfO9）——右下角纵向堆叠 toast，
 * icon-box + title/msg + 关闭 × + 时间戳 + 主/次操作。本模块是无 React
 * 依赖的 store（subscribe/getSnapshot），UI 由 NotificationHost 挂载；
 * 生产方（HMR 失败、会话事件、任意插件）只调 notify()。
 *
 * 框架定位：这是 corum-desktop 提供的基础能力，不限 dev——HMR 失败只是
 * 第一个消费方。通知服务本身常驻，任何 combo 的生产方都可经 ctx 或
 * 直接 import notify() 发通知。
 * @module corum-desktop/client/notifications
 */

/** 通知语义色（对应设计稿 icon-box 图标配色）。 */
export type NotificationTone = 'success' | 'warn' | 'info' | 'error'

/** 一个操作按钮（设计稿 r2 行的 a1 主操作 / a2 次操作）。 */
export interface NotificationAction {
  /** 按钮文案（如「立即刷新」「查看」）。 */
  label: string
  /** 主操作（brand 色高亮）或次操作（tertiary 灰）。 */
  kind: 'primary' | 'secondary'
  /** 点击回调；返回 true 或 undefined 均关闭该通知（除非显式返回 false）。 */
  onClick: () => void | boolean
}

/** 一条通知。 */
export interface CorumNotification {
  id: string
  /** 语义色，决定 icon-box 图标与配色（默认 info）。 */
  tone: NotificationTone
  /** 标题（12/600 $label-primary）。 */
  title: string
  /** 副文案（11 $label-secondary）。 */
  message?: string
  /** 操作按钮（r2 行，最多取前两个；缺省无操作行）。 */
  actions?: NotificationAction[]
  /** 创建时间戳（ms），r2 行相对时间显示用。 */
  createdAt: number
}

/** 通知 store 的可订阅快照。 */
export interface NotificationStore {
  getSnapshot(): readonly CorumNotification[]
  subscribe(listener: () => void): () => void
  /** 发一条通知，返回其 id（供调用方后续 dismiss）。 */
  notify(input: Omit<CorumNotification, 'id' | 'createdAt'> & { createdAt?: number }): string
  /** 关闭指定通知。 */
  dismiss(id: string): void
  /** 清空全部通知。 */
  clear(): void
}

/** 创建通知 store（单实例由桌面壳持有并暴露）。 */
export function createNotificationStore(): NotificationStore {
  let items: readonly CorumNotification[] = []
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[corum-desktop] notification listener threw:', error)
      }
    }
  }
  return {
    getSnapshot: () => items,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notify: (input) => {
      const id = `ntf-${crypto.randomUUID()}`
      const next: CorumNotification = {
        id,
        tone: input.tone ?? 'info',
        title: input.title,
        createdAt: input.createdAt ?? Date.now(),
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.actions !== undefined ? { actions: input.actions.slice(0, 2) } : {}),
      }
      items = [...items, next]
      emit()
      return id
    },
    dismiss: (id) => {
      if (!items.some(n => n.id === id)) return
      items = items.filter(n => n.id !== id)
      emit()
    },
    clear: () => {
      if (items.length === 0) return
      items = []
      emit()
    },
  }
}
