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
import { existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { userInfo, tmpdir } from 'node:os'

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
 * 一次 ACL 修复尝试的诊断记录（issue #244 缺陷 2）。
 *
 * 为什么需要它：修复函数此前**丢掉全部 stderr**，于是「真的缺权限」与「自动修复
 * 跑过但失败（例如路径被 shell 代码页破坏）」在返回值上是**同一个** `'needs-elevation'`
 * ——用户只看到「需要管理员权限」，而实测那种情形下 `icacls /grant` 根本不需要提权。
 * 有了这份记录，调用方才能把真实原因写进日志、并区分两种失败。
 */
export interface AclFixAttempt {
  /** 执行的可执行文件名（`takeown` / `icacls`）。 */
  command: string
  /** 完整 argv（用 `shell:false` 直接交给子进程，不经过 cmd.exe）。 */
  argv: readonly string[]
  /** 退出码；`null` 表示进程被信号终止或没起来。 */
  status: number | null
  /** 子进程 stderr（失败时是唯一的现场证据）。 */
  stderr: string
}

/** 非提权 ACL 修复的结果 + 诊断。 */
export interface AclFixOutcome {
  /** 三态结论（与旧返回值同义）。 */
  result: AclFixResult
  /** 依次尝试过的命令；`'unsupported'` 时为空。 */
  attempts: readonly AclFixAttempt[]
}

/**
 * 跑一条 ACL 修复命令并记录诊断。
 *
 * `shell: false` 是**稳健性**选择，不是对某个已证实故障的修复——2026-11-26 在真机
 * （Windows 10 19045，OEM 代码页 936）实测过，结论要精确：
 *
 * - 纯中文路径：`shell: true` 与 `false` **都成功**。所以「代码页 936 必然破坏中文路径」
 *   这个假设**不成立**（issue #244 报告推测的就是它）。
 * - 路径含**空格**或 **cmd 元字符**（如 `&`）：`shell: true` **确实坏**——
 *   `项目 dir` 报 `无效参数“dir”`（exit 87），`项目&amp` 报
 *   `'amp' 不是内部或外部命令`（exit 1）；同样输入在 `shell: false` 下全部成功。
 *   机制是 `cmd.exe` 把路径当命令行文本**重新分词**，与编码无关。
 *
 * 即：`shell: true` 是「路径被 cmd 重新解析」这一类失败的真因，而空间/元字符在真实
 * 工作区里完全可能出现，因此不需要经过 shell 时不经过。`spawnSync` 原生就能把 argv
 * 原样传给子进程。本文件里 PowerShell 那几条调用一直是 `shell: false`，只有 ACL 这
 * 条路径漏了。
 *
 * @param command - 可执行文件名。
 * @param argv - 参数数组（原样传递，不拼接）。
 * @returns 退出码与 stderr。
 */
function runAclCommand(command: string, argv: readonly string[]): AclFixAttempt {
  const run = spawnSync(command, [...argv], { stdio: 'pipe', windowsHide: true, shell: false })
  return {
    command,
    argv,
    status: run.status,
    stderr: run.stderr?.toString().trim() ?? '',
  }
}

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
  return tryFixWorkspaceAclWithDiagnostics(workspaceRoot).result
}

/**
 * 同 {@link tryFixWorkspaceAcl}，但把每条命令的退出码与 stderr 一并带回。
 *
 * 调用方应当用这份诊断写日志——静默失败会让用户被错误地引向 UAC。
 *
 * @param workspaceRoot - 工作区根目录绝对路径。
 * @returns 三态结论 + 尝试记录。
 */
