/**
 * corum-desktop client half: framework-level surfaces for the desktop shell.
 * The transport is the official web stack (the renderer loads the host's
 * loopback webserver directly), so this plugin carries no connection glue —
 * only the notification store/host and the resident editor column. Dev HMR is
 * served by the official `dsh-client-hmr` row (webserver SSE), enabled by the
 * desktop overlay.
 * @module corum-desktop/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { createNotificationStore, type NotificationStore } from './notifications.ts'
import { mountNotificationHost } from './mount-notifications.tsx'
// Type-only: pulls the `ctx.slots` Context merge (declared by dsh-client-ui-renderer).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `corum.editor` SlotMap row (declared by @corum/corum-ide-ui).
import type {} from '@corum/corum-ide-ui/client'
import { EditorColumn } from './editor/EditorColumn.tsx'

/** Required services: none — this is the wire root; the code-editor view registers lazily below. */
export const inject: string[] = []

// Context merge: the framework notification store is injectable by any plugin.
declare module '@deepseek-ai/cordis' {
  interface Context {
    notifications: NotificationStore
  }
}

/**
 * Client plugin body: framework surfaces over the desktop IPC carrier.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  // Framework notifications (design.pen「row-通知框」): a framework-level
  // capability any combo can use — HMR failure is just the first consumer.
  // The store is provided as `ctx.notifications`; the host renders the toast
  // stack into a body-rooted portal (decoupled from any combo's slot system).
  const notifications = createNotificationStore()
  ctx.provide('notifications', notifications)
  const notificationHost = mountNotificationHost(notifications)
  ctx.effect(() => () => { notificationHost.dispose() }, 'corum-desktop: notification host')
  // Debug/console surface: lets CDP and the devtools console emit a notification
  // without a fiber reference (plugins should inject `ctx.notifications` instead).
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __corumNotify?: NotificationStore['notify'] }).__corumNotify = notifications.notify
  }

  // The resident Monaco editor (design.pen ③ 编辑器区): registered into the
  // shell's `corum.editor` slot (declared by @corum/corum-ide-ui, IDE mode only).
  // Monaco's worker/protocol infrastructure lives in this client bundle, so
  // the editor column registers here rather than in a separate plugin (which
  // would have to re-bundle Monaco + re-plumb the worker protocol).
  ctx.inject(['slots'], (editorCtx) => {
    const dispose = editorCtx.slots.inject('corum.editor', () => editorCtx.slots.register(
      { name: 'corum.editor' },
      EditorColumn,
    ))
    return () => { dispose() }
  })
}
