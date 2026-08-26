/**
 * 通知宿主的挂载入口：为 NotificationHost 建一个独立 React root（createRoot）
 * 挂到 document.body 的专用容器 div。通知栈与任何 combo 的根布局/槽位系统
 * 解耦——无论当前是哪个 combo（IDE / dev-agent / 任意未来 combo），通知都
 * 能在 body 右下角浮现。
 * @module corum-desktop/client/mount-notifications
 */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NotificationStore } from './notifications.ts'
import { NotificationHost } from './NotificationHost.tsx'

/** 通知容器在 body 下的标记类名（防重复挂载）。 */
const CONTAINER_CLASS = 'corum-notification-root'

/**
 * 挂载通知宿主。幂等：已挂载时直接返回现有 root。
 * @param store - 通知 store。
 * @returns 卸载句柄（HMR/壳重建时清理 root + 容器）。
 */
export function mountNotificationHost(store: NotificationStore): { dispose(): void } {
  let container = document.body.querySelector<HTMLDivElement>(`.${CONTAINER_CLASS}`)
  let root: Root | null = null
  if (container === null) {
    container = document.createElement('div')
    container.className = CONTAINER_CLASS
    document.body.appendChild(container)
    root = createRoot(container)
    root.render(createElement(NotificationHost, { store }))
  }
  return {
    dispose() {
      root?.unmount()
      root = null
      container?.remove()
      container = null
    },
  }
}
