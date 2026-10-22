/**
 * 解析「删除归档会话」能力的 hook（issue #121）。
 *
 * 能力实现在 `corum-session-archive`（`sessionArchive` cordis 服务），
 * 它是**可选**插件。本 hook 经 `SessionArchiveContext` 拿注册期下发的
 * 解析器，缺席时返回 null ⇒ 按钮保持 disabled，不留死按钮（PRD §6.1）。
 *
 * @module corum-ide-ui/client/settings/sections/useSessionArchiveCapability
 */

import { createContext, useContext, type ReactNode } from 'react'
import { GlassButton } from '../shared.tsx'

/** 本包用到的 `sessionArchive` 能力面（红线 3：局部能力接口，不 import 实现包）。 */
export interface SessionArchiveCapable {
  /** 打开归档管理对话框（对话框自行从快照读归档集）。 */
  openManage: () => void
  /** 原生桌面桥是否可用（false = 非桌面壳）。 */
  readonly desktopAvailable: boolean
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
 * 读取「删除归档会话」能力。
 * @returns the capability face, or null when the archive plugin is absent.
 */
export function useSessionArchiveCapability(): SessionArchiveCapable | null {
  const resolve = useContext(SessionArchiveContext)
  return resolve === null ? null : resolve()
}

/**
 * 「删除归档会话」入口按钮（issue #121）。
 *
 * 能力缺席（未装存档插件）或非桌面壳时保持 disabled —— 与 §6.1 死控件的
 * 区别是这里的 disabled 是**事实陈述**（能力此刻不可用），不是占位。
 * 对话框本体与输入式确认都在 corum-session-archive 内。
 *
 * @returns the trigger button.
 */
export function DeleteArchiveButton(): ReactNode {
  const capability = useSessionArchiveCapability()
  const available = capability !== null && capability.desktopAvailable
  return (
    <GlassButton
      variant="danger"
      disabled={!available}
      onClick={() => { capability?.openManage() }}
    >
      删除归档
    </GlassButton>
  )
}
