/**
 * 统一会话索引迁移（两套旧索引 → `$CORUM_HOME/sessions.json`）。
 *
 * ## 为什么需要独立一轮
 *
 * 统一模型（`architecture.project.unified-with-type-field`）把两模式的会话索引
 * 收敛成一套。旧形态有**两套键空间不同构**的索引（详见 legacy-index.ts 与
 * session-index.ts 的文件头），机械合并会**静默丢掉 83~92% 的 task 会话索引条目**
 * （实测 217 条 → 180 条蒸发；台账 `bug.unified-index-shape-loses-task-sessions`）。
 * 故本模块**显式**做一次收敛，并把结果**如实报告**（不静默丢弃）。
 *
 * ## 死条目处置（用户 2026-09-15 裁定：「直接丢弃即可」）
 *
 * 「死条目」= 会话本体够不着的条目。实测 217 条里 **36 条**属于此类
 * （30 条因 cwd 目录被删，如 `/tmp/corum-probe3` 20 条）。用户裁定直接丢弃：
 * 这些都是验证/试验残留，无实际意义 ⇒ **不写进新索引**，但**计数落进迁移报告**
 * （不静默）。
 *
 * ## 幂等与安全
 *
 * - **幂等**：已存在 `sessions.json` 时按 sessionId **合并**（新条目补齐、既有条目
 *   保留），可重复跑；
 * - **备份**：首次真实迁移前把旧索引**逐文件拷**进 `$CORUM_HOME/backups/`；
 * - **旧文件保留**：迁移**不删**任何旧索引文件（回滚安全网；它们自此成为迁移前
 *   残影，不再被读路径使用）。
 *
 * @module @corum/corum-agent/session-index-migration
 */

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { corumHome, readSessionIndex, writeSessionIndex, sessionIndexPath } from './session-index.ts'
import type { SessionIndexEntry } from './session-index.ts'
// 工作区身份（L0 助手）：项目模式剥离后由 workspace-identity.ts 承接。
import { canonicalWorkspaceKey } from './workspace-identity.ts'
import {
  LEGACY_TASK_PROJECT_ID,
  encodeCwdForSessionsDir,
  legacyProjectIndexPath,
  legacyTaskIndexPath,
  listLegacyProjectIds,
  readLegacyIndexes,
} from './legacy-index.ts'
import type { LegacySession } from './legacy-index.ts'

export interface SessionIndexMigrationResult {
  /** 备份目录（本轮真实拷贝的路径；无需迁移/已备份时为 null）。 */
  backupDir: string | null
  /** 从旧 task 索引归入的条目数。 */
  fromTaskIndex: number
  /** 从旧 project 索引归入的条目数。 */
  fromProjectIndex: number
  /** 因 cwd 不可达（目录已删）丢弃的条目数 —— 用户裁定「直接丢弃」。 */
  droppedCwdGone: number
  /** 因会话本体缺失丢弃的条目数。 */
  droppedBodyMissing: number
  /** 因记录不完整（缺 cwd/profileId）丢弃的条目数。 */
  droppedMalformed: number
  /** 因 project 侧拼接键无法拆出 profileId 而归入「未知 profile」的条目数（保留）。 */
  profileIdUnknown: number;
  /** 迁移后索引总条目数。 */
  total: number
}

/**
 * 执行统一索引迁移（幂等可重跑）。
 *
 * @param log - 可选日志回调（host 侧传 ctx.logger.info）。
 * @param home - CORUM_HOME（测试注入用；缺省读环境）。
 */
export function migrateSessionIndex(
  log?: (msg: string) => void,
  home: string = corumHome(),
): SessionIndexMigrationResult {
  const say = log ?? ((_msg: string) => {})
  const result: SessionIndexMigrationResult = {
    backupDir: null,
    fromTaskIndex: 0,
    fromProjectIndex: 0,
    droppedCwdGone: 0,
    droppedBodyMissing: 0,
    droppedMalformed: 0,
    profileIdUnknown: 0,
    total: 0,
  }

  const legacy = readLegacyIndexes(home)
  const current = readSessionIndex()
  let changed = false

  // 先**干跑**：算出哪些条目真的会被归入（不动盘）。
  // 备份只在确有迁移动作时做——旧实现每次启动都拷一份逐字节相同的快照，
  // 备份目录只增不减（同 bug.project-migration-backs-up-unconditionally-on-every-startup）。
  const incoming: Array<{ legacy: LegacySession; entry: SessionIndexEntry }> = []
  for (const s of legacy) {
    const verdict = classifyLegacy(s, home)
    if (verdict.kind === 'drop') {
      if (verdict.reason === 'cwd-gone') result.droppedCwdGone += 1
      else if (verdict.reason === 'body-missing') result.droppedBodyMissing += 1
      else result.droppedMalformed += 1
      continue
    }
    // 已有条目**不覆盖**（新索引更权威：它可能已带正确的 type/laneKey）。
    if (current[s.sessionId] !== undefined) continue
    incoming.push({ legacy: s, entry: verdict.entry })
  }

  // 备份（只在确有新条目要落盘、且确有旧索引文件时做一次）。
  const legacyFiles = legacyIndexFiles(home)
  if (incoming.length > 0 && legacyFiles.length > 0) {
    const backupDir = join(home, 'backups', `session-index-migration-${stamp()}`)
    try {
      mkdirSync(backupDir, { recursive: true })
      for (const f of legacyFiles) {
        cpSync(f, join(backupDir, backupFileName(f)))
      }
      result.backupDir = backupDir
      say(`session-index-migration: 备份 ${legacyFiles.length} 个旧索引 → ${backupDir}`)
    } catch (error) {
      say(`session-index-migration: 备份失败（继续迁移）：${String(error)}`)
    }
  }

  for (const { legacy: s, entry } of incoming) {
    current[s.sessionId] = entry
    if (entry.profileId === '') result.profileIdUnknown += 1
    if (s.origin === 'task-index') result.fromTaskIndex += 1
    else result.fromProjectIndex += 1
    changed = true
  }

  result.total = Object.keys(current).length
  // 只在确有变化时落盘（无事可做 ⇒ 零写入，避免每次启动重写 217 条）。
  if (changed || !existsSync(sessionIndexPathFor(home))) {
    writeSessionIndexAt(home, current)
  }
  say(
    `session-index-migration: task=${result.fromTaskIndex} project=${result.fromProjectIndex} `
    + `dropped[cwd-gone=${result.droppedCwdGone} body-missing=${result.droppedBodyMissing} malformed=${result.droppedMalformed}] `
    + `total=${result.total}`,
  )
  return result
}

