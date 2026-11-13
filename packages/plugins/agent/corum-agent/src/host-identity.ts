/**
 * fork（corum）：**宿主身份段**——把「你这个会话跑在哪个实例 / home / CDP 端口上」作为
 * 事实注入系统提示词（2026-09-12 用户定调，起因是一次实测事故）。
 *
 * ## 为什么需要它
 *
 * 2026-09-12 首轮派发（corum-task-d51272e3）里，子 Agent 需要判断「哪个实例在跑、
 * 我能不能重启它」，而**会话从内部无法知道自己的宿主**：实测它的 bash 里
 * `echo $CORUM_HOME` 是空的。于是它用 `ps`（沙箱禁）→ `lsof` 拼凑，`cdp.mjs` 又因为
 * 默认端口是 9222 而驱动了**用户主实例**，读到用户真实会话后得出错误结论
 * 「:9333 的宿主就是我」，差一步就去重启用户正在用的应用。
 *
 * 结论：这不是提示词措辞问题，而是**事实缺失**——宿主身份必须由 host 注入，不能靠猜。
 * 本段与 `home.ts`（把 CORUM_HOME 写进进程环境，供 bash/脚本继承）配套：
 *   · 环境变量让**脚本**能拿到（技能里的 verify-instance.sh 等按它解析）；
 *   · 本段让**模型**能拿到（提示词里直接写着，不必去翻环境）。
 *
 * 写作纪律：只写事实（实例角色 / home / 端口 / 谁可以重启谁），不写操作教程——
 * 操作步骤是 `corum-cdp-verify` 技能的家。
 *
 * 2026-11-12（必要性审计 §1.2 条件注入）：本段拆两半——
 *   · **核心事实**（实例 role / home / 工作目录 / 「不许重启宿主」）对**所有**会话都成立，
 *     恒注入；
 *   · **CDP 端口 / attach / verify 实例规则**只对开发类角色有意义（普通角色没有 CDP 驱动面，
 *     也不该去连别的实例）⇒ 只对开发类角色注入，判据见 `prompt-audience.ts`。
 * 2026-11-13（P1 修复）：重启规则按视角拆分，消除 verify 宿主自相矛盾。
 *   「永不从内部重启自己的宿主」是普适不变式（从内部重启宿主 = 杀死自己的会话，
 *   对 main 与 verify 都成立）；「可随意重启 verify 实例」是它作为**被测目标、被宿主
 *   在别处的会话从外部驱动**时的属性，写进 verify 的 roleLine，不再与「不许重启宿主」
 *   并列出现在同一视角。两条规则按视角分开，不再对同一视角矛盾。
 *
 * @module @corum/corum-agent/host-identity
 */

/** 宿主身份段的段名（root scope；所有 corum 会话继承）。 */
export const HOST_IDENTITY_SECTION = 'corum:host-identity'

/** 宿主实例角色：主实例（用户在用）/ 验证实例（被测目标，宿主在别处的会话可从外部随意重启；它承载会话时同样不可自重启）。 */
export type HostInstanceRole = 'main' | 'verify'

/**
 * 由 home 路径判定实例角色。
 *
 * 口径与 `scripts/verify-instance.sh` 一致：验证实例的 home 目录名是
 * `.corum-verify-home`（或用户用 `CORUM_VERIFY_HOME` 起的 `*-verify*-home`）。
 * @param home - 解析后的 home 绝对路径。
 * @returns `verify` 表示这是 Agent 自己的验证实例，其余为 `main`。
 */
export function hostInstanceRole(home: string): HostInstanceRole {
  return /\.corum-verify[^/]*home/.test(home) ? 'verify' : 'main'
}

/** 该实例默认的 CDP 端口（与两个启动脚本的口径一致）。 */
export function hostInstancePort(role: HostInstanceRole, configured?: string): string {
  if (configured !== undefined && configured.trim() !== '') return configured.trim()
  return role === 'verify' ? '9333' : '9222'
}

/**
 * 生成宿主身份段文本。
 * @param home - 解析后的 home 绝对路径（CORUM_HOME/DSH_HOME 的值）。
 * @param configuredPort - 进程环境里的 `CORUM_DEBUG_PORT`（缺省按角色取默认端口）。
 * @param cwd - 会话工作目录（写进事实里，避免模型再去 pwd）。
 * @param options - 读者分类：`development` 为 true 时拼上 CDP 端口 / attach / verify 实例规则
 *   （2026-11-12 条件注入；缺省不拼）。main 读者文本与拆分前**逐字相同**；
 *   verify 读者文本在 P1 修复（2026-11-13）中变更（重启规则按视角拆分）。
 * @returns 提示词段文本。
 */
export function hostIdentityText(
  home: string,
  configuredPort?: string,
  cwd?: string,
  options: HostIdentityOptions = {},
): string {
  const development = options.development === true
  const role = hostInstanceRole(home)
  const port = hostInstancePort(role, configuredPort)
  const roleLine = role === 'verify'
    ? 'This is the VERIFY instance: it exists for on-device verification and is disposable — a session hosted elsewhere (e.g. the main instance) may restart it freely.'
    : 'This is the MAIN instance: the user is using it right now; it is not yours to restart or kill.'
  return [
    'You run inside a corum desktop instance. These are facts about it, not guesses:',
    `- Instance role: ${role} (${roleLine})`,
    `- Home (sessions, settings, skills, presets): ${home}`,
    ...development ? [`- CDP port of this instance: ${port} (attach with CDP_PORT=${port})`] : [],
    ...(cwd === undefined || cwd === '' ? [] : [`- Working directory: ${cwd}`]),
    '',
    'Consequences:',
    ...development
      ? ['- Verify against the port above; never drive another instance\'s port. The user\'s main instance is off-limits unless the user authorizes it in this conversation.']
      : [],
    role === 'main'
      ? '- Never restart or kill the instance hosting this session: you cannot see it from the inside, and restarting the main instance destroys the user\'s work. Ask the user (or let the main Agent decide) instead.'
      : '- Never restart or kill the instance hosting this session: this session runs inside the verify instance, and restarting it from here would end this session mid-work. A restart must be driven from outside (a session hosted elsewhere, or the user).',
    ...development
      ? ['- Other instances may exist (a verify instance defaults to port 9333; the main instance to 9222). Reuse the one that is already running rather than starting a second one.']
      : [],
  ].join('\n')
}

/** {@link hostIdentityText} 的读者分类选项。 */
export interface HostIdentityOptions {
  /**
   * 读者是**开发类角色**（会话可能 inspect / extend DSH，会经 CDP 驱动实例）：
   * 拼上 CDP 端口行与「验证/别的实例」两条规则。判据见 `prompt-audience.ts`。
   */
  readonly development?: boolean
}
