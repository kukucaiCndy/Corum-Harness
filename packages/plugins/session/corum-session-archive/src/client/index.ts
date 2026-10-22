/** Browser plugin owning session-archive save/import state over the desktop native bridge. */

import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import { type SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceSnapshot as WorkspaceListState } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// shell.overlay 槽的声明方（corum-ide-ui）：type-only 拉进 SlotMap 行，
// 与上面 ui-conversation / ui-settings 同一姿势（声明方不由本包渲染）。
import type {} from '@corum/corum-ide-ui/client'
import { SessionArchiveController, type ArchivedSessionRow } from './controller.ts'
import { SessionArchiveSaveDialogHost, type SessionArchiveSaveDialogInjected } from './SaveDialogHost.tsx'
import { SessionArchiveImportRow, type SessionArchiveImportInjected } from './ImportRow.tsx'
import { SessionArchiveManageDialog, type SessionArchiveManageInjected } from './ManageDialog.tsx'
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

export const inject = ['slots', 'locale', 'workspaces', 'sessions']

/**
 * Provide the archive controller and mount the save-result modal plus the
 * General-settings import row.
 *
 * 2026-09-16 入口搬运（用户定调）：
 * - 「保存到…」的**入口**从会话头部右上角搬到**会话栏会话行右键菜单**
 *   （实现在 corum-ide-sidebar-ui 的 SessionsPane；它经本包 provide 的
 *   cordis 服务 `sessionArchive` 拿保存能力）。
 * - **结果反馈弹窗仍归本包**（文案/locale/状态机都在此处），改挂根级
 *   `shell.overlay` 槽，与触发它的菜单解耦（见 SaveDialogHost.tsx 头注）。
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

  // 「删除归档会话」管理对话框（issue #121）：挂在根级 shell.overlay，与
  // 保存结果弹窗同槽不同 entry。入口按钮在 corum-ide-ui 的
  // SettingsDataSection（本轮由 disabled 改为调用 requestOpen）。
  //
  // 归档集来源 = `ctx.workspaces.list` 的 archivedSessionIds（与侧栏
  // SessionsPane 同一口径，不是磁盘目录）；标题/时间取
  // `ctx.sessions.list` 的 SessionSummary。两者都在本包 inject 里
  // 显式声明（红线 4：不走 ctx.get 未装配服务）。
  const manageInjected = (): SessionArchiveManageInjected => ({
    hooks: { sessionArchive: controller.store },
    desktopAvailable: () => controller.desktopAvailable,
    archivedRows: () => readArchivedRows(ctx.workspaces.list, ctx.sessions.list),
    requestDelete: (ids: readonly string[]) => controller.deleteArchived(ids),
    requestOpen: () => { controller.openManage(readArchivedRows(ctx.workspaces.list, ctx.sessions.list)) },
    requestDismiss: () => { controller.dismissManage() },
  })

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-archive-manage',
    order: 20,
    locale: NS,
    inject: manageInjected,
  }, SessionArchiveManageDialog))
}

/**
 * Read the archived session rows from the live workspace and session snapshots.
 *
 * The archived set is host-authoritative on the workspace side; a session that
 * was archived and then deleted may linger in it until the next boot (documented
 * host limitation), so rows are intersected with the live session list — an id
 * with no live header is not presentable and not deletable.
 * @param wsList - workspace snapshot source.
 * @param sessionList - session list snapshot source.
 * @returns one row per archived session that still has a live header.
 */
function readArchivedRows(
  wsList: { getSnapshot(): WorkspaceListState },
  sessionList: { getSnapshot(): SessionListState },
): readonly ArchivedSessionRow[] {
  const archived = wsList.getSnapshot().archivedSessionIds
  if (archived.length === 0) return []
  const sessions = sessionList.getSnapshot()
  const rows: ArchivedSessionRow[] = []
  for (const id of archived) {
    // 归档集与 session list 的键同为 branded SessionId；这里直接用它索引
    // （与 corum-ide-sidebar-ui 的 SessionsPane 同一姿势）。
    const summary = sessions.byId[id]
    if (summary === undefined) continue
    rows.push({
      id: String(id),
      title: summary.displayTitle !== '' ? summary.displayTitle : '未命名会话',
      updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : null,
    })
  }
  rows.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
  return rows
}

export type { SessionArchiveSaveDialogProps } from './SaveDialog.tsx'
export type { SessionArchiveSaveDialogHostProps, SessionArchiveSaveDialogInjected } from './SaveDialogHost.tsx'
export type { SessionArchiveImportInjected, SessionArchiveImportRowProps } from './ImportRow.tsx'
export type { SessionArchiveManageDialogProps, SessionArchiveManageInjected } from './ManageDialog.tsx'
