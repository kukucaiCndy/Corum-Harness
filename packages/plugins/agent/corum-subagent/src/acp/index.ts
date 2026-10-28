/**
 * corum ACP provider wrapper（阶段 5）：在 apply 时从固定环境变量解析
 * `command`/`args`，调用官方 `@deepseek-ai/dsh-subagent-acp` 的 `apply()` 注册
 * out-of-process ACP provider。
 *
 * **为什么需要 wrapper**：官方 `Config.command` 是 `z.string().required()`——
 * cordis patch 行不写 `command` 会导致 zod 校验失败、boot 死。但 `command` 是
 * 绝对路径（dev/packaged 三平台不同），不能硬编码进 patch 行。本 wrapper 在
 * apply 时从 `CORUM_HOST_NODE`（Node executable）+ `CORUM_ACP_CLI_PATH`（dsh CLI
 * bin.js 绝对路径）解析出 command+args，再调官方 apply。
 *
 * **设计裁决**（用户 2026-10-29 拍板）：
 *   D1: 官方 `dsh` CLI + `--profile acp` 作为子进程（不写第二协议栈）
 *   D2: 子进程读同一 `CORUM_HOME`/`DSH_HOME` 的官方 profile/settings/credentials
 *   D3: `permission: reject`（负例验证基线；allow 后续独立评审）
 *
 * **能力面**（rc3 官方 `subagent-acp/src/index.ts:81-86`）：
 *   - `agentOptions`/`agentPreset`/`outputSchema`/`depthLimit` 全 `false`
 *   - `inheritsParentContext = false`（进程边界）
 *   - `prepareContinuable` 不存在 → 只有 one-shot external activation
 *   - `sendMessage`/`resume` → `NOT_CONTINUABLE`
 *   - `permission: reject` → 所有 permission request → `cancelled` → child `aborted`
 *
 * **后续必做项**（不在本阶段）：corum confined/worktree 核心功能适配。
 * @module @corum/corum-subagent/acp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  apply as applyOfficialAcp,
  type Config as OfficialAcpConfig,
} from '@deepseek-ai/dsh-subagent-acp'

export const name = 'corum-subagent-acp'
export const inject = ['subagents', 'subprocess']

/**
 * corum wrapper config: only `providerName`（用户面），其余由 wrapper 从环境变量
 * 解析。官方 Config 的 required `command` 不暴露给 patch 行——它在 apply 时计算。
 */
export interface Config {
  /** Provider name on `ctx.subagents` (default `acp`). */
  providerName: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('acp'),
})

/**
 * 从环境变量解析 ACP 子进程的 command+args。
 *
 * `CORUM_HOST_NODE`：Node executable 绝对路径（Electron main `hostNode()` 注入；
 * dev=`process.execPath`，packaged darwin/linux=`Resources/node/bin/node`，
 * win32=`Resources/node/node.exe`）。
 * `CORUM_ACP_CLI_PATH`：dsh CLI `lib/bin.js` 绝对路径（Electron main `acpCliPath()`
 * 注入；dev=`packages/desktop/node_modules/@deepseek-ai/dsh/lib/bin.js`，
 * packaged=`Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js`）。
 *
 * 缺少任一环境变量 → throw（fail-loud，不静默降级）。
 */
function resolveAcpCommand(): { command: string; args: string[] } {
  const nodeExe = process.env.CORUM_HOST_NODE
  const cliPath = process.env.CORUM_ACP_CLI_PATH
  if (nodeExe === undefined || nodeExe.trim() === '') {
    throw new Error(
      'corum-subagent-acp: CORUM_HOST_NODE is not set — the Electron main must inject '
      + 'the Node executable path (hostNode()) before the host child boots.',
    )
  }
  if (cliPath === undefined || cliPath.trim() === '') {
    throw new Error(
      'corum-subagent-acp: CORUM_ACP_CLI_PATH is not set — the Electron main must inject '
      + 'the dsh CLI bin.js path (acpCliPath()) before the host child boots.',
    )
  }
  return {
    command: nodeExe,
    args: [cliPath, '--profile', 'acp'],
  }
}

/**
 * 注册 ACP provider：解析 command+args → 构建官方 Config → 调官方 apply。
 *
 * `permission` 固定 `reject`（用户 D3 裁决：负例验证基线）。
 *
 * `env`：官方 `scrubbedParentEnv()` 会从父 env 中删掉所有 `DSH_*` 和
 * credential-shaped（`KEY/PASSWORD/SECRET/TOKEN`）名称，然后 `spec.env` merge
 * 上去。如果不显式传 `DSH_HOME`/`CORUM_HOME`，子进程拿不到 home 路径——
 * 无法读 profile/settings/credentials（与 D2「子进程读同一 DSH_HOME」矛盾）。
 * 所以这里显式传 deployment-owned 的 `DSH_HOME` + `CORUM_HOME`（父进程的真实
 * 绝对路径值，非空校验），**不**传 KEY/TOKEN/SECRET 等敏感值。
 */
function resolveAcpEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const dshHome = process.env.DSH_HOME
  const corumHome = process.env.CORUM_HOME
  if (dshHome !== undefined && dshHome.trim() !== '') env.DSH_HOME = dshHome
  if (corumHome !== undefined && corumHome.trim() !== '') env.CORUM_HOME = corumHome
  return env
}

export function apply(ctx: Context, config: Config): void {
  const { command, args } = resolveAcpCommand()
  const resolvedConfig: OfficialAcpConfig = {
    providerName: config.providerName,
    command,
    args,
    permission: 'reject',
    env: resolveAcpEnv(),
    disposeEofGraceMs: 6_000,
    disposeGraceMs: 3_000,
  }
  // 官方 apply **不**内部跑 Config schema（schemastery 已在 loader 层解析），
  // 它直接用 config as ResolvedConfig，再 registerProvider。因此这里必须传完整
  // 填好的 config（disposeEofGraceMs/disposeGraceMs 用默认值，否则
  // assertPositiveFinite 会因 undefined 报错）。
  applyOfficialAcp(ctx, resolvedConfig)
}
