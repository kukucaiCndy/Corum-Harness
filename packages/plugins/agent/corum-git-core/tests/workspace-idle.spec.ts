/**
 * host 侧 idle 门禁的路径判据（`isSameWorkspace`）回归（2026-11-26）。
 *
 * ## 为什么这条判据需要单测
 *
 * idle 门禁要回答的问题是「**这棵工作树**此刻有没有 agent 在写」。判据错一侧都有代价：
 *   · 误判为「同一工作区」⇒ 用户正常操作被挡（面板看着能点，点了报错）；
 *   · 误判为「不同工作区」⇒ 另一个 agent 正在写的工作树被切分支换掉，改动丢失。
 *
 * 故这里钉住「归一化后等价」的边界：末尾分隔符、相对路径、兄弟目录前缀。
 * 符号链接 / 大小写不敏感文件系统上的等价性**刻意不覆盖**——见实现处说明：
 * 宁可漏判（放行）也不误判（把用户挡掉），UI 侧另有一道 `running` 判据。
 */
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSameWorkspace } from '../src/index.ts'

describe('isSameWorkspace', () => {
  it('同一路径等价', () => {
    const base = join(tmpdir(), 'ws-a')
    expect(isSameWorkspace(base, base)).toBe(true)
  })

  it('末尾分隔符不影响等价', () => {
    const base = join(tmpdir(), 'ws-a')
    expect(isSameWorkspace(base + sep, base)).toBe(true)
  })

  it('不同目录不等价', () => {
    expect(isSameWorkspace(join(tmpdir(), 'ws-a'), join(tmpdir(), 'ws-b'))).toBe(false)
  })

  it('同前缀的兄弟目录不等于父目录（不按字符串前缀判断）', () => {
    expect(isSameWorkspace(join(tmpdir(), 'ws-a'), join(tmpdir(), 'ws-a-sibling'))).toBe(false)
  })

  it('相对路径靠 resolve 归一后等价', () => {
    expect(isSameWorkspace('.', process.cwd())).toBe(true)
  })
})