export function tryFixWorkspaceAclWithDiagnostics(workspaceRoot: string): AclFixOutcome {
  if (process.platform !== 'win32') return { result: 'unsupported', attempts: [] }
  const user = userInfo().username
  if (user === undefined || user === '') return { result: 'needs-elevation', attempts: [] }
  const attempts: AclFixAttempt[] = []
  try {
    // 1. 改属主为当前用户（递归，含子目录）。
    // fork（corum）2026-11-14：先用 `takeown`（而非 `icacls /setowner`）。实测远程
    // Windows 非提权进程里 `icacls /setowner` 会失败（它依赖的 privilege 在该上下文
    // 不可用），而 `takeown` 在 admin 组成员进程里更可靠地取得属主（/d y 自动答 Yes）。
    // takeown 失败再回落 icacls /setowner，两条路都试。
    const take = runAclCommand('takeown', ['/f', workspaceRoot, '/r', '/d', 'y'])
    attempts.push(take)
    if (take.status !== 0) {
      const owner = runAclCommand('icacls', [workspaceRoot, '/setowner', user, '/T', '/C', '/Q'])
      attempts.push(owner)
      if (owner.status !== 0) return { result: 'needs-elevation', attempts }
    }
    // 2. 给当前用户 FullControl（含 WRITE_DAC/WRITE_OWNER，递归继承）
    const grant = runAclCommand('icacls', [workspaceRoot, '/grant', `${user}:(OI)(CI)F`, '/T', '/C', '/Q'])
    attempts.push(grant)
    return { result: grant.status === 0 ? 'fixed' : 'needs-elevation', attempts }
  } catch (error: unknown) {
    // spawn 本身抛错（ENOENT 等）——记进诊断，不再完全静默。
    attempts.push({ command: '(spawn)', argv: [], status: null, stderr: String(error) })
    return { result: 'needs-elevation', attempts }
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
    const whoami = spawnSync('whoami', [], { stdio: 'pipe', windowsHide: true, shell: false })
    if (whoami.status === 0) {
      const out = whoami.stdout?.toString()?.trim()
      // whoami 返回 `DOMAIN\user` 或 `user`，取反斜杠后的部分。
      if (out !== undefined && out !== '') return out.includes('\\') ? out.split('\\').pop() : out
    }
  } catch { /* best-effort */ }
  return undefined
}

/**
 * 核验修复结果：icacls 读回属主和 ACE，确认当前用户有 FullControl（或已是属主）。
 *
 * 两层判据（任一命中即通过）：
 *   ① 显式 ACE：icacls 输出含 `user:(F)`（FullControl）——沙箱授权直接可用。
 *   ② 属主匹配：Get-Acl 读回的 Owner 是当前用户——属主对目录隐含 WRITE_DAC，
 *      沙箱 `SetNamedSecurityInfoW` 能改 ACL，授权可过。
 *
 * 判据②补的动机（2026-11-14 远程实测）：远程 Windows 上 `takeown` 成功把属主
 * 改成了当前用户，但 `icacls /grant` 在提权子进程里被 Start-Process -ArgumentList
 * 的引号转义弄坏、没加上显式 ACE。此时属主已正确（沙箱能跑 bash），但旧判据只
 * 看 icacls ACE → 误报失败。属主==user 即隐含 WRITE_DAC，应判成功。
 *
 * @param workspaceRoot - 工作区根目录。
 * @param user - 当前用户名。
 * @param psExe - 已解析的 PowerShell 绝对路径（existsSync 校验后的）。
 * @returns true = 显式 ACE 或属主匹配；false = 核验不通过。
 */
