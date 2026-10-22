/**
 * 「会话管理」section 的能力解析 hook（issue #121 修订版）。
 *
 * 能力实现在 `corum-session-archive`（`sessionArchive` cordis 服务），
 * 它是**可选**插件。本 hook 经 `SessionArchiveContext` 拿注册期下发的
 * 解析器，缺席时返回 null ⇒ 页面降级为「仅桌面端可用」的事实陈述，
 * 不留死按钮（PRD §6.1 的判据）。
 *
 * 2026-10-22：原 ManageDialog（Modal 形态）被用户验收否掉（要求独立页面），
 * 页面本体改由 corum-ide-ui 直接渲染；本文件只剩能力解析面。
 *
 * @module corum-ide-ui/client/settings/sections/useSessionArchiveCapability
 */

import { createContext, useContext } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** 本包用到的 `sessionArchive` 能力面（红线 3：局部能力接口，不 import 实现包）。 */
export interface SessionArchiveCapable {
  /** 原生桌面桥是否可用（false = 非桌面壳）。 */
  readonly desktopAvailable: boolean
  /** 控制器状态快照（useSessionArchive 选择器 hook 的来源）。 */
  readonly store: ObservableSnapshot<unknown>
  /** 「此刻」的归档行（宿主从 workspace/session 快照读，页面只负责发布）。 */
  readonly archivedRows: () => readonly unknown[]
  /** 把「此刻」的归档行发布进控制器状态（宿主每帧读取快照后调用）。 */
  readonly setManageRows: (rows: readonly unknown[]) => void
  /** 还原（unarchive）一批归档会话。 */
  readonly restoreArchived: (ids: readonly string[]) => Promise<void>
  /** 导出：单条走原生保存框；批量走一个合并 ZIP 的保存框。 */
  readonly saveSession: (sessionId: string) => Promise<void>
  readonly exportArchived: (ids: readonly string[]) => Promise<void>
  /** 删除：单条带原生确认；批量由页面侧 typed-confirm 把关后逐条调。 */
  readonly deleteArchived: (ids: readonly string[]) => Promise<void>
  /** 导入会话日志（原生 open 框，支持多选 ZIP）。 */
  readonly importSessionLog: () => Promise<void>
  /** 清掉上一次运行的 outcome / 导出失败提示（保留列表）。 */
  readonly dismissManageOutcome: () => void
}

/** 解析器：每次调用返回「此刻」是否已有该服务。 */
export type SessionArchiveResolver = () => SessionArchiveCapable | null

/**
 * 注册期上下文（在 index.tsx 的 section 注册处 provide）。
 *
 * 缺省 null ⇒ 未注册 section 宿主时（独立渲染/单测）能力缺席。
 */
export const SessionArchiveContext = createContext<SessionArchiveResolver | null>(null)

/**
 * 读取「会话管理」能力。
 * @returns the capability face, or null when the archive plugin is absent.
 */
export function useSessionArchiveCapability(): SessionArchiveCapable | null {
  const resolve = useContext(SessionArchiveContext)
  return resolve === null ? null : resolve()
}
