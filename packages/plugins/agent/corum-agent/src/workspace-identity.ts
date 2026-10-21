/**
 * 工作区身份（L0 助手）—— 从 `project.ts` / `project-store.ts` 沉淀（2026-09-26 项目模式剥离）。
 *
 * ## 为什么独立成文件
 *
 * 项目模式（project mode）已物理迁出至**闭源仓 Corum-Harness-Project**，任务模式
 * （task mode）留在本仓。但「工作区身份」是**两模式共用的地基**：
 *
 * | 消费方 | 用到的符号 |
 * | --- | --- |
 * | `agent-service.ts`（task 泳道） | `canonicalWorkspaceKey` |
 * | `session-index.ts` / `lane-registry.ts` | `canonicalWorkspaceKey` |
 * | `legacy-index.ts` / `session-index-migration.ts` | `canonicalWorkspaceKey`、`isValidProjectId` |
 * | 闭源 `@corum/corum-project` | 同上 + `slugifyProjectId`、`writeJsonAtomic`、索引条目读取 |
 *
 * 故本模块是 L0（无项目语义的**身份/落盘原语**）；项目语义（类型判定、项目组、工作类型
 * 路由）在 L1 的 `workspace-type.ts`，项目实体/存储在闭源仓。
 *
 * ## `findWorkspaceEntryByCwd`：为什么留在这里而不是留着 project-store
 *
 * `agent-service.ts` 的 `createAgentForTask` 有一条**必须继续生效**的门禁：
 * 「task 模式打开一个已是 project 模式的工作区 ⇒ 拒绝」（不变式 C 互斥）。
 * 它只需要读**索引**里的轻字段（id/name/cwd/type）——不需要项目侧详字段、不需要
 * loadProject 的合并、不需要写路径。故在这里留一个**最小只读索引读取器**，
 * 而不是把整个 project-store 搬回来。
 *
 * @module @corum/corum-agent/workspace-identity
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { realpathSync } from 'node:fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DEFAULT_PROJECT_TYPE, isProjectType, type ProjectType } from './workspace-type.ts'

/**
 * 工作区身份规范形：**由 cwd 决定**（`architecture.project.type-is-authoritative-and-monotonic`
 * 「一工作区一条目、身份由 cwd 决定」）。
 *
 * 必须 realpath 归一，否则同一目录会被判成两个工作区：
 *   - 尾斜杠：`/a/b/` 与 `/a/b`（存量实测 217 条 task 会话里两者并存）；
 *   - 软链：macOS `/tmp` → `/private/tmp`（`agent-service.ts` 的
 *     `createAgentForTask` 已有同款先例：attach workspace 前先 realpathSync）。
 *
 * 目录不存在（已删/已移动）时 realpath 会抛错 ⇒ 退回「去尾斜杠 + 归一分隔符」的
 * 字形规范形：死条目的身份仍可比较（供迁移去重），只是拿不到软链解析。
 */
export function canonicalWorkspaceKey(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd.trim() === '') return undefined
  const trimmed = cwd.trim()
  try {
    return realpathSync(trimmed)
  } catch {
    // 目录不可达：字形归一（折叠重复分隔符、去尾分隔符；保留根 `/`）。绝不 throw——
    // 死条目的身份仍需可比，迁移/列表都不该因一条失联目录整体失败。
    //
    // ⚠️ 尾部必须同时剥 `/` **和** `\`：`normalize()` 是**平台相关**的，Windows 上它会把
    // 尾部的 `/` 规范成 `\`（实测 `normalize('C:\…\dir/')` ⇒ `'C:\…\dir\'`），只剥 `/`
    // 就留下一根反斜杠 ⇒ `C:\…\dir\` 与 `C:\…\dir` 被判成两个身份（同一个已删工作区）。
    // POSIX 上 `\` 是合法文件名字符，不会被误剥（那里 normalize 也不产出 `\` 作分隔符）。
    const collapsed = normalize(trimmed).normalize('NFC')
    if (collapsed.length <= 1) return collapsed
    if (collapsed === '/' || /^[A-Za-z]:[\\/]$/.test(collapsed)) return collapsed   // 根不可再剥
    return collapsed.replace(/[\\/]+$/, '')
  }
}

/** 项目 id 合法性：lower-kebab-case，与 profile id 同规则。 */
export function isValidProjectId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id)
}

/** 从项目名派生一个合法 projectId（slug 化；冲突由 store 层加后缀处理）。 */
export function slugifyProjectId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'project' : slug
}

