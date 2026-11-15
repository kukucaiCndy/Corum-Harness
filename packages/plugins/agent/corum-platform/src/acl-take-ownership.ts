/**
 * Windows 沙箱 ACL 属主修复 —— 工作区目录属主不是当前用户时，沙箱
 * `SetNamedSecurityInfoW` 会报 Win32 5（拒绝访问），导致 shell 完全跑不起来。
 *
 * ## 问题（2026-10-13 Windows 真机实测，两处：F:\work\agent + E:\work\project\HollylandInterface）
 *
 * Windows 沙箱初始化时 `AclWriteGrant.add(workspaceRoot)` 调
 * `SetNamedSecurityInfoW` 给工作区目录加 ACE。该 Win32 API 需要对目标目录有
 * `WRITE_DAC` + `WRITE_OWNER` 权限。如果目录属主是别的用户（从别的机器/账户
 * 拷过来的），当前进程（即使 admin 组成员）在非提权进程下也无法修改其 ACL
 * （UAC：admin 组的 WRITE_DAC 在非提权进程里是 disabled 的）⇒ Win32 5。
 *
 * corum 跑在 `remote` 用户（非提权），工作区目录属主可能是 `Administrator`
 * 或其他用户（SID 不一致）⇒ 沙箱初始化失败 ⇒ shell 命令完全跑不起来。
 *
 * ## 修法（分阶段：先非提权修复，失败则信号化需要提权）
 *
 * 非提权进程里 `takeown` / `icacls` 在 admin 组成员进程里**有时**能改属主
 * （icacls 内部用了 `SeTakeOwnershipPrivilege` + `SeRestorePrivilege`，
 * 这些 privilege 在 admin 组进程里可用——但 UAC 过滤 token 下 SeTakeOwnership
 * 是 disabled 的，属主 BUILTIN\Administrators 时必现失败）。
 *
 * 所以分两阶段：
 *   1. **非提权尝试**（本函数）：`takeown` + `icacls /grant`。成功 → `'fixed'`；
 *      失败 → `'needs-elevation'`（不再静默 `false`——让调用方知道「可以提权修复」）。
 *   2. **提权修复**（`fixWorkspaceAclElevated` RPC）：spawn PowerShell
 *      `Start-Process -Verb RunAs` 弹 UAC consent → 提权子进程跑 takeown+icacls。
 *
 * 非 Windows 平台返回 `'unsupported'`。
 *
 * @module corum-platform/acl-take-ownership
 */

import { spawnSync } from 'node:child_process'
import { userInfo } from 'node:os'

/**
 * 非提权 ACL 修复的阶段性结果。
 *
 * - `'fixed'` —— 非提权修复成功，调用方可重试 `grant.add`。
 * - `'needs-elevation'` —— 非提权修复失败（UAC 过滤 token 无 SeTakeOwnership），
 *   调用方应抛 `AclElevationRequiredError` 让 UI 引导用户提权修复。
 * - `'unsupported'` —— 非 Windows 平台（no-op）。
 */
export type AclFixResult = 'fixed' | 'needs-elevation' | 'unsupported'

/**
 * 尝试修复 Windows 工作区目录的 ACL 属主和权限（**非提权**阶段）。
 *
 * 只在 `grant.add` 失败时调用（fail-then-fix），不预先跑（避免每次启动都
 * 改 ACL）。修复后调用方应重试 `grant.add`。
 *
 * @param workspaceRoot - 工作区根目录绝对路径。
 * @returns {@link AclFixResult}。
 */
