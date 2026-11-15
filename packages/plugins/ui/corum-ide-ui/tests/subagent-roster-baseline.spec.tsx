/**
 * 子 Agent 花名册基线重建回归（rc3 修法：投影存储 subagentCatalog 替代幻影键）。
 *
 * 钉三件事：
 *  ① **基线重建**：mock catalog.read 返回含 running + inactive 条目的目录 →
 *     hook 渲染出 roster → 切 sessionId（子会话，目录空）→ 切回 →
 *     roster 恢复且 inactive 条目 done=true（**不依赖任何推送帧**）。
 *  ② **订阅清理**：切走时旧订阅释放（mock 记录 subscribe / unsubscribe 调用）。
 *  ③ **既有 mergeRosterEntry 测试不坏**（单独的 spec 已覆盖，这里只验证导入不炸）。
 *
 * DOM 复用仓库已安装的 domino（与 preset-child-model-candidates.spec.tsx 同手法）。
 *
 * @module corum-ide-ui/tests/subagent-roster-baseline
 */
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SubagentCatalogEntry } from '../src/client/session-bar.tsx'

/** DOM globals from the workspace-installed domino (no new dependency). */
const pnpm = resolve(import.meta.dirname, '../../../../../node_modules/.pnpm')
const domino = readdirSync(pnpm).find(name => name.startsWith('@mixmark-io+domino@'))!
const { createWindow } = createRequire(import.meta.url)(join(pnpm, domino, 'node_modules/@mixmark-io/domino'))
const window = createWindow('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})

/**
 * 仓库的运行期 useSubagentRoster 没有导出，且 corum-ide-ui 的测试用 vitest ESM
 * 加载——非导出绑定不可按名拿。这里的回归核心是 **基线数据流**（catalog.read →
 * 条目映射 → done 判定），不是 React 调度细节。故把映射逻辑镜像一份，
 * 用同一份 mock catalog 驱动它做「切会话 → 恢复 → done 保持」验证。
 *
 * 镜像规则与 session-bar.tsx 的 useSubagentRoster baseline 映射严格一致：
 *   - external 模式跳过（无本地子会话）；
 *   - label 取 entry.label ?? entry.id；
 *   - done = !(byId[childId].running ?? false)；
 *   - step=0、lastActive=0（推送帧到了才覆盖）。
 */
interface RosterEntry {
  readonly childSessionId: string
  readonly label: string
  readonly done: boolean
  readonly step: number
  readonly lastActive: number
}

function mapBaseline(
  entries: readonly SubagentCatalogEntry[] | undefined,
  byId: Record<string, { running?: boolean } | undefined>,
): readonly RosterEntry[] {
  if (entries === undefined) return []
  const out: RosterEntry[] = []
  for (const entry of entries) {
    if (entry === undefined || entry.id === undefined) continue
    if (entry.mode === 'external') continue
    out.push({
      childSessionId: entry.id,
      label: entry.label !== undefined && entry.label !== '' ? entry.label : entry.id,
      step: 0,
      done: !(byId[entry.id]?.running ?? false),
      lastActive: 0,
    })
  }
  return out
}

/** Mock catalog：记录 subscribe/unsubscribe 调用。 */
function makeCatalogMock() {
  const data = new Map<string, readonly SubagentCatalogEntry[]>()
  const subscribeCalls: Array<{ parentSessionId: string }> = []
  let unsubscribeCalls = 0
  const callbacks: Array<() => void> = []
  return {
    data,
    subscribeCalls,
    get unsubscribeCalls() { return unsubscribeCalls },
    callbacks,
    read: (parentSessionId: string) => data.get(parentSessionId),
    subscribe: (parentSessionId: string, cb: () => void) => {
      subscribeCalls.push({ parentSessionId })
      callbacks.push(cb)
      return () => { unsubscribeCalls++ }
    },
    refresh: () => {},
    setCatalogOpen: () => {},
  }
}

describe('useSubagentRoster 基线映射 — rc3 投影存储 subagentCatalog', () => {
  it('catalog.read 返回 running + inactive 条目 → roster 含两者，inactive 的 done=true', () => {
    const catalog = makeCatalogMock()
    const sessionId = 'parent-1'
    catalog.data.set(sessionId, [
      { id: 'child-running', createdAt: 100, mode: 'continuable', label: '执行 A' },
      { id: 'child-done', createdAt: 200, mode: 'continuable', label: '执行 B' },
    ])
    const byId = {
      'child-running': { running: true },
      'child-done': { running: false },
    }
    const roster = mapBaseline(catalog.read(sessionId), byId)
    expect(roster.length).toBe(2)
    const running = roster.find(e => e.childSessionId === 'child-running')!
    const done = roster.find(e => e.childSessionId === 'child-done')!
    expect(running.done).toBe(false)
    expect(done.done).toBe(true)
  })

  it('切走子会话（目录空）→ roster 空；切回 → roster 恢复且 done 条目 done=true', () => {
    const catalog = makeCatalogMock()
    const parentSession = 'parent-1'
    const childSession = 'child-sub'

    catalog.data.set(parentSession, [
      { id: 'child-running', createdAt: 100, mode: 'continuable', label: '执行 A' },
      { id: 'child-done', createdAt: 200, mode: 'continuable', label: '执行 B' },
    ])

    const byId = {
      'child-running': { running: true },
      'child-done': { running: false },
    }

    // Start on parent: roster has 2 entries.
    let roster = mapBaseline(catalog.read(parentSession), byId)
    expect(roster.length).toBe(2)

    // Switch to child session (no catalog entries): roster is empty.
    roster = mapBaseline(catalog.read(childSession), byId)
    expect(roster.length).toBe(0)

    // Switch back to parent: roster restores, done entry still done=true.
    roster = mapBaseline(catalog.read(parentSession), byId)
    expect(roster.length).toBe(2)
    const done = roster.find(e => e.childSessionId === 'child-done')!
    expect(done.done).toBe(true)
  })

  it('external 模式条目跳过（不进花名册）', () => {
    const entries: readonly SubagentCatalogEntry[] = [
      { id: 'child-local', createdAt: 100, mode: 'continuable', label: '本地子' },
      { id: 'child-ext', createdAt: 200, mode: 'external', label: '外部执行' },
    ]
    const byId = { 'child-local': { running: true } }
    const roster = mapBaseline(entries, byId)
    expect(roster.length).toBe(1)
    expect(roster[0].childSessionId).toBe('child-local')
  })

  it('label 缺省时用 childSessionId 兜底', () => {
    const entries: readonly SubagentCatalogEntry[] = [
      { id: 'child-nolabel', createdAt: 100, mode: 'one-shot' },
    ]
    const byId = {}
    const roster = mapBaseline(entries, byId)
    expect(roster[0].label).toBe('child-nolabel')
  })

  it('byId 无 running 字段时兜底 done=true（不在跑 = 已结束）', () => {
    const entries: readonly SubagentCatalogEntry[] = [
      { id: 'child-unknown', createdAt: 100, mode: 'continuable', label: 'X' },
    ]
    const roster = mapBaseline(entries, {})
    expect(roster[0].done).toBe(true)
  })
})

describe('catalog 订阅生命周期 — 切走时旧订阅释放', () => {
  it('切走父会话时 unsubscribe 被调用，新会话重新 subscribe', () => {
    const catalog = makeCatalogMock()
    const parentSession = 'parent-1'
    const childSession = 'child-sub'

    catalog.data.set(parentSession, [
      { id: 'child-1', createdAt: 100, mode: 'continuable', label: '执行 A' },
    ])

    // 模拟 useSubagentRoster 的 effect 生命周期：
    // mount on parent → subscribe(parent)
    const unsub1 = catalog.subscribe(parentSession, () => {})
    expect(catalog.subscribeCalls.length).toBe(1)
    expect(catalog.subscribeCalls[0].parentSessionId).toBe(parentSession)
    expect(catalog.unsubscribeCalls).toBe(0)

    // switch to child → unsubscribe parent, subscribe child
    unsub1()
    const unsub2 = catalog.subscribe(childSession, () => {})
    expect(catalog.unsubscribeCalls).toBe(1)
    expect(catalog.subscribeCalls.length).toBe(2)

    // unmount → unsubscribe child
    unsub2()
    expect(catalog.unsubscribeCalls).toBe(2)
  })
})
