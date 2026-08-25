/**
 * @corum/corum-ide-explorer-ui client half — the IDE resource manager (design.pen ④,
 * 210px file tree). Registers the file tree into the shell's `corum.explorer`
 * slot. Data comes from the host fs RPC (`corum.fs.list`, rooted at the host
 * project cwd — see corum-desktop/src/host/connection.ts) via ctx.connection.rpc.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@corum/corum-ide-ui/client'
import { FileExplorer, type FsEntry } from './FileExplorer.tsx'
import type { FileExplorerInjected } from './FileExplorer.tsx'

export type { FileExplorerInjected } from './FileExplorer.tsx'

/** Required services: the slots registry + the connection rpc face. */
export const inject = ['slots', 'connection']

/**
 * Client plugin body: register the file tree into corum.explorer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle & {
    hostDescription: { getSnapshot(): unknown; subscribe(l: () => void): () => void }
  }
  ctx.effect(
    () => ctx.slots.inject('corum.explorer', () => ctx.slots.register(
      {
        name: 'corum.explorer',
        inject: (): FileExplorerInjected => ({
          hostDescription: connection.hostDescription,
          listDir: async (path) => {
            const result = await connection.rpc.call('corum.fs', 'list', { path })
            return result as { ok: boolean; error?: { message?: string }; value?: { entries: FsEntry[] } }
          },
        }),
      },
      FileExplorer,
    )),
    'ide-explorer: corum.explorer file tree',
  )
}
