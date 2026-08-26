/**
 * @corum/corum-ide-sidebar-ui client half — the IDE left column (design.pen ①, 300px).
 * Registers the real session list into the shell's `corum.sidebar` slot:
 * brand header + New Session + search + session rows. Data comes from the
 * runtime object layer (`ctx.sessions`); the slot declaration belongs to
 * @corum/corum-ide-ui (type-only import pulls the SlotMap row).
 *
 * The component reads the sessions standard feed (`ctx.sessions.list`) through
 * useSyncExternalStore — no dependency on the official global-slot props
 * injection (corum.sidebar is a shell slot, not an official global seat).
 */
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ISessions, SessionSearchResultItem } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@corum/corum-ide-ui/client'
import { SessionSidebar } from './SessionSidebar.tsx'

/** Injected actions + the live feed (see the component's prop type). */
export interface SessionSidebarInjected {
  /** The sessions standard feed (list + selection). */
  list: ISessions['list']
  open: (sessionId: SessionId) => void
  startSession: () => void
  search: (query: string, signal: AbortSignal) => Promise<SessionSearchResultItem[]>
  rename: (sessionId: SessionId, title: string) => Promise<void>
}

/** Required services: the slots registry + the runtime object layer. */
export const inject = ['slots', 'sessions', 'workspaces']

/**
 * Client plugin body: register the session list into corum.sidebar.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.inject('corum.sidebar', () => ctx.slots.register(
      {
        name: 'corum.sidebar',
        inject: (): SessionSidebarInjected => ({
          list: ctx.sessions.list,
          open: (sessionId) => { ctx.sessions.open(sessionId) },
          startSession: () => { ctx.workspaces.startSession() },
          search: async (query, signal) => {
            const result = await ctx.sessions.search(query, signal)
            if (!result.ok) throw new Error(result.error.message)
            return result.value.items
          },
          rename: async (sessionId, title) => {
            const binding = ctx.sessions.binding(sessionId)
            if (binding === undefined) throw new Error(`unknown session "${sessionId}"`)
            const result = await binding.session.rename(title)
            if (!result.ok) throw new Error(result.error.message)
          },
        }),
      },
      SessionSidebar,
    )),
    'ide-sidebar: corum.sidebar session list',
  )
}