/** 条目裁定：保留（归一后的 entry）或丢弃（带原因）。 */
function classifyLegacy(
  s: LegacySession,
  home: string,
): { kind: 'keep'; entry: SessionIndexEntry } | { kind: 'drop'; reason: 'cwd-gone' | 'body-missing' | 'malformed' } {
  const { cwd, profileId } = s.entry
  if (cwd === '' || profileId === '') return { kind: 'drop', reason: 'malformed' }
  // ① cwd 目录仍在？（统一模型下身份由 cwd 决定，目录没了就无从归属）
  if (!existsSync(cwd)) return { kind: 'drop', reason: 'cwd-gone' }
  // ② 会话本体仍在？（索引是「到本体的指针」，本体没了就是死条目）
  const body = join(home, 'sessions', encodeCwdForSessionsDir(cwd), s.sessionId)
  if (!existsSync(body)) return { kind: 'drop', reason: 'body-missing' }
  // cwd 归一：以 realpath 形落盘（避免 `/a/b/` 与 `/a/b` 在后续比较里被当成两个工作区）。
  const canonical = canonicalWorkspaceKey(cwd) ?? cwd
  return {
    kind: 'keep',
    entry: {
      cwd: canonical,
      profileId,
      type: s.entry.type,
      ...(s.entry.laneKey !== undefined && s.entry.laneKey !== '' ? { laneKey: s.entry.laneKey } : {}),
    },
  }
}

/** 值得备份的旧索引文件清单（存在才算）。 */
function legacyIndexFiles(home: string): string[] {
  const files: string[] = []
  const taskPath = legacyTaskIndexPath(home)
  if (existsSync(taskPath)) files.push(taskPath)
  for (const projectId of listLegacyProjectIds(home)) {
    if (projectId === LEGACY_TASK_PROJECT_ID) continue
    const p = legacyProjectIndexPath(projectId, home)
    if (existsSync(p)) files.push(p)
  }
  return files
}

/** 时间戳目录名（同毫秒重跑不覆盖）。 */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * 旧索引文件在备份目录里的**扁平文件名**。
 *
 * ⚠️ 必须把 `/` **和** `\`、`:` 都换掉（2026-10-21 三平台门禁咬出）：只用
 * `replaceAll('/', '_')` 时，Windows 的绝对路径 `C:\…\task-sessions.json` 会把整条路径
 * 连同盘符冒号带进文件名 ∈ NTFS 非法字符 ⇒ `cpSync` 抛错，而外层 `catch` 只是「备份失败
 * 继续迁移」⇒ `backupDir` 静默变 null（**备份悄悄没落**，比直接报错更危险）。
 * POSIX 上 `\`/`:` 本就不出现在路径里 ⇒ 输出逐字不变。
 */
function backupFileName(path: string): string {
  return path.replace(/[/\\:]/g, '_')
}

/** 索引路径按注入的 home 解析（与 session-index.ts 的默认路径同构）。 */
function sessionIndexPathFor(home: string): string {
  return join(home, 'sessions.json')
}

/** 按注入的 home 原子落盘（避免测试/迁移时依赖进程级 CORUM_HOME）。 */
function writeSessionIndexAt(home: string, sessions: Record<string, SessionIndexEntry>): void {
  const path = sessionIndexPathFor(home)
  mkdirSync(home, { recursive: true })
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, JSON.stringify({ version: 2, sessions }, null, 2))
  try {
    renameSync(tmp, path)
  } catch (error) {
    // EXDEV（跨设备）兜底：先拷后删。其余错误如实上抛（别把失败伪装成成功）。
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    writeFileSync(path, readFileSync(tmp))
    rmSync(tmp, { force: true })
  }
}
