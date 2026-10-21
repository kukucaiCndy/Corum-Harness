/**
 * 统一存储/项目模型验证（§2，2026-09-15）。
 *
 * 覆盖四条不变式与一处**阻断性缺陷的回归**：
 *   ① `bug.unified-index-shape-loses-task-sessions`：两套旧索引收敛**零丢失**
 *      （实测反例：按 project 侧复合键合并 217 条会丢 180 条）；
 *   ② `architecture.project.type-is-authoritative-and-monotonic`：三条不变式
 *      （type 具权威性 / 单调不可降级 / 互斥）与打开创建判定表；
 *   ③ `bug.task-lane-reuse-misses-project-sessions`：泳道复用按**工作区**判；
 *   ④ `observation.storage.task-sessions-orphaned-and-cwd-not-canonical`：
 *      cwd 归一（尾斜杠 / 软链）。
 *
 * CORUM_HOME 指向 /tmp 隔离目录——**不动真实 dev home**。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DEFAULT_PROJECT_TYPE,
  canTransitionProjectType,
  classifyProjectTypeTransition,
  isProjectType,
  projectTypeOf,
} from '../src/workspace-type.ts'
import {
  canonicalWorkspaceKey,
  findWorkspaceEntryByCwd,
  workspaceEntryTypeOf,
  workspaceIndexRoot,
  writeJsonAtomic,
} from '../src/workspace-identity.ts'
import {
  findSession,
  findSessionByLane,
  listSessionsForWorkspace,
  readSessionIndex,
  registerSession,
  writeSessionIndex,
} from '../src/session-index.ts'
import { migrateSessionIndex } from '../src/session-index-migration.ts'
import { readLegacyIndexes, splitCompositeKey, encodeCwdForSessionsDir, parseProjectSessionId } from '../src/legacy-index.ts'

let home: string
let ws: string
const prevCorumHome = process.env.CORUM_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'corum-uq-home-'))
  ws = mkdtempSync(join(tmpdir(), 'corum-uq-ws-'))
  process.env.CORUM_HOME = home
})

afterEach(() => {
  if (prevCorumHome === undefined) delete process.env.CORUM_HOME
  else process.env.CORUM_HOME = prevCorumHome
  rmSync(home, { recursive: true, force: true })
  rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/**
 * 造一个**工作区索引条目**（`$CORUM_HOME/projects/<id>/project.json`）。
 *
 * ⚠️ 2026-09-26 项目模式剥离后，写索引的 `saveProject` 已随项目模式迁到闭源仓
 * Corum-Harness-Project。但**磁盘契约两仓共用**（开源侧 `workspace-identity.ts` 的
 * `findWorkspaceEntryByCwd` 按同一路径/同一字段形读取），故这里直接落等价文件，
 * 测的是**开源侧读取面**（这正是 task↔project 互斥门禁依赖的那一面）。
 */
function seedProject(id: string, cwd: string, type?: 'project' | 'task'): void {
  const now = Date.now()
  writeJsonAtomic(join(workspaceIndexRoot(), id, 'project.json'), {
    id,
    name: id,
    ...(type !== undefined ? { type } : {}),
    cwd,
    addedAt: now,
    lastOpenedAt: now,
    version: 1,
  })
}

/** 造一个会话本体目录（迁移的「本体存在」判据）。 */
function seedSessionBody(cwd: string, sessionId: string): void {
  mkdirSync(join(home, 'sessions', encodeCwdForSessionsDir(cwd), sessionId), { recursive: true })
}

/** 写旧 task 索引（`sessionId → {cwd, profileId}`）。 */
function seedLegacyTaskIndex(entries: Record<string, { cwd: string; profileId: string }>): void {
  const path = join(home, 'projects', 'task', 'corum', 'task-sessions.json')
  mkdirSync(join(home, 'projects', 'task', 'corum'), { recursive: true })
  writeFileSync(path, JSON.stringify(entries, null, 2))
}

// ── ① 类型与不变式（纯函数）────────────────────────────────────────────

