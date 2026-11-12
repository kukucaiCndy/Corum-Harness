/**
 * @corum-desktop — the desktop-surface bundle's runtime glue plugin plus the
 * bundle patch (`cordis.patch.yml`, declared by `dsh.bundle.patch`). The
 * plugin registers the desktop surface prompt sections and the shell-visible
 * `DSH_CORUM_DESKTOP` runtime variable. The transport rows (corum-desktop-modules,
 * corum-desktop-connection) and the Electron main process live in sibling subpath
 * entries of this package.
 * @module corum-desktop
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'corum-desktop-app'

/** This dsh installation's root, from either this package's source or built entry. */
const SOURCE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** Environment variable naming this desktop surface to the model's shell. */
const DSH_CORUM_DESKTOP = 'DSH_CORUM_DESKTOP' as const

/**
 * Development-class Agent presets — sessions that may inspect or extend DSH itself.
 *
 * **Keep in sync** with `DEVELOPMENT_AGENT_PRESETS` in
 * `packages/plugins/agent/corum-agent/src/prompt-audience.ts`: this file is the
 * desktop glue and deliberately carries no `@corum/*` runtime import (that would
 * drag the whole agent plugin into the shell bundle), so the list has a twin
 * there. `corum-agent/tests/prompt-audience.spec.ts` reconciles both literals
 * verbatim — changing one without the other fails that test.
 */
const DEVELOPMENT_AGENT_PRESETS: readonly string[] = ['corum-dev']

/** The narrow face read from one prompt assembly (no `@deepseek-ai/dsh-agent` import needed). */
interface AssemblyContextFace {
  readonly agent?: { readonly session?: { readonly header?: { readonly agentPreset?: string } } } | undefined
}

/**
 * Whether this assembly belongs to a development-class session.
 *
 * The fact behind it: a `systemPrompt` section provider receives the assembly
 * context, whose `agent` face is the live Agent (`@deepseek-ai/dsh-agent`
 * augments `AssembleContext` with `agent`, and `assembleContextFor()` hands
 * `{ agent, scope: agent }` to `systemPrompt.assemble()` on every step). The
 * durable preset identity lives in `session.header.agentPreset`, written by the
 * session controller at creation and inherited by corum children.
 *
 * Unknown (no agent face, rosterless deployment, diagnostic assembly) counts as
 * development, so the section keeps the pre-gate behavior: a missing harness
 * fact costs a dev session real work, while an extra line to an ordinary
 * session only costs bytes.
 * @param context - the `text(context)` argument of a prompt section provider.
 * @returns whether the DSH checkout line belongs in this assembly.
 */
function isDevelopmentAssembly(context: unknown): boolean {
  const preset = (context as AssemblyContextFace | undefined)?.agent?.session?.header?.agentPreset
  if (typeof preset !== 'string') return true
  return DEVELOPMENT_AGENT_PRESETS.includes(preset)
}

/** Model-visible orientation for sessions created through the desktop app. */
function desktopSurfacePrompt(): string {
  return 'You are interacting with the user through the Corum desktop application. '
    + 'The application is a native window; there is no browser tab and no URL to reload. '
    + 'Files the user asks you to open or create land on the host machine through the same '
    + 'filesystem and approval stack as every other dsh surface.'
}

/**
 * Mount the desktop runtime glue: surface prompt sections and the shell
 * variable. The webServer shim (0.1.2 legacy) is retired — the real
 * @deepseek-ai/dsh-host-webserver Service provides `webServer` in the composed
 * tree, and no desktop row calls `tapIndex` anymore.
 * @param ctx - plugin context (no required services; prompt sections wait for
 * the systemPrompt service and the shell variable for shellEnv).
 */
export function apply(ctx: Context): void {
  ctx.inject(['systemPrompt'], (promptCtx) => {
    // rc3: `addHarnessSourceSection` 已从 dsh-app-boot 删除——直接用 systemPrompt.section()
    // 注册同一段 harness instructions 注入（保留 corum 对 DSH checkout 路径的告知语义）。
    //
    // 2026-11-11（用户报障「系统提示词一会说 DeepSeek Harness、一会又是 CodeBuddy」）：
    // 这里原先把基座写成 **CodeBuddy** —— 那是重命名前的旧名（`b54c1299` 已全局改为
    // corum/DSH 体系），漏了这一段字面量 ⇒ 模型同时被告知两个身份。现与同一条 prompt 的
    // 其余部分统一：**基座 = DeepSeek Harness**，**载具/界面 = Corum**（见下方
    // `desktopSurfacePrompt()`），不再出现第三个名字。
    //
    // 2026-11-12（必要性审计 §1.2 条件注入）：本段只对**开发类角色**注入——只有会
    // inspect / extend DSH 的会话需要知道 checkout 在哪；普通角色白付 ~330B。
    // 判据读组装上下文的 `agent.session.header.agentPreset`（见 `isDevelopmentAssembly`），
    // 判不出来时 fail-open 维持原有的全局注入。空串 ⇒ 框架按空段丢弃。
    promptCtx.systemPrompt.section({
      name: 'harness-source',
      order: -99,
      text: context => isDevelopmentAssembly(context)
        ? `The DeepSeek Harness implementation checkout is at ${SOURCE_ROOT}. The checkout location and current working directory are separate values and may differ; never infer the working directory from this path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.`
        : '',
    })
    promptCtx.systemPrompt.section({
      name: 'app:desktop-surface',
      order: -98,
      text: () => desktopSurfacePrompt(),
    })
  })
  ctx.inject(['shellEnv'], (runtimeCtx) => {
    runtimeCtx.shellEnv.register({
      name: 'corum-desktop-runtime',
      variables: {
        [DSH_CORUM_DESKTOP]: { description: 'Set to "1" when this session runs inside the Corum desktop application.' },
      },
      resolve: () => ({ [DSH_CORUM_DESKTOP]: '1' }),
    })
  })
}
