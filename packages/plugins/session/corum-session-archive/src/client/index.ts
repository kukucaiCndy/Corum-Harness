/** Browser plugin owning session-archive save/import state over the desktop native bridge. */

import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import { type SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { WorkspaceSnapshot as WorkspaceListState } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@corum/corum-ide-ui/client'
import { SessionArchiveController, type ArchivedSessionRow } from './controller.ts'
import { SessionArchiveSaveDialogHost, type SessionArchiveSaveDialogInjected } from './SaveDialogHost.tsx'
import { SessionArchiveImportRow, type SessionArchiveImportInjected } from './ImportRow.tsx'
import { en, NS, zh, type SessionArchiveKey } from './locales.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionArchive: SessionArchiveController
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'session-archive': SessionArchiveKey
  }
}

export type {
  ArchivedSessionRow,
  SessionArchiveDeleteEntry,
  SessionArchiveImportEntry,
  SessionArchiveManageEntry,
  SessionArchiveSaveEntry,
  SessionArchiveState,
} from './controller.ts'

export const inject = ['slots', 'locale', 'workspaces', 'sessions', 'connection']

/**
 * Provide the archive controller, mount the save-result modal, and expose the
 * archived-session capability the settings「会话管理」section renders.
 *
 * 2026-09-16 入口搬运（用户定调）：
 * - 「保存到…」的**入口**从会话头部右上角搬到**会话栏会话行右键菜单**
 *   （实现在 corum-ide-sidebar-ui 的 SessionsPane；它经本包 provide 的
 *   cordis 服务 `sessionArchive` 拿保存能力）。
 * - **结果反馈弹窗仍归本包**（文案/locale/状态机都在此处），改挂根级
 *   `shell.overlay` 槽，与触发它的菜单解耦（见 SaveDialogHost.tsx 头注）。
 *
 * 2026-10-22「会话管理」独立 section 页（issue #121 修订版）：
 * 原 ManageDialog（Modal 形态）被用户验收否掉（要求独立页面），改为由
 * corum-ide-ui 直接渲染的 section 页；本包只经 cordis 服务
 * `sessionArchive` 下发**能力面**（还原 / 导出 / 删除 / 导入），页面自身
 * 的勾选态、typed-confirm 都由壳侧组件持有。
 *
 * P0-2（2026-09-14）恢复范围（用户裁决，仍然有效）：
 * - 「保存到…」能力保留（本次只换入口位置，不是删能力）。
 * - 「导入会话日志」：挂 `settings.general.item`。
 * - 不恢复「删除会话」按钮：733d3b70 定调移除不可逆入口的裁决对它仍成立；
 *   controller.deleteSession 保留为程序化 API。
 * @param ctx - browser context carrying slots and locale services.
 */
export function apply(ctx: ClientContext): void {
  const controller = new SessionArchiveController()
  ctx.provide('sessionArchive', controller)
  ctx.effect(() => async () => { await controller.dispose() }, 'session-archive: bridge operation lifecycle')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-archive: dictionaries')

  // 还原（unarchive）的 host 侧落点：`workspace/unarchiveSession` RPC
  // （官方 workspace controller，与侧栏归档 undo 同一端点）。
  //
  // ⚠️ **为什么走 connection.rpc.call 而不是 ctx.workspaces.unarchiveSession**：
  // 本仓基线 0.1.5-rc.3 的 `IWorkspaces` 只暴露 `archiveSession`，
  // `unarchiveSession` 是上游 0.2.x 才加进客户端 service 面的；但 **host 侧
  // 的 RPC 已存在**（官方 workspace registry 的 unarchiveSession）。按红线 3
  // 用局部能力面收窄：`rpc.call('/api', 'workspace/unarchiveSession', …)`
  // 直接打该端点，编译期不耦合一个本基线还没有的方法名。
  // 控制器不碰 cordis（它只持 bridge 操作），故在这里 bind 一次。
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  controller.bindUnarchive(async (sessionId: string) => {
    if (connection === undefined) throw new Error('restore unavailable (no connection)')
    const result = await connection.rpc.call('/api', 'workspace/unarchiveSession', { args: { sessionId } })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  })
  // 归档行读取器：workspace 归档集 ∩ 活会话列表（与侧栏 SessionsPane 同口径）。
  // 「会话管理」section 页每帧调它把行发布进控制器状态（见
  // controller.setManageRows）——控制器自己不持有这两份快照。
  controller.bindArchivedRows(() => readArchivedRows(ctx.workspaces.list, ctx.sessions.list))

  // 「保存到…」入口已搬到**会话行右键菜单**（2026-09-16 用户定调，见
  // corum-ide-sidebar-ui 的 SessionsPane 与下方 saveDialogInjected）。原
  // `conversation.session.header.utilities` 的头部按钮注册**已移除**——
  // 本次是「把入口搬走」，不是「删掉能力」（P0-2 裁决恢复的「保存到…」仍可用，
  // 只是入口换位置；「删除会话」按钮的裁决不受影响，仍未恢复）。
  //
  // 结果反馈 Modal 改为挂在根级 `shell.overlay`（corum-ide-ui 声明、AppFrame 渲染的
  // frame 内浮层），与触发它的菜单解耦：菜单选中即关闭，弹窗照常出现。
  // 会话 id 由控制器 publish 的状态自带（bySession 按 id 索引），不依赖槽的
  // session 作用域 —— 故本槽用 root 作用域即可（saveDialogInjected 反查最近一次
  // 有 open 态的那个会话）。
  const saveDialogInjected = (): SessionArchiveSaveDialogInjected => ({
    hooks: { sessionArchive: controller.store },
    dismiss: (sessionId: SessionId) => { controller.dismissSave(sessionId) },
  })

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-archive-save-dialog',
    locale: NS,
    inject: saveDialogInjected,
  }, SessionArchiveSaveDialogHost))

  const importInjected = (): SessionArchiveImportInjected => ({
    hooks: { sessionArchive: controller.store },
    desktopAvailable: () => controller.desktopAvailable,
    requestImport: () => controller.import(),
    dismissImport: () => { controller.dismissImport() },
  })

  // 2026-09-16 迁入「数据管理」（PRD §4.8 DA5）：
  // 原先挂在 settings.general.item（通用页），但通用页按 M4 只渲染
  // language / composer-enter ⇒ 该行在那里已不可达。
  // 现改挂数据管理页的 settings.data.item 子槽 —— 该键必须先在
  // corum-ide-ui 的 SlotMap 增强块里登记，否则类型系统拒绝（已登记）。
  ctx.slots.inject('settings.data.item', () => ctx.slots.register({
    name: 'settings.data.item',
    id: 'session-archive-import',
    order: 30,
    locale: NS,
    inject: importInjected,
  }, SessionArchiveImportRow))
}

