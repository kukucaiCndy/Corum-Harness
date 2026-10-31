import { createHash } from 'node:crypto'
import { mkdir, open, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 专用 OS guard：进程退出即释放，永久 guard 文件不 unlink，PID 文件不参与排他。 */
export async function acquireDefaultSessionDirectoryGuard(home: string): Promise<() => Promise<void>> {
  await mkdir(home, { recursive: true })
  const path = join(await realpath(home), 'default-session-directory-migration.guard')
  const busy = () => new Error('另一进程正在迁移默认会话目录')
  if (process.platform === 'win32') {
    // 沿官方 JSONL 的 semaphore 模式；Mutex 会被同线程并发 Promise 重入。
    const library = (await import('koffi')).default.load('kernel32.dll')
    const create = library.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16'])
    const wait = library.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint'])
    const release = library.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*'])
    const close = library.func('__stdcall', 'CloseHandle', 'int', ['intptr'])
    const name = `Local\\corum-directory-migration-${createHash('sha256').update(path.toLowerCase()).digest('hex')}`
    const handle = create(null, 1, 1, name)
    if (!handle) throw new Error('无法建立默认目录迁移 OS guard')
    if (wait(handle, 0) !== 0) { close(handle); throw busy() }
    return async () => {
      const released = release(handle, 1, null), closed = close(handle)
      if (!released || !closed) throw new Error('无法释放默认目录迁移 OS guard')
    }
  }
  const handle = await open(path, 'a+')
  try {
    // 使用已安装官方 JSONL 的依赖 resolver，复用其 node-addon-system@0.1.2。
    const localRequire = createRequire(import.meta.url)
    const jsonlRequire = createRequire(localRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl/package.json'))
    const { tryLockExclusive } = await import(pathToFileURL(jsonlRequire.resolve('@deepseek-ai/node-addon-system/flock')).href) as { tryLockExclusive(fd: number): Promise<void> }
    try { await tryLockExclusive(handle.fd) }
    catch (error) { if (['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw busy(); throw error }
    const held = await handle.stat({ bigint: true }), current = await stat(path, { bigint: true })
    if (held.ino !== current.ino || held.dev !== current.dev) throw busy()
    return () => handle.close()
  } catch (error) { await handle.close(); throw error }
}
