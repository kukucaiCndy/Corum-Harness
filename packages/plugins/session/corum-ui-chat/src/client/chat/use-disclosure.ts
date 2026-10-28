/**
 * 座位级 disclosure 状态（rc3 移植）。
 *
 * ## 为什么必须有（2026-10-29 实机 console）
 *
 * rc3 的官方工具行/工具树（`@deepseek-ai/dsh-client-ui-tool` 的 `ToolRow` /
 * `ToolCallTree`，以及官方 ui-chat 的 `AssistantMarkdown` 等）在 props 里读
 * **`useDisclosure`** 这个「每座位独立开合状态」hook。它由 `conversation.chat.node`
 * 座位声明的 inject 面提供（官方 `CHAT_NODE_INJECT.hooks.disclosure`），
 * 复位信号来自渲染时下发的 `hookContext`。
 *
 * corum fork 的座位 inject 面只声明了 `turnData`，于是任何官方注册进
 * `conversation.chat.node` 的渲染器拿到 `useDisclosure === undefined` ⇒ 打开历史
 * 会话时 `TypeError: useDisclosure is not a function`，工具行全部被槽错误边界吞掉。
 *
 * 本文件是官方 `ui-chat` 的 `chat/use-disclosure.js` 的**同义移植**（语义：
 * 「一个座位一份独立开合态 + 版本换代即复位」），只依赖 react。
 *
 * @module @corum/corum-ui-chat/client/use-disclosure
 */
import { useCallback, useState, useSyncExternalStore } from 'react'

/** 一个座位的开合状态三件套。 */
export interface Disclosure {
  /** 当前是否展开。 */
  readonly expanded: boolean
  /** 显式置开合。 */
  setExpanded(open: boolean): void
  /** 翻转开合。 */
  toggle(): void
}

/**
 * 一份**不与外界订阅**的开合状态。
 * @param version - 复位世代：世代变化时局部开合状态回到「收起」。
 * @returns 开合状态三件套。
 */
export function useDisclosure(version = 0): Disclosure {
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null)
  return {
    expanded: expandedVersion === version,
    setExpanded: useCallback((open: boolean) => {
      setExpandedVersion(open ? version : null)
    }, [version]),
    toggle: useCallback(() => {
      setExpandedVersion(previous => previous === version ? null : version)
    }, [version]),
  }
}

/** 复位信号源（uSES：`getSnapshot` 返回当前世代号）。 */
export interface DisclosureResetSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): number
}

/**
 * 把一个复位信号绑成 `useDisclosure` 形 hook（官方 `bindDisclosure` 同义）。
 * @param reset - 复位世代源（座位被所属 Turn 隐藏/换代时前进）。
 * @returns 无参 hook，每次调用一份独立开合状态。
 */
export function bindDisclosure(reset: DisclosureResetSource): () => Disclosure {
  const subscribe = (listener: () => void): (() => void) => reset.subscribe(listener)
  const getSnapshot = (): number => reset.getSnapshot()
  return function useBoundDisclosure(): Disclosure {
    return useDisclosure(useSyncExternalStore(subscribe, getSnapshot, getSnapshot))
  }
}
