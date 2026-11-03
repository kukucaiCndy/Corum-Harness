/**
 * scan-settings —— 自动扫描的「开关 + 间隔」存放处。
 *
 * ## 为什么不再放在 `cdp-targets.json` 里（2026-11-03 实测事故）
 *
 * 该键最初作为配置文件的顶层字段 `scanIntervalMs` 引入。问题在于**旧版 cdp-router
 * 对未知顶层键是 fail loud 的**：
 *
 * ```js
 * for (const key of Object.keys(record)) {
 *   if (!ALLOWED_TOP_KEYS.has(key)) throw new CdpTargetsConfigError(...)
 * }
 * ```
 *
 * 于是「用新版写过一次配置」⇒「换回旧版（安装包里的、或另一个 checkout 的）读配置」
 * ⇒ 抛错 ⇒ **整份配置作废，连 targets 都读不出来**。实测复现：某个跑旧版插件的
 * 实例上报 `顶层含未知键 "scanIntervalMs"`，targets 归零。
 *
 * 而 `cdp-targets.json` 是**跨版本共享**的文件（它就是「测哪个实例」的唯一事实源），
 * 不能因为一个纯 UI 偏好而让整份文件在新旧版之间互不兼容。
 *
 * ## 所以搬进 settings 命名空间
 *
 * `settings` 天生就是「有 schema、缺省有默认值、未知键不致命」的存储，正是这类
 * 用户偏好的正确归属；而且它随 `$CORUM_HOME` 走，不写进 targets 配置文件，
 * 旧版读 targets 时**根本看不到这个键**，兼容性自然成立。
 *
 * 迁移：`readLegacyScanInterval()` 读一次旧字段（若用户配置里还有），
 * 用它作为 settings 的初始值，然后再写回配置时**抹掉**该键。
 *
 * @module @corum/corum-cdp-router/scan-settings
 */

/** settings 命名空间名（`settings.yaml` 里的键）。 */
export const SCAN_SETTINGS_NAMESPACE = 'corum-cdp-router'

/** 自动扫描设置的形状（settings 内的一个对象字段）。 */
export interface ScanSettings {
  /** 是否按间隔自动扫描本机实例。关掉即不挂定时器、启动也不扫。 */
  readonly autoScan: boolean
  /** 扫描间隔（毫秒）。 */
  readonly scanIntervalMs: number
}

/** 间隔允许区间：30 秒 ~ 1 小时。 */
export const SCAN_INTERVAL_MIN_MS = 30_000
export const SCAN_INTERVAL_MAX_MS = 3_600_000

/** 缺省值：开 + 5 分钟。 */
export const SCAN_SETTINGS_DEFAULT: ScanSettings = {
  autoScan: true,
  scanIntervalMs: 300_000,
}

/**
 * 把任意外部取值规范化成合法间隔。
 *
 * 越界或非整数一律回落到默认值，**不抛错** —— 这个值来自设置面或旧配置，
 * 让它把整个插件搞崩不值得；扫描频率错了顶多是不准，不会破坏数据。
 *
 * @param raw - 待规范化的值
 * @returns 合法间隔（毫秒）
 */
export function normalizeInterval(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return SCAN_SETTINGS_DEFAULT.scanIntervalMs
  if (raw < SCAN_INTERVAL_MIN_MS || raw > SCAN_INTERVAL_MAX_MS) return SCAN_SETTINGS_DEFAULT.scanIntervalMs
  return raw
}

/**
 * 规范化一份扫描设置（缺字段各自回落默认值）。
 *
 * @param raw - 任意形状的入参
 * @returns 完整设置
 */
export function normalizeScanSettings(raw: unknown): ScanSettings {
  if (raw === null || typeof raw !== 'object') return SCAN_SETTINGS_DEFAULT
  const record = raw as Record<string, unknown>
  return {
    autoScan: typeof record.autoScan === 'boolean' ? record.autoScan : SCAN_SETTINGS_DEFAULT.autoScan,
    scanIntervalMs: normalizeInterval(record.scanIntervalMs),
  }
}

/**
 * 触发一次自动扫描的调度决策（**纯函数**）。
 *
 * 抽出来是为了可测：真实调度挂在 `TypertRemoteService` 上，构造必须落在真实
 * cordis 上下文里；而「关掉就别扫」「间隔原样用」这两条判据本身与宿主无关。
 *
 * @param settings - 已规范化的扫描设置
 * @returns `intervalMs` 为 `null` 表示不挂定时器
 */
export function resolveScanSchedule(settings: ScanSettings): {
  readonly intervalMs: number | null
  readonly scanImmediately: boolean
} {
  if (!settings.autoScan) return { intervalMs: null, scanImmediately: false }
  // 开着就先扫一次：用户打开应用就想看到现场，不该等第一个间隔到点。
  return { intervalMs: settings.scanIntervalMs, scanImmediately: true }
}
