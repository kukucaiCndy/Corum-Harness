/**
 * rc3 工具块参数视图（`block.args`）：官方工具行渲染的**必读面**。
 *
 * ## 缺陷背景（2026-10-29 实机 console）
 *
 * 官方 `dsh-client-ui-tool` 的 `toolRowModel` 用 `block.args.complete/text/has/
 * stringLength` 取参数。corum fork 的块构建器只给 `argsRaw`、没给这个视图 ⇒
 * 打开一条真实 v4 历史会话时，每个**未被 fork 卡认领**的工具行都抛
 * `TypeError: Cannot read properties of undefined (reading 'text')`，被槽错误边界
 * 吞成一行错误占位（实测 66 个工具节点全崩、console 成对报错）。
 *
 * 本文件钉住视图的读者面语义（与官方 `PartialArguments` 的 sealed 视图同义）：
 * 读取器必须 **total**（缺字段/类型不符返回 undefined/false，绝不抛），
 * 因为工具行在任意历史数据上都会问。
 *
 * @module @corum/corum-ui-conversation/tests/tool-arguments
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_TOOL_ARGUMENTS, toolArguments } from '../src/client/tool-args.ts'

describe('toolArguments（sealed rc3 argument view）', () => {
  it('view 是 sealed（官方 preparing 分支只在未封口时读增量）', () => {
    expect(toolArguments('{"file_path":"/a/b.ts"}').isSealed).toBe(true)
    expect(EMPTY_TOOL_ARGUMENTS.isSealed).toBe(true)
  })

  it('complete/text/has/stringLength 对字符串字段同义可用（file_path 场景）', () => {
    const args = toolArguments(JSON.stringify({ file_path: '/Users/me/app/src/index.ts', offset: 10 }))
    expect(args.has('file_path')).toBe(true)
    expect(args.complete('file_path')).toBe(true)
    expect(args.text('file_path')).toBe('/Users/me/app/src/index.ts')
    expect(args.stringLength('file_path')).toBe('/Users/me/app/src/index.ts'.length)
    // 非字符串字段：has 真但 text 不可读（官方工具行的 `args.complete(x) ? args.text(x) : undefined` 组合）
    expect(args.has('offset')).toBe(true)
    expect(args.text('offset')).toBeUndefined()
  })

  it('缺字段/非对象/坏 JSON 一律 total（返回 undefined/false，不抛）', () => {
    for (const raw of ['', '{}', 'null', '[]', 'not-json', '{"a":', '{"a":1}']) {
      const args = toolArguments(raw)
      expect(() => args.text('description')).not.toThrow()
      expect(args.text('description')).toBeUndefined()
      expect(args.complete('description')).toBe(false)
      expect(args.has('description')).toBe(false)
      expect(args.stringLength('description')).toBeUndefined()
    }
  })

  it('description 场景（官方非文件工具走 args.text("description")）', () => {
    const args = toolArguments(JSON.stringify({ description: '搜索交接文档\n第二行' }))
    expect(args.complete('description')).toBe(true)
    expect(args.text('description')).toContain('搜索交接文档')
  })

  it('空视图常量：无字段、可安全读（窗口截断丢失调用头时的结果块用它）', () => {
    expect(EMPTY_TOOL_ARGUMENTS.has('file_path')).toBe(false)
    expect(EMPTY_TOOL_ARGUMENTS.complete('file_path')).toBe(false)
    expect(EMPTY_TOOL_ARGUMENTS.text('file_path')).toBeUndefined()
  })
})
