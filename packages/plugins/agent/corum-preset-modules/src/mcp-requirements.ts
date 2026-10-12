/**
 * MCP **前置依赖探测**（P0 的核心价值所在）。
 *
 * ## 它修的是什么
 *
 * 用户的原话：「**MCP 配置对应的实际运行程序和服务需要进行正确安装才可以使用。**」
 *
 * 现状（`corum-mcp-manager/src/test-connection.ts`）把一切失败收敛成一句 `error` 字符串
 * ——「命令根本不存在」与「命令存在但握手失败」在用户眼里长得一模一样，而两者的处置
 * **完全相反**：前者要去装东西，后者要查配置/看服务日志。
 *
 * 本模块只做**三层探测里的第 ① 层（前置）**：
 *
 * | 层 | 判据 | 失败含义 | 谁做 |
 * |---|---|---|---|
 * | ① 前置 | 路径存在+可执行 / 命令在 `PATH` 可解析 | 程序**没装** | **本模块**（纯 fs，无副作用） |
 * | ② 可达 | 子进程能起来 / HTTP 能连 | 装了但**起不来** | P1/P2 |
 * | ③ 握手 | 现有 `testConnection` | 能连但协议层失败 | 已有 |
 *
 * ## 硬纪律（改之前先读）
 *
 * 1. **绝不 `spawn` 去"试"**：把 `command` 丢给 `spawn` 看报错，会把「没装」与
 *    「装了但起不来」混成一句 `spawn npx ENOENT` —— 那正是本模块要消灭的东西。
 *    判据必须是**纯文件系统 / PATH 查找**。
 * 2. **无副作用、不联网、快**：不写任何文件、不起任何进程、不发任何请求。
 * 3. **`service` 类型 P0 不做网络探测**：返回 `ok:false` + 「需运行期验证」，
 *    但**保留** `hint`/`url`（引导文案仍然有用）。网络探测留给 P2 —— 引它进来
 *    就会带来超时与 flaky 测试，而 P0 的判据必须确定性。
 *
 * @module @corum/corum-preset-modules/mcp-requirements
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { McpRequirement } from './module-format.ts'

/**
 * 一条依赖的探测结果。
 *
 * `kind` 是**判据类型**（不是需求类型）：`app` 需求 → `path-exists`；
 * `command` 需求 → `command-resolvable`；`service` 需求 → `service`；
 * 无 `requires` → `none`（纯内置命令，无外部依赖）。
 */
export interface RequirementStatus {
  /** MCP 服务名（与模块里的条目同名）。 */
  readonly name: string
  /** 前置是否就绪（`none` 恒 true）。 */
  readonly ok: boolean
  /** 本次用的判据。 */
  readonly kind: 'path-exists' | 'command-resolvable' | 'service' | 'none'
  /** 成功/失败的**具体**判据（如「找到 /Applications/Pen.app/...」）。 */
  readonly detail: string
  /** 给人看的安装指引（原样透传自 `requires.hint`）。 */
  readonly hint?: string
  /** 去哪装。 */
  readonly url?: string
}

/** 探测输入：一个 MCP 服务名 + 它的依赖声明（缺省 = 无外部依赖）。 */
export interface RequirementProbeInput {
  readonly name: string
  readonly requires?: McpRequirement
}

/** Windows 上当一个命令没有扩展名时按 `PATHEXT` 逐个试的缺省扩展名。 */
const DEFAULT_WINDOWS_EXTENSIONS = ['.COM', '.EXE', '.BAT', '.CMD']

/** 读一个环境变量，键名大小写不敏感（Windows 上 `Path`/`PATH`/`PATHEXT` 三种拼法都真实存在）。 */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key]
  if (direct !== undefined) return direct
  const lower = key.toLowerCase()
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === lower && v !== undefined) return v
  }
  return undefined
}

/**
 * 展开 Windows 风格的 `%VAR%`（模块清单里真实出现过
 * `%LOCALAPPDATA%\\Pen\\...\\mcp-server-win32-x64.exe` 这种写法）。
 *
 * 只在**环境变量确实存在**时替换：变量缺失就原样留着 ⇒ 探测照样失败并给出原始路径，
 * **不会**制造假阳性。非 Windows 上不做任何替换（`%` 在 POSIX 路径里是合法字符）。
 *
 * @param path - 可能含 `%VAR%` 的路径。
 * @param platform - 目标平台（只有 `win32` 才展开）。
 * @param env - 环境映射（测试可注入）。
 * @returns 展开后的路径（变量缺失时与入参相同）。
 */
export function expandWindowsEnvVars(
  path: string,
  platform: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== 'win32') return path
  return path.replace(/%([^%]+)%/g, (whole, name: string) => envValue(env, name) ?? whole)
}

/** 文件存在且（在 POSIX 上）带可执行位。Windows 上 `X_OK` 等价于 `F_OK`，故同一判据通用。 */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 命令名里出现路径分隔符 / 盘符 ⇒ 它其实是个路径，不是 `PATH` 上待查找的命令名。 */
function looksLikePath(command: string): boolean {
  return command.includes('/') || command.includes('\\') || /^[A-Za-z]:/.test(command)
}

