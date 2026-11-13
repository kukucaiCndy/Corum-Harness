/**
 * `corumResearchToolFilter` 的 MCP 共享控制工具 deny 契约（2026-11-13）。
 *
 * 由来：MCP 渐进式索引（2026-11-12d §2）引入共享工具 mcp_index/mcp_load。
 * mcp_load 会向**共享 preset scope** 注册工具——只读 research 子会话若可调用它，
 * 就能扩大主会话/worker 的工具面（orchestrate 集成复核 §3.2 发现的缺口）。
 * 修法：request 级 research deny 组装点（corum-tool-subagent）把这两个名字并入
 * deny；本文件钉住过滤器侧的合并语义（调用点接线由实机验证覆盖）。
 */
import { describe, expect, it } from 'vitest'
import { corumMutationToolsForPlatform, corumResearchToolFilter } from '../src/index.ts'

const SHARED_MCP_CONTROL_TOOLS = ['mcp_index', 'mcp_load']

describe('corumResearchToolFilter：MCP 共享控制工具并入 research deny', () => {
  it('★ readonlyResearch=true：deny 含 mcp_index/mcp_load + 平台变异工具', () => {
    const filter = corumResearchToolFilter({ deny: [...SHARED_MCP_CONTROL_TOOLS] }, true)
    expect(filter).toBeDefined()
    for (const name of SHARED_MCP_CONTROL_TOOLS) expect(filter!.deny).toContain(name)
    for (const name of corumMutationToolsForPlatform()) expect(filter!.deny).toContain(name)
  })

  it('readonlyResearch=false（worker）：不加任何 deny，共享工具对 worker 保持可用', () => {
    expect(corumResearchToolFilter({ deny: [...SHARED_MCP_CONTROL_TOOLS] }, false)).toBeUndefined()
  })

  it('deny 已含全部变异工具时走早退分支（语义不变，不因新增输入破坏）', () => {
    const all = [...corumMutationToolsForPlatform(), ...SHARED_MCP_CONTROL_TOOLS]
    expect(corumResearchToolFilter({ deny: all }, true)).toBeUndefined()
  })

  it('allow 透传不受影响', () => {
    const filter = corumResearchToolFilter({ allow: ['read'], deny: [...SHARED_MCP_CONTROL_TOOLS] }, true)
    expect(filter!.allow).toEqual(['read'])
    expect(filter!.deny).toContain('mcp_load')
  })
})