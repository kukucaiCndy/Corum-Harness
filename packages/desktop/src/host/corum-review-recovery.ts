import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

type Image = { content: string; mode: number } | null
interface RecoveryFile { path: string; before: Image; after: Image }
interface RecoveryBatch { id: string; groupId: string; workspace: string; createdAt: number; files: RecoveryFile[] }
export interface RecoverySummary { id: string; groupId: string; workspace: string; createdAt: number; paths: string[] }
export interface RecoveryResult {
  restored: { path: string; baseline: Buffer | null }[]
  failed: { path: string; message: string }[]
  recoveryId?: string
  workspace?: string
}
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** Host 私有快照：先落盘再撤销；恢复按内容和存在性校验，绝不覆盖后续修改。 */
export class ReviewRecoveryStore {
  private readonly root: string
  private readonly cache = new Map<string, RecoveryBatch[]>()
  constructor(root: string) { this.root = root }

  private directory(sessionId: string): string {
    return join(this.root, createHash('sha256').update(sessionId).digest('hex'))
  }

  private batches(sessionId: string): RecoveryBatch[] {
    const cached = this.cache.get(sessionId)
    if (cached) return cached
    const dir = this.directory(sessionId)
    const batches: RecoveryBatch[] = []
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!/^[\da-f-]{36}\.json$/.test(name)) continue
        const batch = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RecoveryBatch
        if (batch.id + '.json' !== name || !Array.isArray(batch.files) || typeof batch.workspace !== 'string') throw new Error('恢复记录损坏，已停止操作')
        if (batch.files.length > 0) batches.push(batch)
      }
    }
    batches.sort((a, b) => b.createdAt - a.createdAt)
    this.cache.set(sessionId, batches)
    return batches
  }

  private save(sessionId: string, batch: RecoveryBatch): void {
    const dir = this.directory(sessionId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, batch.id + '.json')
    const temp = file + '.tmp'
    try {
      writeFileSync(temp, JSON.stringify(batch), { mode: 0o600, flush: true })
      renameSync(temp, file)
    } finally {
      if (existsSync(temp)) rmSync(temp)
    }
  }

  private target(workspace: string, path: string): string {
    const root = realpathSync(workspace)
    const file = resolve(root, path)
    if (isAbsolute(path) || file === root || !file.startsWith(root + sep)) throw new Error('文件路径超出工作区')
    let parent = dirname(file)
    while (!existsSync(parent) && parent !== root) parent = dirname(parent)
    const realParent = realpathSync(parent)
    if (realParent !== root && !realParent.startsWith(root + sep)) throw new Error('文件目录指向工作区外部')
    return file
  }

  private image(file: string): Image {
    let stat
    try { stat = lstatSync(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('仅支持普通文件，不能操作目录或 symlink')
    if (stat.size > MAX_IMAGE_BYTES) throw new Error('文件过大，无法安全保存恢复快照，未执行撤销')
    return { content: readFileSync(file).toString('base64'), mode: stat.mode & 0o777 }
  }

  private same(a: Image, b: Image): boolean { return a === null ? b === null : b !== null && a.content === b.content }

  private write(file: string, image: Image): void {
    if (image === null) { rmSync(file, { force: true }); return }
    mkdirSync(dirname(file), { recursive: true })
    const temp = join(dirname(file), `.corum-recovery-${randomUUID()}.tmp`)
    try {
      writeFileSync(temp, Buffer.from(image.content, 'base64'), { mode: image.mode, flush: true })
      chmodSync(temp, image.mode)
      renameSync(temp, file)
    } finally { if (existsSync(temp)) rmSync(temp) }
  }

  list(sessionId: string): RecoverySummary[] {
    return this.batches(sessionId).filter(batch => batch.files.length > 0).map(batch => ({
      id: batch.id, groupId: batch.groupId ?? batch.id, workspace: batch.workspace, createdAt: batch.createdAt, paths: batch.files.map(file => file.path),
    }))
  }

  rollback(sessionId: string, workspace: string, targets: readonly { path: string; content: Buffer | null }[], groupId?: string): RecoveryResult {
    const result: RecoveryResult = { restored: [], failed: [] }
    const id = randomUUID()
    const batch: RecoveryBatch = { id, groupId: groupId ?? id, workspace, createdAt: Date.now(), files: [] }
    let batches: RecoveryBatch[]
    try { batches = this.batches(sessionId) } catch (error) {
      return { restored: [], failed: targets.map(target => ({ path: target.path, message: String(error) })) }
    }
    for (const target of targets) {
      let entry: RecoveryFile | undefined
      try {
        const file = this.target(workspace, target.path)
        const before = this.image(file)
        const after: Image = target.content === null ? null : { content: target.content.toString('base64'), mode: before?.mode ?? 0o644 }
        entry = { path: target.path, before, after }
        batch.files.push(entry)
        // 保存失败就不改工作区；崩溃后也能从撤销前的检查点找回。
        this.save(sessionId, batch)
        this.write(file, after)
        result.restored.push({ path: target.path, baseline: target.content })
      } catch (error) {
        if (entry) {
          batch.files = batch.files.filter(file => file !== entry)
          try { this.save(sessionId, batch) } catch { /* 保存失败的检查点不会授权覆盖新内容。 */ }
        }
        result.failed.push({ path: target.path, message: error instanceof Error ? error.message : String(error) })
      }
    }
    if (batch.files.length > 0) { batches.unshift(batch); result.recoveryId = batch.id }
    return result
  }

  restore(sessionId: string, recoveryId: string): RecoveryResult {
    const batches = this.batches(sessionId)
    const batch = batches.find(item => item.id === recoveryId)
    const result: RecoveryResult = { restored: [], failed: [] }
    if (!batch) return result
    result.workspace = batch.workspace
    for (const entry of [...batch.files]) {
      try {
        const file = this.target(batch.workspace, entry.path)
        const current = this.image(file)
        // 上次已写回但记录更新中断时，仅消费记录，不重复覆盖文件。
        if (!this.same(current, entry.before)) {
          if (!this.same(current, entry.after)) throw new Error('文件在撤销后已修改，存在冲突，未覆盖当前内容')
          this.write(file, entry.before)
        }
        const previous = batch.files
        batch.files = previous.filter(item => item !== entry)
        try { this.save(sessionId, batch) } catch (error) { batch.files = previous; throw error }
        result.restored.push({ path: entry.path, baseline: entry.after === null ? null : Buffer.from(entry.after.content, 'base64') })
      } catch (error) {
        result.failed.push({ path: entry.path, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return result
  }
}
