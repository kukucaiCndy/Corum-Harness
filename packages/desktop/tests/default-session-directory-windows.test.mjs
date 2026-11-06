import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultDirectoryWindowGuard } from '../src/electron/default-session-directory-windows.ts'
const win = (id, destroyed = false) => ({ id, isDestroyed: () => destroyed, webContents: { mainFrame: {} } })
function fixture() {
  const main = win(1), floating = win(2); let windows = [main]
  const guard = createDefaultDirectoryWindowGuard(() => main, () => windows)
  const caller = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  return { guard, main, floating, caller, windows: value => { windows = value } }
}
test('主窗单独存在允许迁移，并锁住floating/preview直到reload完成', () => {
  const x = fixture(); x.guard.begin(x.caller); assert.throws(() => x.guard.assertCanCreateWindow(), /迁移/); assert.throws(() => x.guard.begin(x.caller), /迁移/)
  x.guard.finish(); assert.doesNotThrow(() => x.guard.assertCanCreateWindow()); x.guard.begin(x.caller)
})
test('隐藏浮窗和预览均拒绝，已销毁窗口不计；拒绝后不持有锁', () => {
  const x = fixture(); for (const extra of [x.floating, win(3)]) { x.windows([x.main, extra]); assert.throws(() => x.guard.begin(x.caller), /关闭.*窗口/); assert.doesNotThrow(() => x.guard.assertCanCreateWindow()) }
  x.windows([x.main, win(4, true)]); assert.doesNotThrow(() => x.guard.begin(x.caller))
})
test('浮窗和子frame不能发起迁移', () => {
  const x = fixture(); assert.throws(() => x.guard.begin({ sender: x.floating.webContents, senderFrame: x.floating.webContents.mainFrame }), /主窗口/)
  assert.throws(() => x.guard.begin({ sender: x.main.webContents, senderFrame: {} }), /主窗口/)
})
test('preview异步resolve后重新检查，堵住检查与实际建窗之间的竞争', async () => {
  const x = fixture(); let resolve; let created = false
  const preview = (async () => { x.guard.assertCanCreateWindow(); await new Promise(done => { resolve = done }); x.guard.assertCanCreateWindow(); created = true })()
  x.guard.begin(x.caller); resolve(); await assert.rejects(preview, /迁移/); assert.equal(created, false)
})