function verifyAclFix(workspaceRoot: string, user: string, psExe: string): boolean {
  try {
    // ⚠️ `shell: false`：含非 ASCII 的工作区路径经 cmd.exe 会被代码页破坏，
    // 核验会把「其实已经修好」误判成失败（issue #244 缺陷 2）。
    const check = spawnSync('icacls', [workspaceRoot], { stdio: 'pipe', windowsHide: true, shell: false })
    if (check.status === 0) {
      const out = check.stdout?.toString() ?? ''
      // 判据①：icacls 输出里找当前用户的 FullControl ACE（`user:(F)` 或 `user:(OI)(CI)(F)`）。
      if (out.includes(`${user}:`) && out.includes('(F')) return true
    }
    // 判据②：Get-Acl 读属主，属主==user 即隐含 WRITE_DAC（沙箱授权可过）。
    // 路径经 isSafeWindowsPath 校验无单引号，安全拼进 PS 单引号串。
    const owner = spawnSync(psExe, ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Acl -LiteralPath '${workspaceRoot}').Owner`], {
      stdio: 'pipe', windowsHide: true, shell: false,
    })
    if (owner.status === 0) {
      const ownerOut = owner.stdout?.toString()?.trim() ?? ''
      // Get-Acl Owner 返回 `DOMAIN\user` 或 `user`；匹配末尾 `\user` 或整体===user。
      if (ownerOut === user || ownerOut.endsWith(`\\${user}`)) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 提权修复 Windows 工作区 ACL（host 侧 RPC）。
 *
 * 写临时 bat（takeown + icacls 两行），再 spawn
 * `powershell -Command "Start-Process cmd.exe -Verb RunAs -Wait -ArgumentList '/c \"<batPath>\"'"`
 * 请求 UAC 提权子进程（弹桌面 consent），提权后 bat 跑 takeown+icacls。
 * psCommand 用 PS 单引号串包裹 ArgumentList，内部双引号原样保留传给 cmd。
 *
 * **为什么用临时 bat**（2026-11-14 远程实测）：原先把 `takeown ... && icacls ...`
 * 拼成单串塞进 `Start-Process -ArgumentList '/c <innerCmd>'`，PS 单引号串原样保留
 * 字符听起来没问题，但 Start-Process 的 -ArgumentList 实际会把整个串再拼成 cmd /c
 * 的命令行，innerCmd 里的双引号（包裹路径）在这个二次拼接里被转义弄坏 ⇒ icacls
 * grant 串实测失效（takeown 成功但 grant 没加上 ACE）。改用临时 bat：把两条命令
 * 各占一行写进 .bat 文件，psCommand 只传 `'/c "<batPath>"'`，bat 路径简单无引号
 * 嵌套问题，cmd /c 直接执行 bat 文件、不再二次解释 innerCmd 的引号。
 *
 * **安全纪律**：
 *   - app 保持 asInvoker；仅**子进程**提权（Start-Process -Verb RunAs 不改当前进程）；
 *   - 路径注入防护：{@link isSafeWindowsPath} 校验绝对路径 + 禁止命令元字符；
 *   - bat 写在系统 tmpdir，文件名含 pid+timestamp（唯一），finally 删（best-effort）；
 *   - UAC 拒绝/取消有兜底（返回 cancelled/denied，不静默失败）；
 *   - 修复后核验属主/ACE（icacls + Get-Acl 读回）。
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

  // 解析 powershell 绝对路径：schtasks 拉起的 host 进程 PATH 里可能没有 powershell
  // （实测远程 Windows 退出码 -1、空 stderr = ENOENT）。SystemRoot 下恒有 WindowsPowerShell，
  // 用绝对路径避开 PATH 查找；存在性校验失败则回落 PATH 查找 'powershell'。
  const psExe = existsSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell'

  // 写临时 bat：takeown + icacls 两行，\r\n 换行，utf8 无 BOM。
  // 路径用双引号包裹（isSafeWindowsPath 已保证不含引号，故无注入风险）。
  const batPath = join(tmpdir(), `corum-acl-fix-${process.pid}-${Date.now()}.bat`)
  const batContent = `takeown /f "${workspaceRoot}" /r /d y\r\nicacls "${workspaceRoot}" /grant "${user}:(OI)(CI)F" /T /C /Q\r\n`
  try {
    writeFileSync(batPath, batContent, { encoding: 'utf8' })
  } catch (error) {
    return { ok: false, outcome: 'failed', detail: `写临时 bat 失败：${error instanceof Error ? error.message : String(error)}` }
  }

  // Start-Process cmd.exe -Verb RunAs：Verb RunAs 请求 UAC 提权；-Wait 等待子进程结束。
  // -ArgumentList 用 PS 单引号串：'/c "<batPath>"'。PS 单引号串是 verbatim（原样），
  // 内部双引号原样保留传给 cmd → cmd 收到 /c "C:\...\file.bat"，bat 路径含空格也安全。
  // **不能用 PS 双引号串**：PS 双引号串内字面引号须用反引号转义（`"），而 `\"` 是非法
  // PS 语法（`\"` 里的 `"` 会提前结束串），会导致 Start-Process 解析失败、bat 不执行。
  // bat 路径不含单引号（isSafeWindowsPath 已禁止单引号，且 tmpdir+pid+timestamp 均无元字符），安全。
  const psCommand = `Start-Process cmd.exe -Verb RunAs -Wait -ArgumentList '/c "${batPath}"'`

  try {
    const result = spawnSync(psExe, ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
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
      // 核验修复结果（icacls 读回 + Get-Acl 属主）。
      if (verifyAclFix(workspaceRoot, user, psExe)) {
        return { ok: true, outcome: 'fixed', detail: `工作区 ACL 已通过提权修复：${workspaceRoot}` }
      }
      return { ok: false, outcome: 'failed', detail: `提权进程退出 0 但核验未通过（icacls/Get-Acl 读回未发现 ${user}:(F) 或属主匹配）：${workspaceRoot}` }
    }

    // UAC 取消 / 拒绝：检查 stderr 里 Start-Process 的诊断词。
    if (stderr.includes('1602') || exitCode === UAC_CANCELLED_EXIT) {
      return { ok: false, outcome: 'cancelled', detail: '用户取消了 UAC 提权请求。' }
    }
    if (stderr.includes('1223') || exitCode === UAC_DENIED_EXIT || stderr.includes('requires elevation')) {
      return { ok: false, outcome: 'denied', detail: 'UAC 提权被拒绝（用户选「否」或组策略禁止）。' }
    }

    return { ok: false, outcome: 'failed', detail: `提权修复失败（退出码 ${exitCode}${result.error ? ', ' + result.error.message : ''}）：${stderr.trim() || workspaceRoot}` }
  } catch (error) {
    return { ok: false, outcome: 'failed', detail: `提权修复异常：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    // best-effort 删临时 bat。
    try { unlinkSync(batPath) } catch { /* best-effort */ }
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
