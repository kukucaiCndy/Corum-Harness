interface ShellWindow {
  id: number
  isDestroyed(): boolean
  webContents: { mainFrame: unknown }
}
interface Caller { sender: unknown; senderFrame: unknown }
export function createDefaultDirectoryWindowGuard(getMain: () => ShellWindow | null, getWindows: () => ShellWindow[]) {
  let migrating = false
  const assertCanCreateWindow = (): void => {
    if (migrating) throw new Error('默认会话目录正在迁移，请等待重连完成')
  }
  return {
    begin(event: Caller): void {
      const main = getMain()
      if (!main || main.isDestroyed() || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame) throw new Error('请从主窗口迁移默认会话目录')
      assertCanCreateWindow()
      if (getWindows().some(win => !win.isDestroyed() && win.id !== main.id)) throw new Error('请先关闭其它浮动或预览窗口，再迁移默认会话目录')
      migrating = true
    },
    finish: (): void => { migrating = false },
    assertCanCreateWindow,
  }
}
