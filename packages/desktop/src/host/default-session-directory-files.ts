import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, stat, symlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface DirectoryMove { from: string; to: string }
function key(path: string): string { return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path) }
export function within(path: string, root: string): boolean {
  const suffix = relative(key(root), key(path))
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
}
export function mapDirectoryPath(path: string, moves: DirectoryMove[]): string {
  const move = moves.find(move => within(path, move.from))
  return move ? join(move.to, relative(move.from, path)) : path
}
/** 尚未存在的目标通过最近的真实祖先归一，识别 symlink 和父子目录。 */
export async function canonicalDirectory(path: string): Promise<string> {
  const absolute = resolve(path)
  try { return await realpath(absolute) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return join(await canonicalDirectory(parent), basename(absolute))
  }
}
export async function directoryEntries(path: string): Promise<string[]> {
  try { return await readdir(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** 不跟随链接；逐文件校验，拒绝设备/socket 等不可保留条目。 */
export async function copyDirectoryChecked(from: string, to: string, moves: DirectoryMove[]): Promise<void> {
  const info = await lstat(from)
  if (info.isSymbolicLink()) {
    const link = await readlink(from)
    const oldTarget = resolve(dirname(from), link)
    const target = mapDirectoryPath(oldTarget, moves)
    let type: 'junction' | 'file' | undefined
    if (process.platform === 'win32') type = (await stat(from)).isDirectory() ? 'junction' : 'file'
    const newLink = isAbsolute(link) || target === oldTarget ? target : relative(dirname(to), target)
    await symlink(newLink, to, type)
    if (await readlink(to) !== newLink) throw new Error(`链接校验失败：${from}`)
  } else if (info.isDirectory()) {
    await mkdir(to, { mode: info.mode })
    for (const name of await readdir(from)) await copyDirectoryChecked(join(from, name), join(to, name), moves)
    await chmod(to, info.mode)
  } else if (info.isFile()) {
    await copyFile(from, to)
    await chmod(to, info.mode)
    const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
    if (await digest(from) !== await digest(to)) throw new Error(`复制校验失败：${from}`)
  } else throw new Error(`不支持迁移此文件类型：${from}`)
}

/** 只处理 Git 的结构指针；不修改用户文件或历史提交。 */
export async function repairDirectoryGit(root: string, moves: DirectoryMove[]): Promise<void> {
  const repositories: string[] = []
  async function walk(path: string, inGit: boolean): Promise<void> {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return
    const name = basename(path)
    if (name === '.git') repositories.push(dirname(path))
    if (info.isDirectory()) {
      for (const child of await readdir(path)) await walk(join(path, child), inGit || name === '.git')
      return
    }
    if (!info.isFile()) return
    if (name === '.git' || (inGit && (name === 'gitdir' || name === 'commondir'))) {
      const original = await readFile(path, 'utf8')
      const prefix = name === '.git' ? 'gitdir: ' : ''
      if (prefix && !original.startsWith(prefix)) throw new Error(`无效 Git 指针：${path}`)
      const pointer = original.slice(prefix.length).trim()
      if (isAbsolute(pointer)) {
        const mapped = mapDirectoryPath(pointer, moves)
        if (mapped === pointer && !moves.some(move => within(pointer, move.to))) throw new Error(`Git 指针指向管理范围外，无法安全迁移：${path}`)
        // Windows 的隐藏 .git 文件不能用 O_TRUNC 重新打开；r+ 保留属性并显式截断。
        const handle = await open(path, 'r+')
        try {
          const contents = `${prefix}${mapped}\n`
          await handle.writeFile(contents)
          await handle.truncate(Buffer.byteLength(contents))
        } finally { await handle.close() }
      }
    }
  }
  await walk(root, false)
  for (const cwd of repositories) {
    const git = (args: string[]) => execFileSync('git', ['-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
    let configured = ''
    try { configured = git(['config', '--get', 'core.worktree']).trim() } catch { /* unset */ }
    if (configured && isAbsolute(configured)) git(['config', 'core.worktree', mapDirectoryPath(configured, moves)])
    const actual = git(['rev-parse', '--show-toplevel']).trim()
    if (key(actual) !== key(cwd)) throw new Error(`Git worktree 校验失败：${cwd}`)
    const listing = git(['worktree', 'list', '--porcelain'])
    for (const line of listing.split('\n')) {
      if (line.startsWith('worktree ') && moves.some(move => within(line.slice(9), move.from))) throw new Error(`Git worktree 仍引用旧路径：${cwd}`)
    }
  }
}
