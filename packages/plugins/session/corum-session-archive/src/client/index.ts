/** Browser plugin owning session-archive save/import state over the desktop native bridge. */

import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import { SessionArchiveController } from './controller.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionArchive: SessionArchiveController
  }
}

export const inject = ['slots', 'locale']

/**
 * Provide the archive controller (for programmatic use) without mounting any UI.
 * The save/delete/import UI entries have been removed per user request.
 * @param ctx - browser context carrying slots and locale services.
 */
export function apply(ctx: ClientContext): void {
  const controller = new SessionArchiveController()
  ctx.provide('sessionArchive', controller)
  ctx.effect(() => async () => { await controller.dispose() }, 'session-archive: bridge operation lifecycle')
}
