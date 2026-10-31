import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireDefaultSessionDirectoryGuard } from './default-session-directory-lock.ts'
import { recordDefaultSessionDirectoryFailure } from './default-session-directory-status.ts'

/** 系统 Node 封门后或挂树前撤销本次请求；读 phase/ID、删除和结果提交都持同一 guard。 */
export async function recoverDefaultSessionDirectoryAfterExit(home: string, error: string, migrationId: string): Promise<void> {
  if (!migrationId) throw new Error('缺少本次迁移标识，不能取消未知请求')
  const release = await acquireDefaultSessionDirectoryGuard(home)
  try {
    const path = join(home, 'default-session-directory-migration.json')
    const pending = JSON.parse(await readFile(path, 'utf8')) as { id?: string; phase?: string }
    if (pending.id !== migrationId) throw new Error('迁移标识 ID 已改变，不能取消其它请求')
    if (pending.phase !== 'requested') throw new Error('迁移已开始，不能按停机失败撤销，请重试恢复')
    await rm(path)
    await recordDefaultSessionDirectoryFailure(home, error)
  } finally { await release() }
}
