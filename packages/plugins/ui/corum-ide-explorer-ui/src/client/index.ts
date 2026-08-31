/**
 * @corum/corum-ide-explorer-ui client half — the IDE resource manager (design.pen ④,
 * 210px file tree). Registers the file tree into the shell's `corum.explorer`
 * slot. Data comes from the host fs RPC (`corumFs/list` Typert Remote, rooted at
 * the host project cwd — see corum-desktop/src/host/corum-fs.ts) via the official
 * ctx.connection.rpc (`call('/api', 'corumFs/list', { args: { path } })`).
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@corum/corum-ide-ui/client'
import { FileExplorer, type FsEntry } from './FileExplorer.tsx'
import type { FileExplorerInjected } from './FileExplorer.tsx'

export type { FileExplorerInjected } from './FileExplorer.tsx'

/** Required services: the slots registry + the connection rpc face + the layout face (ctx.layout.closeRegion)。 */
export const inject = ['slots', 'connection', 'layout']

/**
 * Client plugin body: register the file tree into corum.explorer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(
    () => ctx.slots.inject('corum.explorer', () => ctx.slots.register(
      {
        name: 'corum.explorer',
        inject: (): FileExplorerInjected => ({
          generation: connection.generation,
          closeRegion: () => { ctx.layout.closeRegion('corum.explorer') },
          listDir: async (path) => {
            const result = await connection.rpc.call('/api', 'corumFs/list', { args: { path } })
            return result as { ok: boolean; error?: { message?: string }; value?: { entries: FsEntry[] } }
          },
        }),
      },
      FileExplorer,
    )),
    'ide-explorer: corum.explorer file tree',
  )
}
