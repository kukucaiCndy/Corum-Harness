/** Browser plugin owning session-archive save/import state over the desktop native bridge. */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SessionArchiveController } from './controller.ts'
import { SessionArchiveDeleteHeaderAction, SessionArchiveHeaderAction } from './HeaderAction.tsx'
import type { SessionArchiveSaveInjected } from './SaveDialog.tsx'
import type { SessionArchiveDeleteInjected } from './DeleteDialog.tsx'
import { SessionArchiveImportRow, type SessionArchiveImportInjected } from './ImportRow.tsx'
import { en, NS, zh, type SessionArchiveKey } from './locales.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionArchive: SessionArchiveController
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'session-archive': SessionArchiveKey
  }
}

export type {
  SessionArchiveDeleteEntry,
  SessionArchiveImportEntry,
  SessionArchiveSaveEntry,
  SessionArchiveState,
} from './controller.ts'

export const inject = ['slots', 'locale']

/**
 * Provide the archive controller and mount the Session Header save action
 * plus the General-settings import row.
 * @param ctx - browser context carrying slots and locale services.
 */
export function apply(ctx: ClientContext): void {
  const controller = new SessionArchiveController()
  ctx.provide('sessionArchive', controller)
  ctx.effect(() => async () => { await controller.dispose() }, 'session-archive: bridge operation lifecycle')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-archive: dictionaries')

  const saveInjected = (): SessionArchiveSaveInjected => ({
    hooks: { sessionArchive: controller.store },
    save: (sessionId: SessionId) => controller.save(sessionId),
    dismiss: (sessionId: SessionId) => { controller.dismissSave(sessionId) },
  })

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-archive-save',
    locale: NS,
    inject: saveInjected,
  }, SessionArchiveHeaderAction))

  const deleteInjected = (): SessionArchiveDeleteInjected => ({
    hooks: { sessionArchive: controller.store },
    deleteSession: (sessionId: SessionId) => controller.deleteSession(sessionId),
    dismiss: (sessionId: SessionId) => { controller.dismissDelete(sessionId) },
  })

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-archive-delete',
    locale: NS,
    inject: deleteInjected,
  }, SessionArchiveDeleteHeaderAction))

  const importInjected = (): SessionArchiveImportInjected => ({
    hooks: { sessionArchive: controller.store },
    desktopAvailable: () => controller.desktopAvailable,
    requestImport: () => controller.import(),
    dismissImport: () => { controller.dismissImport() },
  })

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'session-archive-import',
    locale: NS,
    inject: importInjected,
  }, SessionArchiveImportRow))
}

export type { SessionArchiveSaveInjected, SessionArchiveSaveDialogProps } from './SaveDialog.tsx'
export type { SessionArchiveDeleteInjected, SessionArchiveDeleteDialogProps } from './DeleteDialog.tsx'
export type { SessionArchiveImportInjected, SessionArchiveImportRowProps } from './ImportRow.tsx'
