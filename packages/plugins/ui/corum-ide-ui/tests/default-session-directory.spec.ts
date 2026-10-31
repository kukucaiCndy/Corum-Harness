import { describe, it, expect } from 'vitest'
import * as directory from '../src/client/settings/sections/default-session-directory-controller.ts'
const status: directory.DefaultDirectoryStatus = { root: 'E:/sessions', sessionCount: 3, migration: null }
function setup() {
  const calls: string[] = []
  const notices: unknown[] = []
  let dirty = false
  let finish!: (value: typeof status) => void
  let fail!: (error: Error) => void
  const api = {
    getDefaultSessionDirectory: async () => status,
    pickDefaultSessionDirectory: async (): Promise<string | null> => null,
    migrateDefaultSessionDirectory: (path: string) => { calls.push(path); return new Promise<typeof status>((resolve, reject) => { finish = resolve; fail = reject }) },
    reloadDefaultSessionDirectory: async (options?: { notice: 'migrated' | 'restored' }) => { calls.push('reload'); notices.push(options) },
  }
  const controller = directory.createDefaultDirectoryController(api, () => dirty)
  return { controller, api, calls, notices, dirty: () => { dirty = true }, finish: (result = status) => finish(result), fail: () => fail(new Error('停机失败')) }
}
describe('默认目录迁移交互', () => {
  it('读取完整路径；取消选择不修改配置', async () => {
    const x = setup(); await x.controller.load(); await x.controller.pick()
    expect(x.controller.getSnapshot()).toMatchObject({ status, target: null, busy: false })
    expect(x.calls).toEqual([])
  })
  it('选择后只确认目标和数量，最终点击才迁移；busy 拒绝重复提交', async () => {
    const x = setup(); x.api.pickDefaultSessionDirectory = async () => 'C:/new'; await x.controller.load(); await x.controller.pick()
    expect(x.controller.getSnapshot()).toMatchObject({ target: 'C:/new', status })
    expect(x.calls).toEqual([])
    const pending = x.controller.migrate(); await x.controller.migrate()
    expect(x.controller.getSnapshot().busy).toBe(true); expect(x.calls).toEqual(['C:/new'])
    x.finish(); await pending
    expect(x.calls).toEqual(['C:/new', 'reload'])
    expect(x.notices).toEqual([{ notice: 'migrated' }])
    expect(x.controller.getSnapshot().busy).toBe(true)
  })
  it('最终确认重新查询 dirty，拒绝迁移并要求先保存', async () => {
    const x = setup(); x.api.pickDefaultSessionDirectory = async () => 'C:/new'; await x.controller.load(); await x.controller.pick(); x.dirty(); await x.controller.migrate()
    expect(x.calls).toEqual([]); expect(x.controller.getSnapshot().error).toContain('保存')
  })
  it('直接抛错展示实际原因，允许重试，不 reload 或宣称已恢复', async () => {
    const x = setup(); x.api.pickDefaultSessionDirectory = async () => 'C:/new'; await x.controller.load(); await x.controller.pick(); const pending = x.controller.migrate(); x.fail(); await pending
    expect(x.calls).toEqual(['C:/new']); expect(x.controller.getSnapshot()).toMatchObject({ busy: false, error: '停机失败' })
  })
  it('轮询进度和等待恢复时保持 busy', async () => {
    const x = setup(); x.api.pickDefaultSessionDirectory = async () => 'C:/new'; await x.controller.load(); await x.controller.pick(); const pending = x.controller.migrate()
    x.api.getDefaultSessionDirectory = async () => ({ ...status, error: '等待旧进程退出', migration: { phase: 'files', completed: 1, total: 3 } })
    await x.controller.load(); expect(x.controller.getSnapshot()).toMatchObject({ busy: true, status: { error: '等待旧进程退出' } })
    x.finish(); await pending; expect(x.calls.at(-1)).toBe('reload')
  })
  it('resolve 带失败结果仍 reload，并明确传递恢复结果', async () => {
    const x = setup(); x.api.pickDefaultSessionDirectory = async () => 'C:/new'; await x.controller.load(); await x.controller.pick(); const pending = x.controller.migrate()
    x.finish({ ...status, error: '目标目录已存在，已恢复原位置' }); await pending
    expect(x.calls).toEqual(['C:/new', 'reload']); expect(x.notices).toEqual([{ notice: 'restored' }])
  })
  it('编辑器能力未就绪时拒绝迁移，保留具体原因', async () => {
    const x = setup(); const controller = directory.createDefaultDirectoryController(x.api, () => { throw new Error('编辑器状态尚未就绪') })
    x.api.pickDefaultSessionDirectory = async () => 'C:/new'; await controller.load(); await controller.pick(); await controller.migrate()
    expect(x.calls).toEqual([]); expect(controller.getSnapshot()).toMatchObject({ busy: false, error: '编辑器状态尚未就绪' })
  })
  it('取消确认及同位置选择不写配置，忙碌时不能取消后继续编辑', async () => {
    const x = setup(); await x.controller.load(); x.api.pickDefaultSessionDirectory = async () => status.root; await x.controller.pick()
    expect(x.controller.getSnapshot().target).toBe(null)
    x.api.pickDefaultSessionDirectory = async () => 'C:/new'; await x.controller.pick(); x.controller.cancel(); expect(x.controller.getSnapshot().target).toBe(null)
    await x.controller.pick(); const pending = x.controller.migrate(); x.controller.cancel()
    expect(x.controller.getSnapshot()).toMatchObject({ busy: true, target: 'C:/new' }); x.finish(); await pending
  })
})
