/**
 * cdp-targets —— CDP 目标配置的**单一家**（校验 / 路径解析 / 主实例护栏）。
 *
 * ## 为什么它属于 SDK
 *
 * 「往哪个 CDP 端口连」是**所有 CDP 类插件共有的领域知识**，不是某一个插件的私有逻辑。
 * 在它被收进 SDK 之前，同一套 `validateConfig` / `resolveConfigPath` / `disabledReason`
 * 活在两个地方：
 *   · 技能包 `corum-cdp-verify/router/src/config.mjs`（router 运行时用）
 *   · 插件 `corum-cdp-targets` 反过来按相对路径去 import 上面那个 src 文件
 *
 * 后者是**必然失败**的依赖：扩展包只分发 `router/dist/`（已 bundle），不分发 `router/src/`。
 * 实测（2026-10-30）插件在装好的宿主里报：
 *
 *   cdpTargets: 无法加载 config.mjs（已尝试 3 个候选路径）: Cannot find module ...
 *
 * 把领域逻辑收进 SDK ⇒ 插件依赖 `@corum/plugin-sdk`（官方发布物）而不是别人的源码目录。
 *
 * ## 契约（与 router 运行时同一份语义，不许漂移）
 *
 * 配置文件是 JSON，形如：
 *
 * ```json
 * { "version": 1, "autoDiscover": true, "targets": [{ "id": "rc3", "ip": "127.0.0.1", "port": 9333 }] }
 * ```
 *
 * 校验一律 **fail loud**：未知键、错误类型、重复 id、重复 endpoint 都抛错，不做宽松回退。
 * 理由：配置错了却「凑合能用」会让用户在错误的实例上做验证，比直接报错危险得多。
 *
 * @module @corum/plugin-sdk/cdp-targets
 */

import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** 配置 schema 版本（破坏性变更时递增，旧版本配置会被明确拒绝而不是静默忽略）。 */
export const CDP_TARGETS_VERSION = 1

/** 配置文件默认文件名。 */
export const CDP_TARGETS_FILENAME = 'cdp-targets.json'

/**
 * 主实例的 CDP 端口。
 *
 * 桌面壳把用户的主实例固定在这个端口上。**任何 IP 上的 9222 都视为主实例**，
 * 必须显式 `allowMain: true` 才允许连接 —— 这是防「误操作把用户的真实工作环境改坏」的护栏。
 */
export const MAIN_INSTANCE_PORT = 9222

/** target id 的合法形态（小写字母数字与 `-`/`_`，首字符不能是分隔符）。 */
export const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/** 校验失败时抛出的错误（带 `code`，便于调用方分类处理）。 */
export class CdpTargetsConfigError extends Error {
  /** 稳定的错误码，供调用方分类（不靠 instanceof，跨 bundle 也成立）。 */
  readonly code = 'cdp-targets/config-invalid'
  /** 配置来源标识（文件路径或 `<inline>`）。 */
  readonly source: string

  /**
   * @param message - 人可读的完整原因（含出错的键/值）
   * @param source - 配置来源标识（文件路径或 `<inline>`）
   */
  constructor(message: string, source: string = '<config>') {
    super(`${source}: ${message}`)
    this.name = 'CdpTargetsConfigError'
    this.source = source
  }
}

/** 一个已校验的 target。 */
export interface CdpTarget {
  readonly id: string
  readonly ip: string
  readonly port: number
  readonly allowMain?: boolean
  readonly readOnly?: boolean
  readonly description?: string
}

/** 校验后的配置。 */
export interface CdpTargetsConfig {
  readonly version: number
  /** 是否自动发现本机在跑的 Corum 实例（不写死端口的实现方式）。 */
  readonly autoDiscover: boolean
  readonly targets: readonly CdpTarget[]
}

/** 顶层允许的键（多余键一律拒绝，防拼写错误被静默忽略）。 */
const ALLOWED_TOP_KEYS = new Set(['version', 'autoDiscover', 'targets'])

/** 单个 target 允许的键。 */
const ALLOWED_TARGET_KEYS = new Set(['id', 'ip', 'port', 'allowMain', 'readOnly', 'description'])

/**
 * 判断端口是否为主实例端口（与 IP 无关）。
 * @param port - 端口
 * @returns 是否主实例端口
 */
export function isMainInstancePort(port: number): boolean {
  return port === MAIN_INSTANCE_PORT
}

/**
 * 计算某个 target 被禁用的原因（未禁用返回 `null`）。
 *
 * 规则只有一条：**主实例端口但没有 `allowMain: true`** ⇒ 禁用。
 * 它不在校验期拒绝（让 target 出现在列表里但标 disabled，用户能看到「为什么连不上」）。
 *
 * @param target - 已校验的 target
 * @returns 禁用原因或 `null`
 */
export function disabledReason(target: CdpTarget): string | null {
  if (isMainInstancePort(target.port) && target.allowMain !== true) {
    return `端口 ${MAIN_INSTANCE_PORT} 是用户主实例，需显式 allowMain: true 才允许连接`
  }
  return null
}

/**
 * 校验一个 target 对象。
 * @param raw - 原始对象
 * @param index - 在数组里的下标（错误信息用）
 * @param source - 配置来源（错误信息用）
 * @returns 规范化后的 target
 */
