/**
 * platform 能力契约（P1）：把散落的「隐式平台假设」收成**显式能力**。
 *
 * 核心纪律（docs/PLAN-2026-10-07 §3① / §7.1）：
 * - 平台能力用**显式布尔/枚举**表达，调用方不判 `null`、不猜；
 * - 「无此能力」是一个**事实**（如 Linux 当前无托盘），显式表达而非返回 null
 *   让调用方去悟——`capabilities.tray === false` 直接联动「关窗即退出」语义；
 * - 实现的**选择只跟随实际运行平台**（`getPlatform()` / `process.platform`），
 *   编译期特化只做瘦身，不做行为决策。
 *
 * 本目录只放 **corum 自有实现**（用户方案第 1 条）；与官方同源的 fork 包
 * （corum-fs-local 等）继续沿用官方「同级文件」惯例，不在此目录（已拍板边界 ⑤，
 * 同一包内不混用两种风格）。
 *
 * @module corum-desktop/electron/platform/contract
 */

/** 出包三平台（= `process.platform` 中我们出包的值）。 */
export type CorumPlatform = 'darwin' | 'linux' | 'win32'

/** 终端要 spawn 的 shell 与参数（terminal-shell 能力的返回形状）。 */
export interface TerminalShell {
  readonly shell: string
  readonly args: readonly string[]
}

/** 在文件管理器中「揭示选中」一个路径的命令（reveal 能力的返回形状）。 */
export interface RevealCommand {
  readonly cmd: string
  readonly args: readonly string[]
}

/** 窗口 Chrome（标题栏样式 + 红绿灯位置；window-chrome 能力的返回形状）。 */
export interface WindowChromeOptions {
  /** Electron `titleBarStyle`；macOS 用 'hiddenInset'，其它平台默认（undefined）。 */
  readonly titleBarStyle?: 'hiddenInset' | 'hidden' | 'default' | 'customButtonsOnHover'
  /** 红绿灯定位（仅 macOS 有效）。 */
  readonly trafficLightPosition?: { readonly x: number; readonly y: number }
}

/** safeStorage 密钥环后端（safe-storage 能力；Linux 必须显式选）。 */
export type SecretStore = 'keychain' | 'gnome-libsecret' | 'kwallet' | 'dpapi' | 'basic' | 'none'

/**
 * 平台能力表（显式布尔/枚举，调用方不猜）。
 *
 * `tray` / `dock` 为 `false` 是「该平台当前没有此能力」的**事实陈述**——
 * 不是「实现还没写」的占位。搬迁只让缺口**可见**（现在它们是一个假 `null`），
 * 不会让 Linux/Windows 长出托盘（那是功能缺口，需 AppIndicator 等实现，另计）。
 */
export interface PlatformCapabilities {
  readonly platform: CorumPlatform
  /** 是否有系统托盘（菜单栏常驻）。false ⇒ 关窗语义 = 退出应用。 */
  readonly tray: boolean
  /** 是否有 Dock 常驻能力（徽标/弹跳/显隐）。 */
  readonly dock: boolean
  /** 是否有全局指针（浮窗自动吸附的输入 HAL 可用）。 */
  readonly globalPointer: boolean
  /** 密钥环后端（safeStorage 用；'none' = 无可用后端，加密降级）。 */
  readonly secretStore: SecretStore
  /** 路径分隔符（渲染层路径拼接的事实源之一）。 */
  readonly pathSep: '\\' | '/'
}

/**
 * 一个平台的完整实现面。各能力函数返回**该平台的事实**；某能力不存在时，
 * 对应的 `create*` 返回 `null` 且 `capabilities` 里对应位为 `false` ——
 * 两者必须一致（capabilities 是声明，create 是实例化，不许一边说有一边说没有）。
 */
export interface PlatformModule {
  readonly capabilities: PlatformCapabilities
  /** 终端要 spawn 的 shell 与参数。 */
  terminalShell(): TerminalShell
  /** 在文件管理器中揭示选中（已三向完整，corum-fs.ts:308-312 为参照实现）。 */
  revealCommand(realPath: string, dirname: string): RevealCommand
  /**
   * 窗口 Chrome 选项（标题栏 + 红绿灯）。
   * @param kind - 窗口用途：主窗口与会话浮窗的红绿灯定标不同（各自对齐各自的
   *   顶栏卡片中线），故按用途区分；非 macOS 平台两者都返回 `{}`（系统标题栏）。
   */
  windowChromeOptions(kind: 'main' | 'floating'): WindowChromeOptions
  /** safeStorage 的 `password-store` 后端值（仅 Linux 需要显式给；其余返回 '' = 不设）。 */
  passwordStore(): string
}
