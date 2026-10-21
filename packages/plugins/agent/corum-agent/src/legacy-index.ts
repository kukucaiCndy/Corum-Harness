/**
 * 旧会话索引读取（**只读**，供迁移使用）。
 *
 * 统一模型（`architecture.project.unified-with-type-field`）之前，两模式各有一套
 * 键空间不同构的索引。本模块把它们**读成统一形态**，交给迁移层合并进
 * `$CORUM_HOME/sessions.json`（见 session-index.ts）。本模块**只读不写**：
 * 旧文件在迁移后保留为迁移前残影（不删——回滚安全网）。
 *
 * ## 两套旧形态
 *
 * **① task 侧**：`$CORUM_HOME/projects/task/corum/task-sessions.json`
 * 键 = `sessionId`，值 = `{cwd, profileId}` ⇒ 已是统一形态的键空间，
 * 唯一缺的是 `type`（恒 `task`）。
 *
 * **② project 侧**：`$CORUM_HOME/projects/<id>/corum/sessions.json`
 * 键 = `"<profileId><laneKey>"`（如 `devgeneral`、`pmgeneral`），
 * 值 = `sessionId` ⇒ **必须用 projectId 才能反查出 cwd**（值里没有 cwd）。
 * 故本模块需按索引目录反查 project.json 拿 cwd。
 *
 * ⚠️ **`<profileId><laneKey>` 是拼接键，理论上不可逆拆分**（profileId 与 laneKey
 * 都允许连字符/字母，无分隔符）。实测存量键形如 `pmgeneral` / `devui` /
 * `devreq-<uuid>:ui`（需求段带 `:` 分隔符）。因此本模块**不猜拆键**：
 * 改成**正向枚举**——用索引条目里的 projectId 查项目组，拿真实 profileId 列表去
 * 匹配键前缀；匹配不上时**整键当 laneKey、profileId 标记为空**由迁移层决定
 * （宁可让迁移层看见异常，也不静默编造一个错的 profileId）。
 *
 * @module @corum/corum-agent/legacy-index
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { corumHome } from './session-index.ts'
import type { SessionIndexEntry } from './session-index.ts'
// 工作区身份（L0 助手）：项目模式剥离后由 workspace-identity.ts 承接。
import { canonicalWorkspaceKey, isValidProjectId } from './workspace-identity.ts'

/** 一条从旧索引读出的会话（统一形态 + 来源标记）。 */
export interface LegacySession {
  sessionId: string
  entry: SessionIndexEntry
  /** 来源形态（诊断/报告用）。 */
  origin: 'task-index' | 'project-index'
  /** project 侧来源时的 projectId（task 侧为 undefined）。 */
  projectId?: string
}

/** 旧 task 伪项目 id（`$CORUM_HOME/projects/task/`）。 */
export const LEGACY_TASK_PROJECT_ID = 'task'

/** 旧 task 索引文件路径。 */
export function legacyTaskIndexPath(home: string = corumHome()): string {
  return join(home, 'projects', LEGACY_TASK_PROJECT_ID, 'corum', 'task-sessions.json')
}

/** 旧 project 索引文件路径。 */
export function legacyProjectIndexPath(projectId: string, home: string = corumHome()): string {
  return join(home, 'projects', projectId, 'corum', 'sessions.json')
}

