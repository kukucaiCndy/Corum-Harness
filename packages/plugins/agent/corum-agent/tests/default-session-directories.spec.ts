import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as directories from '../src/default-session-directories.ts'

const homes: string[] = []
function home() { const path = mkdtempSync(join(tmpdir(), 'corum-default-')); homes.push(path); return path }
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('自动会话目录', () => {
  it('按会话 ID 分配独立持久目录，显式目录不登记', async () => {
    const root = home()
    const create = async (cwd: string) => { writeFileSync(join(cwd, 'file.txt'), 'persistent'); return cwd }
    const a = await directories.withDefaultSessionDirectory(root, 'a', undefined, create)
    const b = await directories.withDefaultSessionDirectory(root, 'b', '', create)
    expect(a).not.toBe(b)
    expect(readFileSync(join(a, 'file.txt'), 'utf8')).toBe('persistent')
    await directories.withDefaultSessionDirectory(root, 'explicit', root, async cwd => cwd)
    expect(directories.readDefaultSessionDirectories(root).sessions).toEqual({ a, b })
  })
  it('创建失败不会留下登记或自动目录', async () => {
    const root = home()
    await expect(directories.withDefaultSessionDirectory(root, 'bad', '', async () => { throw new Error('setup failed') })).rejects.toThrow('setup failed')
    expect(directories.readDefaultSessionDirectories(root).sessions).toEqual({})
    expect(existsSync(join(root, 'workspaces', 'bad'))).toBe(false)
  })
  it('拒绝覆盖同名目录或不安全会话 ID', async () => {
    const root = home()
    await directories.withDefaultSessionDirectory(root, 'a', '', async cwd => cwd)
    await expect(directories.withDefaultSessionDirectory(root, 'a', '', async cwd => cwd)).rejects.toThrow()
    await expect(directories.withDefaultSessionDirectory(root, '../bad', '', async cwd => cwd)).rejects.toThrow()
  })
})
