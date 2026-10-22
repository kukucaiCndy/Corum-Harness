/**
 * 会话日志保存链路的单元测试（2026-09-16）。
 *
 * 背景：用户定调把「保存会话」入口从会话头部右上角搬到**会话栏会话行右键菜单**。
 * 入口搬到了 `corum-ide-sidebar-ui`（它经 cordis 服务 `sessionArchive` 拿能力），
 * 而**保存动作本身仍在 `SessionArchiveController`**（本包）。
 *
 * ⚠️ 为什么这一环必须用单测、不能用真机 CDP 断言（踩过，别再试）：
 * 真机侧 `window.corumDesktop` 是 preload 暴露的**冻结对象**
 * （实测 `isFrozen=true`、`saveSessionLog` 的 `writable=false / configurable=false`），
 * 所以在页面里替换桥方法来「拦截保存调用」会**静默失败**（补丁装不上），
 * 断言只会得到假 FAIL；而真点一下会弹出**真实的系统保存面板**，CDP 既关不掉也断言不了。
 * ⇒ 保存动作的正确调用（含「用的是哪一行会话的 id」）只能在这一层验。
 *
 * 覆盖：save 用**传入的会话 id** 调原生桥（一 id 一次）；并发同 id 复用一个 Promise；
 * 取消 ⇒ 静默（不 publish 任何状态）；成功 ⇒ publish path；失败 ⇒ publish error；
 * dispose 后的迟到请求被忽略。
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionArchiveController } from '../src/client/controller.ts'
import type { SessionArchiveBridge } from '../src/client/bridge.ts'

/** 造一个记录调用的假原生桥。 */
function fakeBridge(overrides: Partial<SessionArchiveBridge> = {}): {
  bridge: SessionArchiveBridge
  calls: string[]
} {
  const calls: string[] = []
  const bridge: SessionArchiveBridge = {
    saveSessionLog: (sessionId: string) => {
      calls.push(sessionId)
      return Promise.resolve({ path: `/tmp/${sessionId}.zip` })
    },
    exportSessionsZip: (sessionIds: string[]) => {
      calls.push(...sessionIds)
      return Promise.resolve({ path: `/tmp/batch-${sessionIds.join('-')}.zip` })
    },
    importSessionLog: () => Promise.resolve({ imported: [], skipped: [] }),
    deleteSession: () => Promise.resolve({ deleted: true }),
    ...overrides,
  }
  return { bridge, calls }
}

const SID = 'corum-task-abc123' as SessionId

describe('SessionArchiveController.save', () => {
  it('用**传入的那个会话 id** 调原生桥（菜单项搬位置后不许拿错行）', async () => {
    const { bridge, calls } = fakeBridge()
    const controller = new SessionArchiveController(bridge)
    await controller.save(SID)
    expect(calls).toEqual([SID])
  })

  it('成功 ⇒ publish { open: true, status: success, path }', async () => {
    const { bridge } = fakeBridge({
      saveSessionLog: () => Promise.resolve({ path: '/tmp/x.zip' }),
    })
    const controller = new SessionArchiveController(bridge)
    await controller.save(SID)
    expect(controller.store.getSnapshot().bySession[SID]).toEqual({
      open: true, status: 'success', path: '/tmp/x.zip', error: null,
    })
  })

  it('用户取消（path=null 且无 error）⇒ **静默**：不 publish 任何条目（不弹窗）', async () => {
    const { bridge } = fakeBridge({
      saveSessionLog: () => Promise.resolve({ path: null }),
    })
    const controller = new SessionArchiveController(bridge)
    await controller.save(SID)
    expect(controller.store.getSnapshot().bySession[SID]).toBeUndefined()
  })

  it('原生桥报错 ⇒ publish error 条目（弹窗有内容可显示）', async () => {
    const { bridge } = fakeBridge({
      saveSessionLog: () => Promise.resolve({ path: null, error: 'disk full' }),
    })
    const controller = new SessionArchiveController(bridge)
    await controller.save(SID)
    expect(controller.store.getSnapshot().bySession[SID]).toMatchObject({
      open: true, status: 'error', error: 'disk full',
    })
  })

  it('并发同 id 的两次手势复用**同一个**原生调用（菜单误双击不弹两个面板）', async () => {
    let resolveFn: ((v: { path: string | null }) => void) | undefined
    const saveSpy = vi.fn(() => new Promise<{ path: string | null }>((res) => { resolveFn = res }))
    const controller = new SessionArchiveController({
      saveSessionLog: saveSpy,
      exportSessionsZip: () => Promise.resolve({ path: '/tmp/batch.zip' }),
      importSessionLog: () => Promise.resolve({ imported: [], skipped: [] }),
      deleteSession: () => Promise.resolve({ deleted: true }),
    })
    const first = controller.save(SID)
    const second = controller.save(SID)
    expect(saveSpy).toHaveBeenCalledTimes(1)
    resolveFn?.({ path: '/tmp/y.zip' })
    await Promise.all([first, second])
    expect(saveSpy).toHaveBeenCalledTimes(1)
  })

  it('不同 id 并发 ⇒ 各自调用（互不串台）', async () => {
    const { bridge, calls } = fakeBridge()
    const controller = new SessionArchiveController(bridge)
    await Promise.all([
      controller.save('s-1' as SessionId),
      controller.save('s-2' as SessionId),
    ])
    expect(calls.sort()).toEqual(['s-1', 's-2'])
  })

  it('非桌面环境（无桥）⇒ 静默 resolve、不抛错（保存入口不炸 UI）', async () => {
    const controller = new SessionArchiveController(undefined)
    await expect(controller.save(SID)).resolves.toBeUndefined()
    expect(controller.store.getSnapshot().bySession[SID]).toBeUndefined()
  })

  it('dismissSave 关闭弹窗但保留结论（用户点「关闭」不改变已保存事实）', async () => {
    const { bridge } = fakeBridge({
      saveSessionLog: () => Promise.resolve({ path: '/tmp/z.zip' }),
    })
    const controller = new SessionArchiveController(bridge)
    await controller.save(SID)
    controller.dismissSave(SID)
    expect(controller.store.getSnapshot().bySession[SID]).toMatchObject({
      open: false, status: 'success', path: '/tmp/z.zip',
    })
  })
})

describe('SessionArchiveController.save 的 dispose 语义', () => {
  it('dispose 后迟到的完成结果被忽略（不 publish、不报错）', async () => {
    let resolveFn: ((v: { path: string | null }) => void) | undefined
    const controller = new SessionArchiveController({
      saveSessionLog: () => new Promise<{ path: string | null }>((res) => { resolveFn = res }),
      exportSessionsZip: () => Promise.resolve({ path: '/tmp/batch.zip' }),
      importSessionLog: () => Promise.resolve({ imported: [], skipped: [] }),
      deleteSession: () => Promise.resolve({ deleted: true }),
    })
    const pending = controller.save(SID)
    const disposed = controller.dispose()
    resolveFn?.({ path: '/tmp/late.zip' })
    await Promise.all([pending, disposed])
    expect(controller.store.getSnapshot().bySession[SID]).toBeUndefined()
  })
})