export function tryFixWorkspaceAcl(workspaceRoot: string): AclFixResult {
  if (process.platform !== 'win32') return 'unsupported'
  const user = userInfo().username
  if (user === undefined || user === '') return 'needs-elevation'
  try {
    // 1. 改属主为当前用户（递归，含子目录）。
    // fork（corum）2026-11-14：先用 `takeown`（而非 `icacls /setowner`）。实测远程
    // Windows 非提权进程里 `icacls /setowner` 会失败（它依赖的 privilege 在该上下文
    // 不可用），而 `takeown` 在 admin 组成员进程里更可靠地取得属主（/d y 自动答 Yes）。
    // takeown 失败再回落 icacls /setowner，两条路都试。
    const take = spawnSync('takeown', ['/f', workspaceRoot, '/r', '/d', 'y'], {
      stdio: 'pipe', windowsHide: true, shell: true,
    })
    if (take.status !== 0) {
      const owner = spawnSync('icacls', [workspaceRoot, '/setowner', user, '/T', '/C', '/Q'], {
        stdio: 'pipe', windowsHide: true, shell: true,
      })
      if (owner.status !== 0) return 'needs-elevation'
    }
    // 2. 给当前用户 FullControl（含 WRITE_DAC/WRITE_OWNER，递归继承）
    const grant = spawnSync('icacls', [workspaceRoot, '/grant', `${user}:(OI)(CI)F`, '/T', '/C', '/Q'], {
      stdio: 'pipe', windowsHide: true, shell: true,
    })
    return grant.status === 0 ? 'fixed' : 'needs-elevation'
  } catch {
    return 'needs-elevation'
  }
}

// ── 提权修复 RPC（host 侧 spawn PowerShell Start-Process -Verb RunAs）──────────

/**
 * 提权修复的结果。
 */
export interface AclElevatedFixResult {
  /** 是否修复成功（退出码 0 且核验通过）。 */
  ok: boolean
  /** 结果分类。 */
  outcome: 'fixed' | 'cancelled' | 'denied' | 'failed' | 'unsupported'
  /** 人话说明（写进日志/通知/诊断包）。 */
  detail: string
}

/** UAC 取消的退出码（Start-Process -Verb RunAs 用户点了「否」）。 */
const UAC_CANCELLED_EXIT = 1602
/** UAC 拒绝的退出码（用户拒绝提权 / 无法提权）。 */
const UAC_DENIED_EXIT = 1223

/**
 * 校验工作区路径是否为安全的绝对路径（防注入）。
 *
 * PowerShell Start-Process 的 ArgumentList 会拼成一条 cmd /c 命令，路径里的
 * 特殊字符（`"`、`&`、`|`、`>`）可能被 cmd 解释器注入。这里只允许绝对路径
 * （盘符开头 `C:\...` 或 UNC `\\...`），且禁止包含引号与命令注入元字符。
 *
 * @param path - 待校验的路径。
 * @returns true = 安全；false = 拒绝（调用方应返回 unsupported/failed）。
 */