/** 读 JSON（失败 = undefined；绝不 throw）。 */
function readJsonSafe(path: string): unknown {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 读旧 task 索引（统一形态键空间：`sessionId → {cwd, profileId}`）。
 *
 * 每条补 `type: 'task'`（该索引里的会话按定义都是任务模式创建的）。
 */
export function readLegacyTaskIndex(home: string = corumHome()): LegacySession[] {
  const raw = readJsonSafe(legacyTaskIndexPath(home))
  if (raw === null || typeof raw !== 'object') return []
  const out: LegacySession[] = []
  for (const [sessionId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    const cwd = typeof v.cwd === 'string' ? v.cwd : undefined
    const profileId = typeof v.profileId === 'string' ? v.profileId : undefined
    // cwd 缺失的条目无法归入任何工作区（统一模型下身份由 cwd 决定）⇒ 丢弃。
    if (cwd === undefined || cwd === '' || profileId === undefined || profileId === '') continue
    out.push({
      sessionId,
      entry: { cwd, profileId, type: 'task' },
      origin: 'task-index',
    })
  }
  return out
}

/**
 * 读旧 project 索引（`"<profileId><laneKey>" → sessionId`）。
 *
 * profileId 用**正向枚举**拆：拿该项目的项目组成员 profileId 逐个试前缀匹配
 * （长的先试，避免 `dev` 抢先匹配 `dev-lead`）；都不匹配则 profileId 留空、
 * 整键作 laneKey（迁移层据此判断「这条需要人工/规则裁定」）。
 *
 * @param projectId - 项目 id（用于反查 cwd 与项目组）。
 * @param home - CORUM_HOME。
 */
export function readLegacyProjectIndex(projectId: string, home: string = corumHome()): LegacySession[] {
  const raw = readJsonSafe(legacyProjectIndexPath(projectId, home))
  if (raw === null || typeof raw !== 'object') return []
  const cwd = readLegacyProjectCwd(projectId, home)
  if (cwd === undefined) return [] // cwd 失联/索引缺失 ⇒ 无法定身份，交由迁移层按「死条目」处理
  const knownProfiles = readProjectMemberProfileIds(projectId, cwd)
  const out: LegacySession[] = []
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string' || value === '') continue
    // 优先从 sessionId 反解（可信度最高）：project 泳道的 sessionId 形如
    // `corum-proj<projectId>-agent<profileId>-lane<laneKey>-<rand>`
    // （agent-service.ts:1016 的构造式，`lane` 段在更早版本里叫 `type`）。
    // 反解不出才退回拆复合键（见 splitCompositeKey 的保守策略）。
    const parsed = parseProjectSessionId(value, projectId)
    const split = parsed === undefined ? splitCompositeKey(key, knownProfiles) : undefined
    const profileId = parsed?.profileId ?? split?.profileId ?? ''
    const laneKey = parsed?.laneKey ?? split?.laneKey ?? ''
    out.push({
      sessionId: value,
      entry: {
        cwd,
        profileId,
        type: 'project',
        ...(laneKey !== '' ? { laneKey } : {}),
      },
      origin: 'project-index',
      projectId,
    })
  }
  return out
}

/**
 * 从 project 泳道的 sessionId 反解 projectId / profileId / laneKey。
 *
 * 构造式（`agent-service.ts:1016`）：
 *   `corum-proj<projectId>-agent<profileId>-lane<slugLaneKey>-<8位随机hex>`
 * 更早版本的第二段分隔词是 `type` 而非 `lane`（存量实测：
 * `corum-projproject-agentpm-typegeneral-2bc71598`），两种都认。
 *
 * **为什么优先用它**：sessionId 是**创建时按真实值直接拼的**，而复合键
 * `<profileId><laneKey>` 是无分隔符拼接、只能猜。前者可信度更高。
 *
 * `projectId` 由调用方给出（来自索引目录名），故不用猜 projectId 边界——这正是
 * 本函数能可靠工作的前提（projectId 可含连字符，独立解析会有歧义）。
 *
 * @returns 解析结果；不形如 project 泳道 / projectId 不匹配 ⇒ undefined。
 */
export function parseProjectSessionId(
  sessionId: string,
  projectId: string,
): { projectId: string; profileId: string; laneKey: string } | undefined {
  const prefix = `corum-proj${projectId}-agent`
  if (!sessionId.startsWith(prefix)) return undefined
  const rest = sessionId.slice(prefix.length)
  // `<profileId>-(lane|type)<laneKey>-<rand>`
  const m = /^(.+?)-(?:lane|type)(.*)-[0-9a-f]+$/.exec(rest)
  if (m === null) return undefined
  const profileId = m[1] ?? ''
  const laneKey = m[2] ?? ''
  if (profileId === '') return undefined
  return { projectId, profileId, laneKey }
}

/**
 * 拆 `"<profileId><laneKey>"` 拼接键。
 *
 * **不靠猜**：用已知 profileId 集合做前缀匹配（长前缀优先）。匹配不上的键
 * **整键当 laneKey**、profileId 留空——这是有意的保守：编造一个错的 profileId
 * 比留空更糟（错的 profileId 会让会话在错误的角色下显示）。
 */
export function splitCompositeKey(
  key: string,
  knownProfiles: readonly string[],
): { profileId: string; laneKey: string } {
  const candidates = [...knownProfiles]
    .filter(p => p !== '' && key.startsWith(p))
    // 长前缀优先：`dev-lead` 必须先于 `dev` 匹配，否则 `dev-leadx` 会被拆成 `dev` + `-leadx`。
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
  const hit = candidates[0]
  if (hit === undefined) return { profileId: '', laneKey: key }
  return { profileId: hit, laneKey: key.slice(hit.length) }
}

/** 读项目条目里的 cwd（索引 project.json；读不到返回 undefined）。 */
function readLegacyProjectCwd(projectId: string, home: string): string | undefined {
  const raw = readJsonSafe(join(home, 'projects', projectId, 'project.json'))
  if (raw === null || typeof raw !== 'object') return undefined
  const cwd = (raw as Record<string, unknown>).cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * 读一个项目的成员 profileId 集合（项目侧 ProjectInfo 的 group；兜底索引残留 group）。
 * 读不到时返回空集合 ⇒ 拆键退化为「整键作 laneKey」（保守，不编造）。
 */
function readProjectMemberProfileIds(projectId: string, cwd: string): string[] {
  const fromInfo = readJsonSafe(join(cwd, '.corum', 'project', 'project.json'))
  const infoMembers = membersOf(fromInfo)
  if (infoMembers.length > 0) return infoMembers
  return membersOf(readJsonSafe(join(corumHome(), 'projects', projectId, 'project.json')))
}

/** 从 project.json 形里抽 group.members[].profileId。 */
function membersOf(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object') return []
  const group = (raw as Record<string, unknown>).group
  if (group === null || typeof group !== 'object') return []
  const members = (group as Record<string, unknown>).members
  if (!Array.isArray(members)) return []
  return members
    .map(m => (m !== null && typeof m === 'object' ? (m as Record<string, unknown>).profileId : undefined))
    .filter((p): p is string => typeof p === 'string' && p !== '')
}

/** 列出 `$CORUM_HOME/projects/` 下的全部项目 id（含伪 task 目录）。 */
export function listLegacyProjectIds(home: string = corumHome()): string[] {
  const root = join(home, 'projects')
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && isValidProjectId(d.name))
      .map(d => d.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 读全部旧索引（task + 每个 project），合并成统一形态列表。
 *
 * 同一 sessionId 在多来源出现时**保留先读到的**（task 优先：task 索引的
 * `{cwd, profileId}` 是直接记录，project 侧的拼接键是推断出来的，前者更可信）。
 */
export function readLegacyIndexes(home: string = corumHome()): LegacySession[] {
  const byId = new Map<string, LegacySession>()
  for (const s of readLegacyTaskIndex(home)) byId.set(s.sessionId, s)
  for (const projectId of listLegacyProjectIds(home)) {
    if (projectId === LEGACY_TASK_PROJECT_ID) continue // 伪项目目录，已按 task 索引读过
    for (const s of readLegacyProjectIndex(projectId, home)) {
      if (!byId.has(s.sessionId)) byId.set(s.sessionId, s)
    }
  }
  return [...byId.values()]
}

/** 会话本体所在目录（`$CORUM_HOME/sessions/--<cwd 编码>--/<sessionId>/`）。 */
export function sessionBodyDir(cwd: string, sessionId: string, home: string = corumHome()): string {
  return join(home, 'sessions', encodeCwdForSessionsDir(cwd), sessionId)
}

/**
 * cwd → 会话目录名编码（对齐官方 `session-persistence-jsonl` 的 `projectKey`：
 * `--` + 去根分隔符后把 `/`、`\`、`:` **都**换成 `-` + `--`）。
 *
 * ⚠️ 为什么不能只处理 `/`（2026-10-21 三平台门禁咬出）：
 *   - Windows 的 cwd 是 `C:\Users\…`，只换 `/` 会产出 `--C:\Users\…--` —— **含 `:`**，
 *     NTFS 非法字符 ⇒ `mkdir` 直接 ENOENT（`corum-agent` 的 8 条迁移用例全挂在这一步）。
 *   - 官方 `projectKey` 把 `:` 也当分隔符（盘符不落进名字里），本函数与它对账，
 *     Windows 上的会话目录名才能和官方落盘形态一致。
 * 仅去「根分隔符」（`^[\\/]+`）而非只去 `/`：Windows 绝对路径以盘符开头，本来就没有
 * 前导分隔符，正则在那边不匹配、行为不变；POSIX 上首字符 `/` 照旧被剥掉 ⇒
 * **POSIX 落盘名逐字不变**（不会把历史会话目录改名）。
 *
 * 与官方 `projectKey` 的**刻意差异**：官方还会把空格等非 `[A-Za-z0-9._-]` 字符转义成
 * `~XXXX`（如 `/tmp/x y` ⇒ `--tmp-x~0020y--`）。这里**不**跟——那样会改掉 POSIX 上
 * 所有含空格/中文路径的既存会话目录名（等于让历史会话失联）。本函数只保证「名字合法、
 * 三平台都不含非法字符」，不对账官方的转义细节。
 */
export function encodeCwdForSessionsDir(cwd: string): string {
  const key = canonicalWorkspaceKey(cwd) ?? cwd
  return `--${key.replace(/^[\\/]+/, '').replace(/[/\\:]/g, '-')}--`
}