describe('工程类型与三条不变式', () => {
  it('缺省读作 project（旧条目都是项目模式创建的）', () => {
    expect(DEFAULT_PROJECT_TYPE).toBe('project')
    expect(projectTypeOf({})).toBe('project')
    expect(projectTypeOf(undefined)).toBe('project')
    // 脏值也回退到缺省（不让非法值穿透到判定表）
    expect(projectTypeOf({ type: 'nonsense' as never })).toBe('project')
  })

  it('合法类型判定只认 project/task', () => {
    expect(isProjectType('project')).toBe(true)
    expect(isProjectType('task')).toBe(true)
    expect(isProjectType('PROJECT')).toBe(false)
    expect(isProjectType(undefined)).toBe(false)
  })

  it('不变式 B：task → project 允许（升级），project → task 禁止（降级）', () => {
    expect(classifyProjectTypeTransition('task', 'project')).toBe('upgrade')
    expect(classifyProjectTypeTransition('project', 'task')).toBe('downgrade')
    expect(classifyProjectTypeTransition('project', 'project')).toBe('same')
    expect(classifyProjectTypeTransition('task', 'task')).toBe('same')

    expect(canTransitionProjectType('task', 'project')).toBe(true)
    expect(canTransitionProjectType('project', 'task')).toBe(false)
  })
})

// ── ② cwd 归一（工作区身份）────────────────────────────────────────────

describe('工作区身份由 realpath 归一的 cwd 决定', () => {
  it('尾斜杠与不带尾斜杠归一到同一身份（存量实测两者并存）', () => {
    const a = canonicalWorkspaceKey(ws)
    const b = canonicalWorkspaceKey(`${ws}/`)
    expect(a).toBeDefined()
    expect(a).toBe(b)
  })

  it('目录不存在时退回字形归一而非抛错（死条目身份仍可比）', () => {
    const gone = join(ws, 'definitely-not-here')
    expect(canonicalWorkspaceKey(gone)).toBe(gone)
    expect(canonicalWorkspaceKey(`${gone}/`)).toBe(gone)
    expect(canonicalWorkspaceKey('   ')).toBeUndefined()
    expect(canonicalWorkspaceKey(undefined)).toBeUndefined()
  })

  it('findWorkspaceEntryByCwd 用身份而非字符串比较（尾斜杠能命中同一条目）', () => {
    seedProject('my-ws', ws)
    expect(findWorkspaceEntryByCwd(ws)?.id).toBe('my-ws')
    expect(findWorkspaceEntryByCwd(`${ws}/`)?.id).toBe('my-ws')
  })

  it('一工作区一条目：索引落 type，读取按权威口径解析', () => {
    seedProject('t1', ws, 'task')
    expect(workspaceEntryTypeOf(findWorkspaceEntryByCwd(ws)!)).toBe('task')
    // 索引文件里 type 是显式字段（不靠读时缺省）
    const raw = JSON.parse(readFileSync(join(home, 'projects', 't1', 'project.json'), 'utf8'))
    expect(raw.type).toBe('task')
  })

  it('缺 type 的存量条目按史实读作 project（不变式 B：不产生隐式降级）', () => {
    seedProject('legacy', ws)
    const entry = findWorkspaceEntryByCwd(ws)
    expect(entry?.type).toBeUndefined()
    expect(workspaceEntryTypeOf(entry!)).toBe('project')
  })

  it('cwd 已失联的条目不作为命中目标（不能「恢复」一个够不着的项目）', () => {
    const gone = join(ws, 'removed-dir')
    seedProject('gone-ws', gone)
    expect(findWorkspaceEntryByCwd(gone)).toBeUndefined()
  })
})

// ── ③ 判定表门禁（不变式 A / B / C）───────────────────────────────────