/** 非原子 rename 的 fs.renameSync 在跨设备（EXDEV）时的兜底：先拷后删。 */
function renameAtomic(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    writeFileSync(dest, readFileSync(src))
    rmSync(src)
  }
}

/** 原子写 JSON（tmp + rename；半写不留脏文件）。 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameAtomic(tmp, path)
}

// ── 工作区索引的**只读**最小读取面（task↔project 互斥门禁）────────────

/**
 * 工作区索引根（`$CORUM_HOME/projects`）。
 *
 * 与闭源仓 `project-store.ts` 的 `projectsRoot()` **同源同值**（都读 `CORUM_HOME`，
 * 缺省 `~/.corum`，经 `resolveDshHome` 展开）——两仓各自持一份实现是刻意的：
 * 开源侧不许依赖闭源包，而这条路径是两仓共享的**磁盘契约**。
 */
export function workspaceIndexRoot(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum'
  return join(resolveDshHome(configured), 'projects')
}

/**
 * 索引里一个工作区条目的**读侧最小投影**（闭源 project-store 的 ProjectIndexEntry 子集）。
 *
 * 只声明本仓读得到的字段：详字段（description/workTypes/group）在项目侧
 * `<cwd>/.corum/project/project.json`（闭源侧合并），本仓不读也不需要。
 */
export interface WorkspaceIndexEntry {
  readonly id: string
  readonly name: string
  /** 工程类型（`project` | `task`；缺省按史实读作 `project`，见 {@link workspaceEntryTypeOf}）。 */
  readonly type?: ProjectType
  readonly cwd?: string
  readonly addedAt: number
  readonly lastOpenedAt: number
  readonly version: number
}

/**
 * 读一个条目按**权威**口径的工程类型（不变式 A：type 由工作区自身持有）。
 * 缺省/脏值 → `DEFAULT_PROJECT_TYPE`（`project`）——旧条目都是项目模式创建的。
 */
export function workspaceEntryTypeOf(entry: Pick<WorkspaceIndexEntry, 'type'>): ProjectType {
  return isProjectType(entry.type) ? entry.type : DEFAULT_PROJECT_TYPE
}

/** 读单个工作区索引条目（`$CORUM_HOME/projects/<id>/project.json`；不存在/损坏 → undefined）。 */
function readWorkspaceIndexEntry(id: string): WorkspaceIndexEntry | undefined {
  if (!isValidProjectId(id)) return undefined
  const path = join(workspaceIndexRoot(), id, 'project.json')
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WorkspaceIndexEntry
  } catch {
    return undefined
  }
}

/**
 * 按工作区**身份**（`canonicalWorkspaceKey(cwd)`）查已有索引条目。
 *
 * 「一工作区一条目」（`architecture.project.type-is-authoritative-and-monotonic`
 * 甲案：身份由 cwd 决定）的读侧入口。比较用规范形而非原字符串——存量实测
 * `"/a/b/"` 与 `"/a/b"` 同指一个目录（217 条 task 会话里两者并存），直接比字符串
 * 会把一个工作区判成两个。
 *
 * @param cwd - 待查工作目录（绝对路径）。
 * @returns 命中的索引条目（同 cwd 多条脏数据时取 `lastOpenedAt` 最新者）；
 *   无命中 / cwd 空 → `undefined`。
 */
export function findWorkspaceEntryByCwd(cwd: string | undefined): WorkspaceIndexEntry | undefined {
  const key = canonicalWorkspaceKey(cwd)
  if (key === undefined) return undefined
  const root = workspaceIndexRoot()
  if (!existsSync(root)) return undefined
  const hits: WorkspaceIndexEntry[] = []
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !isValidProjectId(dirent.name)) continue
    const entry = readWorkspaceIndexEntry(dirent.name)
    if (entry === undefined) continue
    // cwd 失联的条目不算命中：它不能作为「恢复」目标（与闭源 findProjectByCwd
    // 的缺省口径一致——includeUnavailable 缺省 false）。
    if (entry.cwd === undefined || entry.cwd === '' || !existsSync(entry.cwd)) continue
    if (canonicalWorkspaceKey(entry.cwd) !== key) continue
    hits.push(entry)
  }
  // 存量脏数据可能有多条同 cwd：取最近打开者作「恢复」目标（迁移负责最终合并为一条）。
  return hits.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0]
}