function isSafeWindowsPath(path: string): boolean {
  if (path === '') return false
  // 禁止命令注入元字符（引号、管道、重定向、换行等）。
  if (/["&|<>\r\n;`]/u.test(path)) return false
  // 绝对路径：盘符开头（C:\...）或 UNC（\\...）。
  return /^[A-Za-z]:\\/u.test(path) || /^\\\\/u.test(path)
}

/**
 * 取当前 Windows 用户名（`process.env.USERNAME` 优先，回落 `whoami`）。
 *
 * 环境变量 USERNAME 在 Windows 上恒存在；`whoami` 是兜底（USERNAME 被清空时）。
 * @returns 用户名；取不到返回 undefined。
 */
function windowsUsername(): string | undefined {
  const env = process.env.USERNAME
  if (env !== undefined && env !== '') return env
  try {
    const whoami = spawnSync('whoami', [], { stdio: 'pipe', windowsHide: true, shell: true })
    if (whoami.status === 0) {
      const out = whoami.stdout?.toString()?.trim()
      // whoami 返回 `DOMAIN\user` 或 `user`，取反斜杠后的部分。
      if (out !== undefined && out !== '') return out.includes('\\') ? out.split('\\').pop() : out
    }
  } catch { /* best-effort */ }
  return undefined
}

/**
 * 核验修复结果：icacls 读回属主和 ACE，确认当前用户有 FullControl。
 *
 * @param workspaceRoot - 工作区根目录。
 * @param user - 当前用户名。
 * @returns true = 属主和 ACE 都已修复；false = 核验不通过。
 */
function verifyAclFix(workspaceRoot: string, user: string): boolean {
  try {
    const check = spawnSync('icacls', [workspaceRoot], { stdio: 'pipe', windowsHide: true, shell: true })
    if (check.status !== 0) return false
    const out = check.stdout?.toString() ?? ''
    // icacls 输出里找当前用户的 FullControl ACE（`user:(F)` 或 `user:(OI)(CI)(F)`）。
    return out.includes(`${user}:`) && out.includes('(F)')
  } catch {
    return false
  }
}

/**
 * 提权修复 Windows 工作区 ACL（host 侧 RPC）。
 *
 * spawn `powershell -Command "Start-Process cmd -Verb RunAs -ArgumentList '...' -Wait"`
 * 请求 UAC 提权子进程（弹桌面 consent），提权后跑 `takeown /f ... /r /d y && icacls ... /grant ... /T /C /Q`。
 *
 * **安全纪律**：
 *   - app 保持 asInvoker；仅**子进程**提权（Start-Process -Verb RunAs 不改当前进程）；
 *   - 路径注入防护：{@link isSafeWindowsPath} 校验绝对路径 + 禁止命令元字符；
 *   - UAC 拒绝/取消有兜底（返回 cancelled/denied，不静默失败）；
 *   - 修复后核验属主/ACE（icacls 读回）。
 *
 * **幂等**：可重复调用；已修复时 takeown/icacls 是幂等的（属主已是自己则不变）。
 *
 * @param workspaceRoot - 工作区根目录绝对路径（Windows 盘符或 UNC）。
 * @returns {@link AclElevatedFixResult}。
 */
export function fixWorkspaceAclElevated(workspaceRoot: string): AclElevatedFixResult {
  if (process.platform !== 'win32') {
    return { ok: false, outcome: 'unsupported', detail: '非 Windows 平台，无需提权修复 ACL。' }
  }
  if (!isSafeWindowsPath(workspaceRoot)) {
    return { ok: false, outcome: 'failed', detail: `工作区路径不安全（非绝对路径或含注入元字符）：${workspaceRoot}` }
  }
  const user = windowsUsername()
  if (user === undefined) {
    return { ok: false, outcome: 'failed', detail: '无法确定当前 Windows 用户名。' }
  }

  // 组装提权子进程命令：takeown + icacls grant，用 && 连接（takeown 失败也继续 icacls）。
  // 路径用双引号包裹（isSafeWindowsPath 已保证不含引号，故无注入风险）。
  const innerCmd = `takeown /f "${workspaceRoot}" /r /d y && icacls "${workspaceRoot}" /grant "${user}:(OI)(CI)F" /T /C /Q`

  // Start-Process cmd -Verb RunAs：Verb RunAs 请求 UAC 提权；-Wait 等待子进程结束。
  // ArgumentList 里的 /c 命令用引号包裹，内部路径也用引号——cmd 解析时引号层层剥。
  const psCommand = `Start-Process cmd -Verb RunAs -Wait -ArgumentList '/c ${innerCmd.replace(/"/g, '""')}'`

  try {
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
      stdio: 'pipe', windowsHide: true, shell: false,
    })
    const exitCode = result.status ?? -1

    // PowerShell Start-Process -Verb RunAs 的退出码语义：
    //   0    = 提权子进程成功执行（cmd /c 返回 0）；
    //   1602 = 用户取消 UAC consent（点了「否」）；
    //   1223 = 用户拒绝提权 / 无法提权（组策略禁止）。
    // 注意：Start-Process -Wait 返回的是**被启动进程**的退出码（通过 $LASTEXITCODE
    // 或 -PassThru -Wait 的 ExitCode），但 spawnSync 的 status 是 PowerShell 自身的
    // 退出码。UAC 取消/拒绝时 PowerShell 报错退出（非 0），需检查 stderr。
    const stderr = result.stderr?.toString() ?? ''

    if (exitCode === 0) {
      // 核验修复结果（icacls 读回）。
      if (verifyAclFix(workspaceRoot, user)) {
        return { ok: true, outcome: 'fixed', detail: `工作区 ACL 已通过提权修复：${workspaceRoot}` }
      }
      return { ok: false, outcome: 'failed', detail: `提权进程退出 0 但核验未通过（icacls 读回未发现 ${user}:(F)）：${workspaceRoot}` }
    }

    // UAC 取消 / 拒绝：检查 stderr 里 Start-Process 的诊断词。
    if (stderr.includes('1602') || exitCode === UAC_CANCELLED_EXIT) {
      return { ok: false, outcome: 'cancelled', detail: '用户取消了 UAC 提权请求。' }
    }
    if (stderr.includes('1223') || exitCode === UAC_DENIED_EXIT || stderr.includes('requires elevation')) {
      return { ok: false, outcome: 'denied', detail: 'UAC 提权被拒绝（用户选「否」或组策略禁止）。' }
    }

    return { ok: false, outcome: 'failed', detail: `提权修复失败（退出码 ${exitCode}）：${stderr.trim() || workspaceRoot}` }
  } catch (error) {
    return { ok: false, outcome: 'failed', detail: `提权修复异常：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 组装手工修复命令文本（UAC 拒绝/取消时的兜底引导）。
 *
 * 用户可复制到管理员 PowerShell / cmd 里手动执行。
 *
 * @param workspaceRoot - 工作区根目录。
 * @returns 多行命令文本；非 Windows 返回空字符串。
 */
export function manualAclFixCommands(workspaceRoot: string): string {
  if (process.platform !== 'win32') return ''
  const user = windowsUsername() ?? '<你的用户名>'
  return [
    `takeown /f "${workspaceRoot}" /r /d y`,
    `icacls "${workspaceRoot}" /grant "${user}:(OI)(CI)F" /T /C /Q`,
  ].join('\n')
}

// ── 类型化错误（sandbox-local 抛给 agent，fail-closed 不挂起等待）──────────────

/**
 * 工作区 ACL 权限不足，需要管理员权限一键修复。
 *
 * sandbox-local 的 `materializeAclGrant` 在 `tryFixWorkspaceAcl` 返回
 * `'needs-elevation'` 时抛此错误（不再静默 `false`）。
 *
 * **设计纪律**：
 *   - **fail-closed**：抛错后 agent 可重试（不挂起等待 UI 修复——UI 修复是异步的、
 *     且只在用户点击时发生）；
 *   - **类型化**：agent / 日志 / UI 可按 `instanceof` 区分「需要提权」与「其它
 *     沙箱初始化失败」，前者有明确的修复路径（调 `fixWorkspaceAclElevated` RPC）。
 *   - 同步 emit `corum/acl/elevation-required` 事件（由 sandbox-local 发），UI
 *     监听后弹引导卡。
 */
export class AclElevationRequiredError extends Error {
  /** 工作区根目录（传给 RPC `fixWorkspaceAclElevated`）。 */
  readonly workspaceRoot: string
  /** 用户可读文案（展示在引导卡标题/通知栏）。 */
  readonly userMessage: string

  constructor(workspaceRoot: string) {
    super(`工作区目录权限不足，需要管理员权限一键修复：${workspaceRoot}`)
    this.name = 'AclElevationRequiredError'
    this.workspaceRoot = workspaceRoot
    this.userMessage = '工作区目录权限不足，需要管理员权限一键修复'
  }
}