function validateTarget(raw: unknown, index: number, source: string): CdpTarget {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CdpTargetsConfigError(`targets[${index}] 必须是对象`, source)
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!ALLOWED_TARGET_KEYS.has(key)) {
      throw new CdpTargetsConfigError(
        `targets[${index}] 含未知键 ${JSON.stringify(key)}（只允许 ${[...ALLOWED_TARGET_KEYS].join('/')}）`,
        source,
      )
    }
  }
  const id = record.id
  if (typeof id !== 'string' || !TARGET_ID_PATTERN.test(id)) {
    throw new CdpTargetsConfigError(`targets[${index}].id 非法：${JSON.stringify(id)}`, source)
  }
  const ip = record.ip
  if (typeof ip !== 'string' || net.isIP(ip) === 0) {
    throw new CdpTargetsConfigError(
      `targets[${index}].ip 必须是 IP 字面量（不接受 URL/路径/DNS 名）：${JSON.stringify(ip)}`,
      source,
    )
  }
  const port = record.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CdpTargetsConfigError(`targets[${index}].port 必须是 1-65535 的整数：${JSON.stringify(port)}`, source)
  }
  const out: CdpTarget = {
    id,
    ip,
    port,
    ...(record.allowMain === undefined ? {} : { allowMain: record.allowMain === true }),
    ...(record.readOnly === undefined ? {} : { readOnly: record.readOnly === true }),
    ...(record.description === undefined ? {} : { description: String(record.description) }),
  }
  return out
}

/**
 * 校验整份配置。
 *
 * @param raw - 配置原文（已 JSON.parse）
 * @param source - 来源标识（通常就是文件路径）
 * @returns 规范化后的配置（targets 已去重校验）
 * @throws {CdpTargetsConfigError} 任何不合规
 */
export function validateCdpTargetsConfig(raw: unknown, source = '<config>'): CdpTargetsConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CdpTargetsConfigError('配置必须是 JSON 对象', source)
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new CdpTargetsConfigError(
        `顶层含未知键 ${JSON.stringify(key)}（只允许 ${[...ALLOWED_TOP_KEYS].join('/')}）`,
        source,
      )
    }
  }
  if (record.version !== CDP_TARGETS_VERSION) {
    throw new CdpTargetsConfigError(
      `version 必须为 ${CDP_TARGETS_VERSION}，实得 ${JSON.stringify(record.version)}`,
      source,
    )
  }
  if (!Array.isArray(record.targets)) {
    throw new CdpTargetsConfigError('targets 必须是数组', source)
  }
  const targets = record.targets.map((entry, index) => validateTarget(entry, index, source))

  // 重复检测：同 id 或同 endpoint 都会让「到底连了谁」变得不可判定
  const seenIds = new Map<string, number>()
  const seenEndpoints = new Map<string, string>()
  for (const target of targets) {
    if (seenIds.has(target.id)) {
      throw new CdpTargetsConfigError(`重复 target id ${target.id}`, source)
    }
    seenIds.set(target.id, target.port)
    const endpoint = `${target.ip}:${target.port}`
    const owner = seenEndpoints.get(endpoint)
    if (owner !== undefined) {
      throw new CdpTargetsConfigError(`重复 endpoint ${endpoint}（${owner} 与 ${target.id} 共用同一浏览器）`, source)
    }
    seenEndpoints.set(endpoint, target.id)
  }
  return {
    version: CDP_TARGETS_VERSION,
    autoDiscover: record.autoDiscover === true,
    targets,
  }
}

/**
 * 解析配置文件路径。
 *
 * 优先级（与 router 运行时一致）：
 *  1. `CORUM_CDP_TARGETS`（必须绝对路径）
 *  2. `$CORUM_HOME/cdp-targets.json`
 *  3. `$DSH_HOME/cdp-targets.json`
 *  4. `~/.corum/cdp-targets.json`
 *
 * @param env - 环境变量（默认 `process.env`）
 * @param homedir - 用户 home（测试可注入）
 * @returns 绝对路径
 * @throws {CdpTargetsConfigError} `CORUM_CDP_TARGETS` 不是绝对路径时
 */
export function resolveCdpTargetsPath(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string {
  const override = env.CORUM_CDP_TARGETS
  if (typeof override === 'string' && override.trim() !== '') {
    if (!path.isAbsolute(override)) {
      throw new CdpTargetsConfigError(
        `CORUM_CDP_TARGETS 必须是绝对路径：${JSON.stringify(override)}`,
      )
    }
    return override
  }
  for (const key of ['CORUM_HOME', 'DSH_HOME'] as const) {
    const home = env[key]
    if (typeof home === 'string' && home.trim() !== '') {
      return path.join(home, CDP_TARGETS_FILENAME)
    }
  }
  return path.join(homedir, '.corum', CDP_TARGETS_FILENAME)
}

/**
 * 首次启动时写入的示例配置。
 *
 * **刻意不含任何写死的端口**：默认开自动发现，`targets` 为空。
 * 不同的人、不同的机器 CDP 端口不同，写死一个「默认 9333」只会让配置指向空气。
 * 用户需要固定某个实例时再往 `targets` 里加一条。
 */
export function sampleCdpTargetsConfig(): CdpTargetsConfig {
  return { version: CDP_TARGETS_VERSION, autoDiscover: true, targets: [] }
}
