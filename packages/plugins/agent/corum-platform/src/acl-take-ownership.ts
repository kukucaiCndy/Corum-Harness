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
 * ## 修法（不改用户全局配置，不弹窗）
 *
 * `icacls` 在 admin 组成员的进程里**可以**改属主（icacls 内部用了
 * `SeTakeOwnershipPrivilege` + `SeRestorePrivilege`，这些 privilege 在 admin
 * 组进程里可用）。所以：沙箱 `grant.add` 失败时，先跑 `icacls /setowner` +
 * `icacls /grant` 修复属主和权限，然后重试 `grant.add`。
 *
 * 非 Windows 平台直接返回 false（no-op）。
 *
 * @module corum-platform/acl-take-ownership
 */

import { spawnSync } from 'node:child_process'
import { hostname, userInfo } from 'node:os'

/**
 * 尝试修复 Windows 工作区目录的 ACL 属主和权限。
 *
 * 只在 `grant.add` 失败时调用（fail-then-fix），不预先跑（避免每次启动都
 * 改 ACL）。修复后调用方应重试 `grant.add`。
 *
 * @param workspaceRoot - 工作区根目录绝对路径。
 * @returns true = 修复成功（可重试 grant.add）；false = 非 Windows 或修复失败。
 */
export function tryFixWorkspaceAcl(workspaceRoot: string): boolean {
  if (process.platform !== 'win32') return false
  const user = userInfo().username
  if (user === undefined || user === '') return false
  try {
    // 1. 改属主为当前用户（递归，含子目录）
    const owner = spawnSync('icacls', [workspaceRoot, '/setowner', user, '/T', '/C', '/Q'], {
      stdio: 'pipe', windowsHide: true, shell: true,
    })
    if (owner.status !== 0) return false
    // 2. 给当前用户 FullControl（含 WRITE_DAC/WRITE_OWNER，递归继承）
    const grant = spawnSync('icacls', [workspaceRoot, '/grant', `${user}:(OI)(CI)F`, '/T', '/C', '/Q'], {
      stdio: 'pipe', windowsHide: true, shell: true,
    })
    return grant.status === 0
  } catch {
    return false
  }
}