describe('打开/创建判定表门禁', () => {
  it('已有 task 工作区 + project 口径 ⇒ 需用户确认升级（不擅自升级）', () => {
    seedProject('legacy-task', ws, 'task')
    const entry = findWorkspaceEntryByCwd(ws)!
    expect(classifyProjectTypeTransition(workspaceEntryTypeOf(entry), 'project')).toBe('upgrade')
    // 未确认前 type 不动（不变式 A：type 具权威性）
    expect(workspaceEntryTypeOf(findWorkspaceEntryByCwd(ws)!)).toBe('task')
  })

  it('已有 project 工作区 + task 口径 ⇒ 拒绝（不变式 B / C）', () => {
    seedProject('real-proj', ws, 'project')
    const entry = findWorkspaceEntryByCwd(ws)!
    expect(classifyProjectTypeTransition(workspaceEntryTypeOf(entry), 'task')).toBe('downgrade')
    expect(canTransitionProjectType('project', 'task')).toBe(false)
    expect(workspaceEntryTypeOf(findWorkspaceEntryByCwd(ws)!)).toBe('project') // 未被改写
  })

  it('同口径重开 ⇒ same（恢复原项目，不再新建）', () => {
    seedProject('p-same', ws, 'project')
    expect(classifyProjectTypeTransition('project', 'project')).toBe('same')
    seedProject('t-same', ws, 'task')
    expect(classifyProjectTypeTransition('task', 'task')).toBe('same')
  })

  it('listSessionsForWorkspace 用身份归一（尾斜杠不漏会话）', () => {
    registerSession('s-1', { cwd: ws, profileId: 'task', type: 'task' })
    // 带尾斜杠查询也必须命中（旧实现在 listTaskAgents 里用字符串直比会漏）
    expect(listSessionsForWorkspace(`${ws}/`)).toHaveLength(1)
    expect(listSessionsForWorkspace(ws)).toHaveLength(1)
  })

  it('task 入口的门禁判据：project 工作区必须被拒（不变式 C）', () => {
    // createAgentForTask 内的判据 = findWorkspaceEntryByCwd + workspaceEntryTypeOf。
    // 这里验判据本身（host 服务需 cordis 装配，故在单测里验判据、真机验端点）。
    seedProject('proj-ws', ws, 'project')
    const owner = findWorkspaceEntryByCwd(ws)
    expect(owner?.id).toBe('proj-ws')
    expect(workspaceEntryTypeOf(owner!)).toBe('project') // ⇒ task 入口会抛错

    const ws2 = mkdtempSync(join(tmpdir(), 'corum-uq-ws-task-'))
    try {
      seedProject('task-ws', ws2, 'task')
      const owner2 = findWorkspaceEntryByCwd(ws2)
      expect(workspaceEntryTypeOf(owner2!)).toBe('task') // ⇒ task 入口放行
    } finally {
      rmSync(ws2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

// ── ④ 统一索引：sessionId 作键（阻断性缺陷回归）────────────────────────

describe('统一会话索引（sessionId 作键）', () => {
  it('同一工作区同 profile 的多会话**各自成条**（复合键会压成一条）', () => {
    for (let i = 0; i < 5; i += 1) {
      registerSession(`corum-task-${i}`, { cwd: ws, profileId: 'task', type: 'task' })
    }
    const index = readSessionIndex()
    expect(Object.keys(index)).toHaveLength(5)
    expect(listSessionsForWorkspace(ws)).toHaveLength(5)
  })

  it('按 type 过滤（会话按 type 隔离显示）', () => {
    registerSession('task-1', { cwd: ws, profileId: 'task', type: 'task' })
    registerSession('proj-1', { cwd: ws, profileId: 'pm', type: 'project', laneKey: 'general' })
    expect(listSessionsForWorkspace(ws, 'task').map(s => s.sessionId)).toEqual(['task-1'])
    expect(listSessionsForWorkspace(ws, 'project').map(s => s.sessionId)).toEqual(['proj-1'])
    expect(listSessionsForWorkspace(ws)).toHaveLength(2)
  })

  it('坏条目单独丢弃，不淹没整表', () => {
    writeFileSync(join(home, 'sessions.json'), JSON.stringify({
      version: 2,
      sessions: {
        good: { cwd: ws, profileId: 'task', type: 'task' },
        noCwd: { profileId: 'task', type: 'task' },
        noProfile: { cwd: ws, type: 'task' },
        notObject: 'nonsense',
      },
    }))
    expect(Object.keys(readSessionIndex())).toEqual(['good'])
  })

  it('索引损坏（非法 JSON）⇒ 空索引，不抛错', () => {
    writeFileSync(join(home, 'sessions.json'), '{ this is not json')
    expect(readSessionIndex()).toEqual({})
  })

  it('findSessionByLane 按工作区隔离（同一 lane 在两个工作区互不串）', () => {
    const ws2 = mkdtempSync(join(tmpdir(), 'corum-uq-ws2-'))
    try {
      registerSession('a-1', { cwd: ws, profileId: 'dev', type: 'project', laneKey: 'general' })
      registerSession('b-1', { cwd: ws2, profileId: 'dev', type: 'project', laneKey: 'general' })
      expect(findSessionByLane('dev', 'general', ws)).toBe('a-1')
      expect(findSessionByLane('dev', 'general', ws2)).toBe('b-1')
      expect(findSessionByLane('dev', 'ui', ws)).toBeUndefined()
    } finally {
      rmSync(ws2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('findSession 按 id 直取', () => {
    registerSession('s-x', { cwd: ws, profileId: 'pm', type: 'project', laneKey: 'general' })
    expect(findSession('s-x')?.profileId).toBe('pm')
    expect(findSession('nope')).toBeUndefined()
  })
})

// ── ⑤ 迁移：零丢失 + 死条目按裁定丢弃 ──────────────────────────────────

describe('统一索引迁移', () => {
  it('**零丢失**：同一 cwd+profile 的 20 条 task 会话全部保留（复合键只剩 1 条）', () => {
    const entries: Record<string, { cwd: string; profileId: string }> = {}
    for (let i = 0; i < 20; i += 1) {
      const sid = `corum-task-${String(i).padStart(2, '0')}`
      entries[sid] = { cwd: ws, profileId: 'task' }
      seedSessionBody(ws, sid)
    }
    seedLegacyTaskIndex(entries)

    const result = migrateSessionIndex()
    expect(result.fromTaskIndex).toBe(20)
    expect(result.droppedCwdGone).toBe(0)
    expect(result.droppedBodyMissing).toBe(0)
    expect(Object.keys(readSessionIndex())).toHaveLength(20)

    // 反证：若按 project 侧复合键（profileId+laneKey）压缩，20 条会塌成 1 条。
    const collapsed = new Set(Object.values(readSessionIndex()).map(e => `${e.profileId}${e.laneKey ?? ''}`))
    expect(collapsed.size).toBe(1)
  })

  it('cwd 目录已删的条目按用户裁定**直接丢弃**并计数', () => {
    const gone = join(ws, 'removed-dir')
    seedSessionBody(ws, 'alive-1')
    seedLegacyTaskIndex({
      'alive-1': { cwd: ws, profileId: 'task' },
      'dead-1': { cwd: gone, profileId: 'task' }, // cwd 不存在
    })
    const result = migrateSessionIndex()
    expect(result.fromTaskIndex).toBe(1)
    expect(result.droppedCwdGone).toBe(1)
    expect(readSessionIndex()['dead-1']).toBeUndefined()
    expect(readSessionIndex()['alive-1']).toBeDefined()
  })

  it('会话本体缺失的条目丢弃（索引是到本体的指针）', () => {
    seedLegacyTaskIndex({ 'no-body': { cwd: ws, profileId: 'task' } })
    const result = migrateSessionIndex()
    expect(result.droppedBodyMissing).toBe(1)
    expect(Object.keys(readSessionIndex())).toHaveLength(0)
  })

  it('迁移幂等：重跑不重复计入、不丢已有条目', () => {
    seedSessionBody(ws, 'k-1')
    seedLegacyTaskIndex({ 'k-1': { cwd: ws, profileId: 'task' } })
    const first = migrateSessionIndex()
    expect(first.fromTaskIndex).toBe(1)
    // 第二跑：新索引已存在 ⇒ 不覆盖、不重复计数
    const second = migrateSessionIndex()
    expect(second.fromTaskIndex).toBe(0)
    expect(Object.keys(readSessionIndex())).toHaveLength(1)
    expect(readSessionIndex()['k-1']).toBeDefined()
  })

  it('旧 project 索引（复合键）也能归入统一形态，且 cwd 归一', () => {
    seedProject('p1', ws, 'project')
    seedSessionBody(ws, 'corum-projp1-agentpm-lanegeneral-aaaa')
    // 旧 project 索引：复合键 → sessionId
    const p = join(home, 'projects', 'p1', 'corum')
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'sessions.json'), JSON.stringify({ pmgeneral: 'corum-projp1-agentpm-lanegeneral-aaaa' }))

    const legacy = readLegacyIndexes().filter(s => s.origin === 'project-index')
    expect(legacy).toHaveLength(1)
    expect(legacy[0]!.entry.type).toBe('project')

    const result = migrateSessionIndex()
    expect(result.fromProjectIndex).toBe(1)
    const entry = readSessionIndex()['corum-projp1-agentpm-lanegeneral-aaaa']
    expect(entry?.cwd).toBe(canonicalWorkspaceKey(ws))
  })

  it('迁移不删旧索引文件（回滚安全网）', () => {
    seedSessionBody(ws, 'keep-1')
    seedLegacyTaskIndex({ 'keep-1': { cwd: ws, profileId: 'task' } })
    migrateSessionIndex()
    expect(existsSync(join(home, 'projects', 'task', 'corum', 'task-sessions.json'))).toBe(true)
  })

  it('迁移前落备份', () => {
    seedSessionBody(ws, 'b-1')
    seedLegacyTaskIndex({ 'b-1': { cwd: ws, profileId: 'task' } })
    const result = migrateSessionIndex()
    expect(result.backupDir).not.toBeNull()
    expect(existsSync(result.backupDir!)).toBe(true)
  })

  it('无事可做时**不**落备份（避免每次启动累积快照）', () => {
    // 首次：确有迁移动作 ⇒ 落备份
    seedSessionBody(ws, 'nb-1')
    seedLegacyTaskIndex({ 'nb-1': { cwd: ws, profileId: 'task' } })
    const first = migrateSessionIndex()
    expect(first.backupDir).not.toBeNull()

    // 第二次：无新条目可归入 ⇒ 不再拷一份逐字节相同的快照
    const second = migrateSessionIndex()
    expect(second.backupDir).toBeNull()
    expect(second.fromTaskIndex).toBe(0)
    expect(Object.keys(readSessionIndex())).toHaveLength(1)
  })
})

describe('旧 project 索引复合键拆分（正向枚举，不猜）', () => {
  it('长前缀优先（dev-lead 不被 dev 抢先匹配）', () => {
    expect(splitCompositeKey('dev-leadgeneral', ['dev', 'dev-lead']))
      .toEqual({ profileId: 'dev-lead', laneKey: 'general' })
  })

  it('带 `:` 的需求段泳道键（存量实测形）', () => {
    const key = 'devreq-d2806554-bdd1-4137-86ff-7df0b24a4c2d:ui'
    expect(splitCompositeKey(key, ['dev', 'pm', 'qa']))
      .toEqual({ profileId: 'dev', laneKey: 'req-d2806554-bdd1-4137-86ff-7df0b24a4c2d:ui' })
  })

  it('无已知 profile 匹配 ⇒ 整键作 laneKey、profileId 留空（不编造）', () => {
    expect(splitCompositeKey('mysterykey', [])).toEqual({ profileId: '', laneKey: 'mysterykey' })
  })
})

describe('从 sessionId 反解 project 泳道（比拆复合键可信）', () => {
  it('新式 `lane` 段', () => {
    expect(parseProjectSessionId('corum-projalpha-agentpm-lanegeneral-2bc71598', 'alpha'))
      .toEqual({ projectId: 'alpha', profileId: 'pm', laneKey: 'general' })
  })

  it('旧式 `type` 段（存量实测形）', () => {
    expect(parseProjectSessionId('corum-projproject-agentpm-typegeneral-2bc71598', 'project'))
      .toEqual({ projectId: 'project', profileId: 'pm', laneKey: 'general' })
  })

  it('需求段泳道键（含 `:` 与连字符）完整还原', () => {
    const sid = 'corum-projproject-agentdev-lanereq-d2806554-bdd1-4137-86ff-7df0b24a4c2d-ui-37e8eaa5'
    expect(parseProjectSessionId(sid, 'project')).toEqual({
      projectId: 'project',
      profileId: 'dev',
      laneKey: 'req-d2806554-bdd1-4137-86ff-7df0b24a4c2d-ui',
    })
  })

  it('projectId 不匹配 / 非 project 泳道 ⇒ undefined（不误判）', () => {
    expect(parseProjectSessionId('corum-projother-agentpm-lanegeneral-abc12345', 'alpha')).toBeUndefined()
    expect(parseProjectSessionId('corum-task-c8c2f32d', 'alpha')).toBeUndefined()
    expect(parseProjectSessionId('nonsense', 'alpha')).toBeUndefined()
  })
})

// ── ⑥ 会话目录编码（与官方 session-persistence 同款）───────────────────

describe('会话目录编码', () => {
  it('与官方 `--<cwd 去根斜杠、分隔符换 ->--` 同形', () => {
    expect(encodeCwdForSessionsDir('/Users/kukucai/work/kkc-desktop'))
      .toBe('--Users-kukucai-work-kkc-desktop--')
  })

  it('★ 三平台都产出合法目录名：不含 `/`、`\\`、`:`（2026-10-21 Windows 门禁咬出）', () => {
    // 起因：只换 `/` 时，Windows 的 `C:\Users\…` 会产出 `--C:\Users\…--` —— 含 `:`，
    // NTFS 非法 ⇒ mkdir ENOENT，该平台的会话本体与迁移整条路不通。
    // 这里用平台无关的字面量论证：编码结果里出现任何分隔符或盘符冒号都算错。
    for (const cwd of ['/Users/kukucai/work/kkc-desktop', '/tmp/x y', 'C:\\Users\\runneradmin\\repo']) {
      const encoded = encodeCwdForSessionsDir(cwd)
      expect(encoded.startsWith('--') && encoded.endsWith('--')).toBe(true)
      const body = encoded.slice(2, -2)
      expect(body, `encoding of ${cwd} must not contain path separators or a drive colon`)
        .not.toMatch(/[/\\:]/)
      expect(body.length).toBeGreaterThan(0)
    }
  })
})
