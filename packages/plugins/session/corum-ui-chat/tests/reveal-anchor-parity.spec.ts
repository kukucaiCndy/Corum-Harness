/**
 * 「能进入子会话」的卡片必须**可被定位**（锚点对账；2026-09-18 用户报「编排模式的卡片
 * 跳不过去」）。
 *
 * 背景：详情卡的 `⌖` 跳转按钮按 `data-child-session-id` 找目标（`revealSubagentCard`）。
 * 这条链是**两处分别维护**的：一张卡提供「进入子会话」入口（`openSession`），就**必须**
 * 同时把 `data-child-session-id` 挂在自己的根节点上。缺一处，按钮就只对部分卡片类型生效
 * ——`OrchestrateCard` 的每个分支都解析出了 childSessionId、也有进入入口，却漏了锚点，
 * 于是「对编排模式的卡片不起作用」。
 *
 * 为什么用源码扫描而不是渲染测试：这类缺口是「新增一种卡片忘了挂锚点」，发生在**跨组件**
 * 的一致性上，而本仓的 UI 测试装置没有渲染整棵瀑布的成本位；扫描能精确拦住这个形态，
 * 且新增卡片类型时自动生效（扫描失败信息里点名是哪个文件）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// ⚠️ 用 `fileURLToPath`，不要用 `URL.pathname`：Windows 上后者是 `/D:/a/…`（前导斜杠 +
// 盘符），`readFileSync` 会拼成 `D:\D:\a\…` ⇒ ENOENT（2026-10-21 Windows leg 实测）。
const CHAT_DIR = fileURLToPath(new URL('../src/client/chat/', import.meta.url))

describe('子会话卡片锚点对账（能进入子会话 ⇒ 必须可被定位）', () => {
  const files = readdirSync(CHAT_DIR).filter(name => name.endsWith('.tsx'))
  const withEntry: string[] = []
  const offenders: string[] = []
  for (const name of files) {
    const src = readFileSync(join(CHAT_DIR, name), 'utf8')
    // 两种调用形态都要认：`openSession(id)` 与 `openSession?.(id)`
    if (!/openSession\s*\??\.?\s*\(/.test(src)) continue
    withEntry.push(name)
    if (!src.includes('data-child-session-id')) offenders.push(name)
  }

  it('扫描确实覆盖到了提供「进入子会话」入口的组件（防扫描自身失效）', () => {
    // SubagentCard（单发委派）+ OrchestrateCard（编排分支/集成者）
    expect(withEntry).toContain('SubagentCard.tsx')
    expect(withEntry).toContain('OrchestrateCard.tsx')
  })

  it('★ 每个提供「进入子会话」入口的文件都挂了 data-child-session-id 锚点', () => {
    expect(offenders, `这些文件提供了进入子会话的入口却没有锚点，详情卡的跳转按钮会对它们失效：${offenders.join(', ')}`)
      .toEqual([])
  })

  it('编排卡：分支卡与收尾节点卡都带锚点（本次修复的具体对象）', () => {
    const src = readFileSync(join(CHAT_DIR, 'OrchestrateCard.tsx'), 'utf8')
    expect(src).toContain('className={css.branchCard} data-child-session-id={child || undefined}')
    // 2026-10 编排黑盒化：收尾节点由「集成者卡（mergeCard / data-integrator）」改成
    // 「收尾卡（mergeCard / data-closer）」——锚点义务不变，仍是同一张卡上的同一处。
    expect(src).toMatch(/mergeCard[\s\S]{0,200}data-child-session-id=\{integratorChild \|\| undefined\}/)
  })
})
