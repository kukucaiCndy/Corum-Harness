/**
 * 对话设置命名空间解析（`resolveChatNamespace`）—— E21「轨迹视图开关落盘」的根因回归网。
 *
 * ## 钉住的缺陷（2026-11-07 实测）
 *
 * `SettingsAdvancedSection` 曾把 ns 硬编码成 `'ui-chat'`。rc3 起 ns = entry id：IDE 模式在册的
 * 是 `corum-chat`（官方 `ui-chat` 行被禁用）⇒ 读恒回退默认值、`mutate` 抛
 * `No configurable plugin entry "ui-chat"`，**开关永远不落盘**，而界面上看不出错（默认值恰好
 * 就是 compact）。用例 E21 因此失败。
 *
 * ## 这里钉什么
 *
 *   ① 两种模式各自能解析到**在册**的那个 ns（IDE = `corum-chat`，minimal = `ui-chat`）；
 *   ② 两者都在册时**优先** `corum-chat`（rc3 IDE 的真实形态）；
 *   ③ 都不在册时返回 `undefined` —— 调用方据此**如实报错并禁用控件**，绝不猜一个不存在的 ns；
 *   ④ 源码不变式：`SettingsAdvancedSection` 不再把 ns 硬编码进 `mutate`（防止有人改回去）。
 *
 * ⚠️ 这一组只看「解析对不对」，不证明写入成功；写入闭环由用例 E21 的实机 run 证明
 *（docs/evidence/rc3-settings-behavior-batch1-2026-11-07.md）。
 *
 * @module @corum/corum-ide-ui/tests/chat-ns-resolution
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHAT_NS_CANDIDATES, resolveChatNamespace } from '../src/client/settings/chat-ns.ts'

/** 造一个最小命名空间列表。 */
function namespaces(...ids: string[]): { ns: string; revision?: number }[] {
  return ids.map(ns => ({ ns }))
}

describe('resolveChatNamespace — 按在册情况解析 chat 设置 ns', () => {
  it('IDE 模式（只有 corum-chat 在册）解析到 corum-chat', () => {
    expect(resolveChatNamespace(namespaces('corum-chat', 'llm-deepseek'))?.ns).toBe('corum-chat')
  })

  it('minimal/官方模式（只有 ui-chat 在册）解析到 ui-chat', () => {
    expect(resolveChatNamespace(namespaces('ui-chat', 'llm-deepseek'))?.ns).toBe('ui-chat')
  })

  it('两者都在册时优先 corum-chat（rc3 IDE 的真实形态）', () => {
    expect(resolveChatNamespace(namespaces('ui-chat', 'corum-chat'))?.ns).toBe('corum-chat')
    // 顺序无关：结果不取决于列表顺序，只取决于候选优先级
    expect(resolveChatNamespace(namespaces('corum-chat', 'ui-chat'))?.ns).toBe('corum-chat')
  })

  it('都不在册 ⇒ undefined（调用方据此如实报错并禁用，不猜 ns）', () => {
    expect(resolveChatNamespace(namespaces('llm-deepseek'))).toBeUndefined()
    expect(resolveChatNamespace([])).toBeUndefined()
    expect(resolveChatNamespace(undefined)).toBeUndefined()
  })

  it('返回的是**在册的那一项**（带 revision，供乐观并发控制）', () => {
    const hit = resolveChatNamespace([{ ns: 'corum-chat', revision: 7 }])
    expect(hit?.revision).toBe(7)
  })

  it('候选顺序是 corum-chat → ui-chat（与 rc3 的 ns=entry-id 现实一致）', () => {
    expect([...CHAT_NS_CANDIDATES]).toEqual(['corum-chat', 'ui-chat'])
  })
})

describe('源码不变式：高级页不再硬编码单个 ns 去写', () => {
  const src = readFileSync(
    join(import.meta.dirname, '..', 'src/client/settings/sections/SettingsAdvancedSection.tsx'),
    'utf8',
  )

  it('用解析结果（targetNs / ns?.ns）写入，而不是字面量 ns', () => {
    expect(src).toContain('resolveChatNamespace')
    expect(src).toContain('settings.mutate(targetNs')
    // 历史缺陷形态：把字面量直接喂给 mutate
    expect(src).not.toContain("settings.mutate('ui-chat'")
    expect(src).not.toContain("settings.mutate('corum-chat'")
  })

  it('ns 不在册时如实报错（不静默吞掉写入失败）', () => {
    expect(src).toContain('命名空间不在册')
  })
})
