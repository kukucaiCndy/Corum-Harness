/**
 * targets —— CDP 目标清单的读写与校验（从扩展包 `corum-cdp-targets` 内建而来）。
 *
 * ## 为什么它进本体
 *
 * 「往哪个 CDP 端口连」是所有需要 CDP 的插件共有的领域知识。此前它活在扩展包
 * （`corum-cdp-targets` 插件 + 技能里的 `router/src/config.mjs`），导致：
 *
 *  - 插件只能测自己，测不了别的实例（缺目标概念）；
 *  - 能力随扩展包分发，第三方开发者要用 CDP 就得装扩展包。
 *
 * 现在它是本体标准能力，任何插件/工具都能复用同一份目标清单与校验规则。
 *
 * ## 配置形状（与旧版保持兼容）
 *
 * ```json
 * { "version": 1, "autoDiscover": true, "targets": [{ "id": "rc3", "ip": "127.0.0.1", "port": 9350 }] }
 * ```
 *
 * **校验一律 fail loud**：未知键、类型错、重复 id、重复 endpoint 都抛错。
 * 理由：配置错了却"凑合能用"会让用户在**错误的实例**上做验证，比直接报错危险得多。
 *
 * @module @corum/corum-cdp-router/targets
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** 配置 schema 版本（破坏性变更时递增，旧版配置会被明确拒绝而非静默忽略）。 */
export const CDP_TARGETS_VERSION = 1

/** 配置文件名。 */
export const CDP_TARGETS_FILENAME = 'cdp-targets.json'

/**
 * 主实例端口。任何 IP 上的 9222 都视为主实例，需显式 `allowMain: true`。
 *
 * 这条护栏的由来：用户主实例是他们真实的工作环境，误操作代价高。
 */
export const MAIN_INSTANCE_PORT = 9222

/** target id 合法形态。 */
export const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/** 一个已校验的 target。 */
export interface CdpTarget {
  readonly id: string
  readonly ip: string
  readonly port: number
  readonly allowMain?: boolean
  readonly readOnly?: boolean
  readonly description?: string
  /** 自动发现时写入的观测信息（非用户输入，仅供展示）。 */
  readonly discovered?: {
    readonly role?: string | null
    readonly releaseVersion?: string | null
    readonly releaseCommit?: string | null
    readonly electronVersion?: string | null
    readonly home?: string | null
    readonly source?: string | null
  }
}

/** 一份已校验的配置。 */
export interface CdpTargetsConfig {
  readonly version: number
  readonly autoDiscover: boolean
  readonly targets: readonly CdpTarget[]
}

/** 配置校验失败。 */
export class CdpTargetsConfigError extends Error {
  readonly code = 'cdp-targets/config-invalid'
  readonly source: string

  /**
   * @param message - 原因（含出错的键/值）
   * @param source - 来源标识（文件路径或 `<inline>`）
   */
  constructor(message: string, source = '<config>') {
    super(`${source}: ${message}`)
    this.name = 'CdpTargetsConfigError'
    this.source = source
  }
}

const ALLOWED_TOP_KEYS = new Set(['version', 'autoDiscover', 'targets'])
const ALLOWED_TARGET_KEYS = new Set(['id', 'ip', 'port', 'allowMain', 'readOnly', 'description', 'discovered'])

/**
 * 判断端口是否主实例端口（与 IP 无关）。
 * @param port - 端口
 * @returns 是否主实例
 */
export function isMainInstancePort(port: number): boolean {
  return port === MAIN_INSTANCE_PORT
}