/**
 * Read the archived session rows from the live workspace and session snapshots.
 *
 * The archived set is host-authoritative on the workspace side; a session that
 * was archived and then deleted may linger in it until the next boot (documented
 * host limitation), so rows are intersected with the live session list — an id
 * with no live header is not presentable and not deletable.
 *
 * 归档集来源 = `ctx.workspaces.list` 的 archivedSessionIds（与侧栏
 * SessionsPane 同一口径，不是磁盘目录）；标题取 `ctx.sessions.list` 的
 * SessionSummary，工作区名与归档日期由行投影按 cwd 归属推导。
 * @param wsList - workspace snapshot source.
 * @param sessionList - session list snapshot source.
 * @returns one row per archived session that still has a live header.
 */
export function readArchivedRows(
  wsList: { getSnapshot(): WorkspaceListState },
  sessionList: { getSnapshot(): SessionListState },
): readonly ArchivedSessionRow[] {
  const archived = wsList.getSnapshot().archivedSessionIds
  if (archived.length === 0) return []
  const snapshot = sessionList.getSnapshot()
  const workspaces = wsList.getSnapshot().items
  // 工作区名索引：会话 cwd → 工作区标题（设计稿副标第一段「工作区名」）。
  const nameByPath = new Map<string, string>()
  for (const workspace of workspaces) {
    if (!nameByPath.has(workspace.path)) nameByPath.set(workspace.path, workspace.title)
  }
  const rows: ArchivedSessionRow[] = []
  for (const id of archived) {
    // 归档集与 session list 的键同为 branded SessionId；这里直接用它索引
    // （与 corum-ide-sidebar-ui 的 SessionsPane 同一姿势）。
    const summary = snapshot.byId[id]
    if (summary === undefined) continue
    const cwd = typeof summary.cwd === 'string' ? summary.cwd : undefined
    const workspaceName = cwd !== undefined ? (nameByPath.get(cwd) ?? basenameOf(cwd)) : '未知工作区'
    rows.push({
      id: String(id),
      title: summary.displayTitle !== '' ? summary.displayTitle : '未命名会话',
      workspaceName,
      // 会话列表没有「归档时刻」字段（归档集只留 id）⇒ 副标日期用最近更新日，
      // 与「这个会话最后一次活动」同义（设计稿 sub: 工作区名 · 归档于 YYYY-MM-DD）。
      archivedAt: formatDay(typeof summary.updatedAt === 'number' ? summary.updatedAt : null),
    })
  }
  rows.sort((left, right) => (right.archivedAt ?? '').localeCompare(left.archivedAt ?? ''))
  return rows
}

/** 路径末段（工作区标题缺失时的副标回退；不依赖 node:path，客户端可用）。 */
function basenameOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed
}

/** epoch-ms → `YYYY-MM-DD`（设计稿副标「归档于」的日期段）。 */
function formatDay(epochMs: number | null): string | null {
  if (epochMs === null || !Number.isFinite(epochMs)) return null
  const date = new Date(epochMs)
  if (Number.isNaN(date.getTime())) return null
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export type { SessionArchiveSaveDialogProps } from './SaveDialog.tsx'
export type { SessionArchiveSaveDialogHostProps, SessionArchiveSaveDialogInjected } from './SaveDialogHost.tsx'
export type { SessionArchiveImportInjected, SessionArchiveImportRowProps } from './ImportRow.tsx'
