import { createContext, useContext } from 'react'

/** 当前会话的 Agent 显示名（对话区 Agent 头昵称）。由 ChatView 查询并提供。 */
export const AgentNameContext = createContext<string | undefined>(undefined)

/** 读取当前会话 Agent 昵称；未提供时返回 undefined（Agent 头回退通用文案）。 */
export function useAgentName(): string | undefined {
  return useContext(AgentNameContext)
}