/** 一个候选命令路径是否可用（Windows 上 `accessSync(X_OK)` 退化为存在性检查，故统一用它）。 */
function isUsableCommandFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 在 `PATH` 里解析一个命令名。
 *
 * POSIX：逐目录试**裸名**（`PATH` 上的 `npx` 就是一个无扩展名的可执行文件）。
 * Windows：逐目录先试裸名，再按 `PATHEXT`（缺省 `.COM/.EXE/.BAT/.CMD`）试带扩展名的形态
 * —— 见规范 §16 的平台分叉纪律：「只写 POSIX 形态」在 Windows 上不会报错，只会静默找不到。
 *
 * @param command - 命令名（不含路径分隔符）。
 * @param platform - 目标平台。
 * @param env - 环境映射（测试可注入）。
 * @returns 解析到的绝对路径；找不到时 undefined。
 */
export function resolveCommand(
  command: string,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const rawPath = envValue(env, 'PATH') ?? ''
  const extensions = platform === 'win32'
    ? (envValue(env, 'PATHEXT') ?? DEFAULT_WINDOWS_EXTENSIONS.join(';'))
      .split(';')
      .map(ext => ext.trim())
      .filter(ext => ext !== '')
    : ['']
  for (const dir of rawPath.split(delimiter)) {
    if (dir === '') continue
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`)
      if (isUsableCommandFile(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * 探测**一条** MCP 依赖的前置条件。
 *
 * @param entry - 服务名 + 可选依赖声明。
 * @param platform - 目标平台（缺省 `process.platform`；测试显式传入）。
 * @returns 判据、结论与引导文案（见 {@link RequirementStatus}）。
 */
export function probeRequirement(
  entry: RequirementProbeInput,
  platform: string = process.platform,
): RequirementStatus {
  const requires = entry.requires
  if (requires === undefined) {
    return {
      name: entry.name,
      ok: true,
      kind: 'none',
      detail: '该配置未声明外部依赖（命令由本机 PATH 直接解析或为内置命令）',
    }
  }

  const hintFields = (): { hint?: string; url?: string } => ({
    ...(requires.hint === undefined ? {} : { hint: requires.hint }),
    ...(requires.url === undefined ? {} : { url: requires.url }),
  })

  if (requires.kind === 'app') {
    const declared = requires.platforms?.[platform]
    if (declared === undefined || declared.trim() === '') {
      return {
        name: entry.name,
        ok: false,
        kind: 'path-exists',
        detail: `本平台（${platform}）未声明可执行文件路径`,
        ...hintFields(),
      }
    }
    const resolved = expandWindowsEnvVars(declared, platform)
    if (isExecutableFile(resolved)) {
      return {
        name: entry.name,
        ok: true,
        kind: 'path-exists',
        detail: `找到可执行文件 ${resolved}`,
        ...hintFields(),
      }
    }
    return {
      name: entry.name,
      ok: false,
      kind: 'path-exists',
      detail: existsSync(resolved)
        ? `文件存在但不可执行 ${resolved}`
        : `未找到可执行文件 ${resolved}`,
      ...hintFields(),
    }
  }

  if (requires.kind === 'command') {
    const command = requires.command
    // 声明成 `command` 却写了路径 ⇒ 按路径判据办（不装看不见的失败）。
    if (looksLikePath(command)) {
      const direct = isExecutableFile(command)
        ? command
        : (isAbsolute(command) ? undefined : resolveCommand(command, platform, process.env))
      return {
        name: entry.name,
        ok: direct !== undefined,
        kind: 'command-resolvable',
        detail: direct === undefined
          ? `声明的是路径而非命令名，且该路径不可执行：${command}`
          : `找到可执行文件 ${direct}`,
        ...hintFields(),
      }
    }
    const resolved = resolveCommand(command, platform, process.env)
    return {
      name: entry.name,
      ok: resolved !== undefined,
      kind: 'command-resolvable',
      detail: resolved === undefined
        ? `PATH 中找不到命令 ${command}`
        : `在 PATH 中解析到 ${resolved}`,
      ...hintFields(),
    }
  }

  // kind === 'service'：P0 刻意不做网络探测（无超时/flaky 引入），留给 P2。
  return {
    name: entry.name,
    ok: false,
    kind: 'service',
    detail: `需运行期验证（P0 不做网络探测）：${requires.url}`,
    ...hintFields(),
  }
}

/**
 * 批量探测（计划里的 `requirements` 字段）。
 *
 * @param entries - 待探测的 MCP 条目（按传入顺序返回，便于 UI 一一对应）。
 * @param platform - 目标平台（缺省 `process.platform`）。
 * @returns 每项一条 {@link RequirementStatus}。
 */
export function probeRequirements(
  entries: readonly RequirementProbeInput[],
  platform: string = process.platform,
): RequirementStatus[] {
  return entries.map(entry => probeRequirement(entry, platform))
}
