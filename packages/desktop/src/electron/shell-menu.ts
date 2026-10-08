/**
 * 壳层「常驻入口」的共用菜单模板（菜单栏托盘 + Dock 右键菜单）。
 *
 * **为什么要共用**：macOS 上应用有两个常驻入口 —— 顶部菜单栏的 status item 与底部
 * Dock 图标。同一个应用在两个入口里给出**不一样的菜单**是常见事故源：用户记不住两套
 * 功能树，我们也会修一处漏一处（本仓已有「同一功能两处实现，占位那份盖住真实现」的
 * 前车之鉴，见 LESSONS §4.12）。所以菜单模板只在这里写一遍，`tray.ts` 与 `dock.ts`
 * 各自 `buildShellMenu()` 出一份实例（不共享同一个 Menu 对象实例：两处挂载时机与
 * 重建节奏不同，各自持有更省心）。
 *
 * **菜单保持极简**（5 个可点项 + 状态行）：常驻入口是「回到应用」的入口，不是第二个
 * 主界面 —— 调研报告里 LM Studio / Ollama 的长菜单正是用户抱怨的来源
 * （`docs/plan/RESEARCH-tray-menu-bar.md` §5.3-1）。
 *
 * @module corum-desktop/electron/shell-menu
 */

import { Menu, app } from 'electron'
import { getPlatformModule } from './platform/index.ts'

/** 未读状态（唯一权威源是主窗 renderer 的 store，经 IPC 推来）。 */
export interface ShellCount {
  unread: number
  total: number
}

/** 菜单动作与状态查询（由 `main.ts` 注入；本模块不持有窗口 / Dock 引用）。 */
export interface ShellMenuHost {
  /** 显示并聚焦主窗口（已隐藏则 show，已最小化则 restore）。 */
  showMainWindow(): void
  /** 显示主窗口并展开其中的通知中心。 */
  openNotificationCenter(): void
  /** 真正退出（走 `app.quit()` → `before-quit` 的会话 flush）。 */
  quit(): void
  /** 当前是否隐藏了 Dock 图标（只留菜单栏）。 */
  isDockHidden(): boolean
  /**
   * 切换 Dock 图标显隐。实现方负责落盘 + 应用 + **让两个菜单都重建**
   * （勾选态在另一份菜单实例里也显示着，只重建自己那份会造成两处不一致）。
   */
  setDockHidden(hidden: boolean): void
}

/** 状态行文案：「3 条未读 · 共 7 条」/「7 条通知 · 全部已读」/「暂无通知」。 */
export function statusLabel(count: ShellCount): string {
  if (count.total === 0) return '暂无通知'
  if (count.unread === 0) return `${count.total} 条通知 · 全部已读`
  return `${count.unread} 条未读 · 共 ${count.total} 条`
}

/**
 * 数字标签（菜单栏标题文字 / Dock 徽标共用）：超过 99 封顶为 `99+`。
 *
 * 为什么不写原值：三位数会把状态项撑宽、挤压右侧系统图标（菜单栏空间稀缺），
 * Dock 徽标同理会被撑成一条；且到那个量级精确值已无决策价值。与应用内 bell 的
 * `99+` 上限保持一致 —— 三处不同步会显得像 bug。
 * @param unread - 未读条数（调用方保证已钳成非负整数）。
 */
export function countLabel(unread: number): string {
  return unread > 99 ? '99+' : String(unread)
}

/**
 * 开机自启开关的状态。**OS 是唯一事实源**：用户在「系统设置 → 登录项」里改过之后，
 * 我们这边任何缓存都会撒谎，所以每次现读。
 */
export function loginItemOn(): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}

/**
 * 切换开机自启。
 *
 * dev 态必须显式给 `path` + `args`：打包态的 execPath 就是 app 本身，而 dev 态它是
 * `node_modules` 里的 Electron 二进制，不传参登录后只会打开一个空 Electron。
 * （Windows 未签名时不要传 `guid`：GUID 会与可执行路径永久绑定，见调研报告 §5.3-8。）
 * @param next - 目标状态。
 */
export function setLoginItem(next: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: next,
      ...app.isPackaged ? {} : { path: process.execPath, args: [process.argv[1] ?? ''] },
    })
  } catch (error) {
    process.stderr.write(`[corum-desktop] login item toggle failed: ${String(error)}\n`)
  }
}

/**
 * 构造常驻入口菜单（菜单栏托盘与 Dock 右键菜单共用这一份模板）。
 * @param count - 当前未读状态。
 * @param host - 菜单动作。
 * @returns 可直接交给 `tray.setContextMenu()` / `app.dock.setMenu()` 的菜单实例。
 */
export function buildShellMenu(count: ShellCount, host: ShellMenuHost): Menu {
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { host.showMainWindow() } },
    {
      label: count.unread > 0 ? `通知中心（${count.unread} 条未读）` : '通知中心',
      click: () => { host.openNotificationCenter() },
    },
    { type: 'separator' },
    // 状态行：零交互成本地表达「现在什么状态」（Docker 用同样的手法显示 paused）。
    { label: statusLabel(count), enabled: false },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: loginItemOn(),
      click: (item) => {
        setLoginItem(item.checked)
        // 回读一次：`setLoginItemSettings` 可能被系统策略拒绝，不回读就会出现
        // 「勾了但其实没生效」的假象（勾选态是这里唯一的反馈面）。
        item.checked = loginItemOn()
      },
    },
    // Dock 显隐项仅在「该平台有 Dock 能力」时才给（P1 能力显式化）：
    // capabilities.dock=false（Linux/Windows）时渲染它 = 点了没反应的假象
    // （§4.2 隐式假设「Dock 复选框在非 darwin 仍渲染」）。
    ...(getPlatformModule().capabilities.dock
      ? [{
          // 只留菜单栏（macOS accessory 模式）。缺省关闭：Dock 图标是「窗口丢了」时最稳的
          // 找回入口之一，不能默认拿掉（Ollama 因关窗后仍占 Dock 被抱怨，但反过来的
          // 一刀切同样有代价 —— 抉择权交给用户，且两个入口都不会因此消失）。
          label: '隐藏 Dock 图标（只留菜单栏）',
          type: 'checkbox' as const,
          checked: host.isDockHidden(),
          click: (item: { checked: boolean }) => {
            host.setDockHidden(item.checked)
          },
        }]
      : []),
    { type: 'separator' },
    { label: '退出 矩道 Corum', click: () => { host.quit() } },
  ])
  return menu
}
