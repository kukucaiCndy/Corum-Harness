/**
 * ComposerBlockRegistry 守卫 —— 「别的插件让这个会话的输入框变灰」的唯一通道。
 *
 * 这条通道存在的理由是**依赖方向**：会知道"为什么不能输入"的插件
 * （模型选择、权限档位）在依赖树上位于 conversation 的**下游**，所以 conversation
 * 不能反向读它们，只能由它们往上推。既然是一个注册表，它的正确性就全在两条上：
 *
 * 1. **每个会话一个身份稳定的 store** —— 若 `storeFor` 每次新建，订阅方（输入条）
 *    会持有旧 store 永不更新，表现为"变灰了但再也不会恢复"。
 * 2. **按 reason 去重** —— 同一个 reason 重复 set 不发布，避免下游每次渲染
 *    都触发一次全树刷新。
 *
 * 第 2 条还隐含一个**故意**的语义：只有 reason 变才发布，所以"同一个文案但
 * 内部状态变了"不会引起重渲。这是刻意的节流，不是缺陷。
 */
import { describe, expect, it, vi } from 'vitest'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'
import type { ComposerBlock } from '../src/client/contract/composer-blocks.ts'

const sessionA = 'session-a' as never
const sessionB = 'session-b' as never

function block(reason: string): ComposerBlock {
  return { reason }
}

describe('ComposerBlockRegistry · store 身份', () => {
  it('同一会话重复取 store ⇒ 同一个实例', () => {
    const registry = new ComposerBlockRegistry()
    expect(registry.storeFor(sessionA)).toBe(registry.storeFor(sessionA))
  })

  it('不同会话 ⇒ 不同实例', () => {
    const registry = new ComposerBlockRegistry()
    expect(registry.storeFor(sessionA)).not.toBe(registry.storeFor(sessionB))
  })

  it('未设置过的会话 ⇒ 初始快照是 undefined', () => {
    const registry = new ComposerBlockRegistry()
    expect(registry.storeFor(sessionA).getSnapshot()).toBeUndefined()
  })

  it('forget 之后重新取 ⇒ 新实例且回到 undefined', () => {
    const registry = new ComposerBlockRegistry()
    const before = registry.storeFor(sessionA)
    registry.set(sessionA, block('不可用'))
    expect(before.getSnapshot()).toEqual(block('不可用'))

    registry.forget(sessionA)
    const after = registry.storeFor(sessionA)
    expect(after).not.toBe(before)
    expect(after.getSnapshot()).toBeUndefined()
  })

  it('forget 一个未被记录的会话不抛错', () => {
    const registry = new ComposerBlockRegistry()
    expect(() => { registry.forget(sessionA) }).not.toThrow()
  })
})

describe('ComposerBlockRegistry · set 语义', () => {
  it('set 后 store 快照是该 block', () => {
    const registry = new ComposerBlockRegistry()
    registry.set(sessionA, block('会话不可用'))
    expect(registry.storeFor(sessionA).getSnapshot()).toEqual(block('会话不可用'))
  })

  it('set 到另一个会话不影响本会话', () => {
    const registry = new ComposerBlockRegistry()
    registry.set(sessionA, block('a'))
    expect(registry.storeFor(sessionB).getSnapshot()).toBeUndefined()
  })

  it('set(undefined) 清除阻塞', () => {
    const registry = new ComposerBlockRegistry()
    registry.set(sessionA, block('x'))
    registry.set(sessionA, undefined)
    expect(registry.storeFor(sessionA).getSnapshot()).toBeUndefined()
  })

  it('订阅者能收到变更', () => {
    const registry = new ComposerBlockRegistry()
    const store = registry.storeFor(sessionA)
    const listener = vi.fn()
    store.subscribe(listener)
    registry.set(sessionA, block('x'))
    expect(listener).toHaveBeenCalled()
  })

  it('同 reason 重复 set ⇒ 不发布（按文案节流）', () => {
    const registry = new ComposerBlockRegistry()
    registry.set(sessionA, block('same'))
    const store = registry.storeFor(sessionA)
    const listener = vi.fn()
    store.subscribe(listener)
    registry.set(sessionA, block('same'))
    expect(listener).not.toHaveBeenCalled()
  })

  it('reason 改变 ⇒ 发布', () => {
    const registry = new ComposerBlockRegistry()
    registry.set(sessionA, block('one'))
    const store = registry.storeFor(sessionA)
    const listener = vi.fn()
    store.subscribe(listener)
    registry.set(sessionA, block('two'))
    expect(listener).toHaveBeenCalled()
    expect(store.getSnapshot()).toEqual(block('two'))
  })

  it('清除 undefined 重复调用 ⇒ 不发布', () => {
    const registry = new ComposerBlockRegistry()
    const store = registry.storeFor(sessionA)
    const listener = vi.fn()
    store.subscribe(listener)
    registry.set(sessionA, undefined)
    expect(listener).not.toHaveBeenCalled()
  })

  it('set 会自动创建 store（无需先 storeFor）', () => {
    const registry = new ComposerBlockRegistry()
    registry.set(sessionA, block('x'))
    const store = registry.storeFor(sessionA)
    expect(store.getSnapshot()).toEqual(block('x'))
  })
})