/**
 * 计算 target 被禁用的原因（未禁用返回 `null`）。
 *
 * 只有一条规则：主实例端口但没显式 `allowMain: true`。
 * **刻意不在校验期拒绝** —— 让它出现在列表里并标 disabled，用户能看到
 * 「为什么连不上」，而不是配置里有一条 target 却毫无解释地消失。
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
 * 校验单个 target。
 * @param raw - 原始值
 * @param index - 数组下标（错误信息用）
 * @param source - 来源
 * @returns 规范化 target
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
  const discovered = record.discovered
  const out: CdpTarget = {
    id,
    ip,
    port,
    ...(record.allowMain === undefined ? {} : { allowMain: record.allowMain === true }),
    ...(record.readOnly === undefined ? {} : { readOnly: record.readOnly === true }),
    ...(record.description === undefined ? {} : { description: String(record.description) }),
    ...(discovered === null || discovered === undefined || typeof discovered !== 'object'
      ? {}
      : { discovered: discovered as NonNullable<CdpTarget['discovered']> }),
  }
  return out
}

/**
 * 校验整份配置。
 * @param raw - 已 `JSON.parse` 的配置
 * @param source - 来源标识（通常就是文件路径）
 * @returns 规范化配置
 * @throws {CdpTargetsConfigError}
 */
export function validateConfig(raw: unknown, source = '<config>'): CdpTargetsConfig {
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

  const seenIds = new Set<string>()
  const seenEndpoints = new Map<string, string>()
  for (const target of targets) {
    if (seenIds.has(target.id)) {
      throw new CdpTargetsConfigError(`重复 target id ${target.id}`, source)
    }
    seenIds.add(target.id)
    const endpoint = `${target.ip}:${target.port}`
    const owner = seenEndpoints.get(endpoint)
    if (owner !== undefined) {
      throw new CdpTargetsConfigError(`重复 endpoint ${endpoint}（${owner} 与 ${target.id} 共用同一浏览器）`, source)
    }
    seenEndpoints.set(endpoint, target.id)
  }
  return { version: CDP_TARGETS_VERSION, autoDiscover: record.autoDiscover === true, targets }
}

/**
 * 解析配置文件路径。
 *
 * 优先级：`CORUM_CDP_TARGETS`（必须绝对路径）→ `$CORUM_HOME` → `$DSH_HOME` → `~/.corum`。
 *
 * @param env - 环境变量
 * @param homedir - 用户 home（测试可注入）
 * @returns 绝对路径
 * @throws {CdpTargetsConfigError} 覆盖值不是绝对路径
 */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string {
  const override = env.CORUM_CDP_TARGETS
  if (typeof override === 'string' && override.trim() !== '') {
    if (!path.isAbsolute(override)) {
      throw new CdpTargetsConfigError(`CORUM_CDP_TARGETS 必须是绝对路径：${JSON.stringify(override)}`)
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
 * 首次启动的示例配置：`autoDiscover: true` + **空 targets**。
 *
 * 刻意不写死端口 —— 不同的人、不同的机器 CDP 端口不同，给个「默认 9333」
 * 只会让配置指向空气。
 * @returns 示例配置
 */
export function sampleConfig(): CdpTargetsConfig {
  return { version: CDP_TARGETS_VERSION, autoDiscover: true, targets: [] }
}

/**
 * 读配置；文件不存在时返回示例（**不写盘**——写盘由服务侧显式决定）。
 *
 * @param configPath - 绝对路径
 * @returns 配置 + 是否存在
 * @throws {CdpTargetsConfigError} 文件存在但内容非法
 */
export function readConfig(configPath: string): { config: CdpTargetsConfig; exists: boolean } {
  if (!existsSync(configPath)) {
    return { config: sampleConfig(), exists: false }
  }
  const text = readFileSync(configPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new CdpTargetsConfigError(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`, configPath)
  }
  return { config: validateConfig(parsed, configPath), exists: true }
}

/**
 * 写配置（先校验、原子写：tmp + rename）。
 *
 * 为什么必须原子：`cdpTargets` 的热更新靠 mtime 检测，半个文件会让读到它的插件
 * 抛解析错；rename 在同一文件系统内是原子的。
 *
 * @param configPath - 绝对路径
 * @param config - 待写配置（会先校验）
 * @returns 实际写入的配置
 * @throws {CdpTargetsConfigError} 配置非法
 */
export function writeConfig(configPath: string, config: CdpTargetsConfig): CdpTargetsConfig {
  const validated = validateConfig(config, configPath)
  mkdirSync(path.dirname(configPath), { recursive: true })
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
  // rename 覆盖目标（POSIX 原子；Windows 上同样覆盖语义）
  renameSync(tmp, configPath)
  return validated
}
