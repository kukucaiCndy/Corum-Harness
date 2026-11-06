import { describe, expect, it } from 'vitest'
import { SessionArchiveController } from '../src/client/controller.ts'
import type { SessionArchiveBridge } from '../src/client/bridge.ts'

function setup(deleteSession: SessionArchiveBridge['deleteSession']) {
  const controller = new SessionArchiveController({
    saveSessionLog: async () => ({ path: null }),
    exportSessionsZip: async () => ({ path: null }),
    importSessionLog: async () => ({ imported: [], skipped: [] }),
    deleteSession,
  })
  controller.setManageRows(['archived-a', 'archived-b'].map(id => ({
    id, title: id, workspaceName: 'Windows 工作区', archivedAt: '2026-11-04',
  })))
  return controller
}

describe('归档管理删除边界', () => {
  it('只将所选会话 id 交给删除桥，保留其他归档和当前会话', async () => {
    const artifacts = new Set(['archived-a', 'archived-b', 'current-session'])
    const controller = setup(async id => ({ deleted: artifacts.delete(id) }))
    await controller.deleteArchived(['archived-b'])
    expect([...artifacts]).toEqual(['archived-a', 'current-session'])
    expect(controller.store.getSnapshot().manageEntry.outcome).toEqual({
      kind: 'delete', done: ['archived-b'], failed: [],
    })
  })

  it('原生确认取消不算删除成功，失败会指出准确的目标 id', async () => {
    const controller = setup(async id => id === 'archived-a'
      ? { deleted: false, cancelled: true }
      : { deleted: false, error: 'session is running' })
    await controller.deleteArchived(['archived-a', 'archived-b'])
    expect(controller.store.getSnapshot().manageEntry.outcome).toEqual({
      kind: 'delete', done: [], failed: [{ id: 'archived-b', error: 'session is running' }],
    })
  })

  it('已有删除批次等待确认时不启动另一个目标的删除', async () => {
    const artifacts = new Set(['archived-a', 'archived-b'])
    let confirm!: () => void
    const controller = setup(id => new Promise(resolve => {
      confirm = () => resolve({ deleted: artifacts.delete(id) })
    }))
    const pending = controller.deleteArchived(['archived-a'])
    await controller.deleteArchived(['archived-b'])
    confirm()
    await pending
    expect([...artifacts]).toEqual(['archived-b'])
    expect(controller.store.getSnapshot().manageEntry.outcome?.done).toEqual(['archived-a'])
  })
})
