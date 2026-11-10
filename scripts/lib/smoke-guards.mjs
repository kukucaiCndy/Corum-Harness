/**
 * smoke-guards.mjs —— `scripts/corum-smoke.mjs` 的**可单测守卫**。
 *
 * 为什么把守卫抽出来（T4）：这些判断原来是散在 `main()` 里的内联 `if`，
 * 只能靠「真起一个实例」去验 —— 而「守卫没生效」恰恰是最不该用真实进程才发现的事
 * （它要么误杀用户主实例，要么给出假绿）。这里只放**纯函数**：输入端口/环境变量/
 * 探测结果，输出「准不准跑」，不碰进程、不碰端口、不读文件。
 *
 * ## 威胁模型
 *
 * 冲烟脚本可能被**从某个 Corum 实例内部**启动（Agent 在自己的宿主里跑
 * `npm run smoke`）。此时若它附着/启动到**执行端自己**，结论毫无意义：
 * - 附着自己 → 测的是「我」而不是「另装的版本」；
 * - 启动一个同端口的自己 → 端口被占，或验的是旧实例（假绿）。
 *
 * 已知的主实例（9222）永远一票否决；「执行端端口」由环境给出：
 * `CORUM_SMOKE_EXECUTOR_PORT`（显式）→ `CORUM_DEBUG_PORT`（应用自己的端口）。
 *
 * ## fail-closed 的边界（重要）
 *
 * - **attach**（不 launch）：要连的端口就是执行端自己 → 目标端口必须被**证明空闲**
 *   （探测结果为「明确无监听」），或执行端端口已知且与目标不同；两者都拿不到时
 *   **拒绝**（`unproven-isolation`）—— 这是唯一能防住「测了自己」的判据。
 * - **launch**：本脚本自己 spawn 一个**新进程**并要求目标端口**被证明空闲**
 *   （见 {@link evaluateLaunchPort}），因此结构上不可能附着到既有实例；
 *   若执行端端口恰好等于目标端口，同样被 `executor-port` 挡住。
 *
 * 所有拒绝都带 `code` 与**人能照做的处置**（`reason`），不是甩一个布尔。
 *
 * @module scripts/lib/smoke-guards
 */

/** 用户主实例端口 —— 永远不碰（与 `scripts/cdp.mjs` 同一纪律）。 */
export const MAIN_INSTANCE_PORT = 9222

/**
 * 「执行端端口」环境变量（按优先级）。`CORUM_SMOKE_EXECUTOR_PORT` 是显式口径，
 * 适合从任意 shell 里跑时由调用方声明；`CORUM_DEBUG_PORT` 是应用给自身用的端口
 * （`user-data-dir` 与单实例锁也由它派生），在实例内部启动时会自动带上。
 */
export const EXECUTOR_PORT_ENV_KEYS = ['CORUM_SMOKE_EXECUTOR_PORT', 'CORUM_DEBUG_PORT']

/**
 * 解析端口（字符串/数字都收；非法、非整数、越界一律 null）。
 * @param {unknown} raw - 环境变量值或数字
 * @returns {number | null} 合法端口，或 null
 */
export function parsePort(raw) {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : null
  }
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/**
 * 收集环境里声明的「执行端端口」（去重、忽略非法值）。
 * @param {Record<string, string | undefined>} env - 环境变量
 * @returns {number[]} 执行端端口列表（可能为空）
 */
export function collectExecutorPorts(env = {}) {
  const ports = []
  for (const key of EXECUTOR_PORT_ENV_KEYS) {
    const port = parsePort(env[key])
    if (port !== null && !ports.includes(port)) ports.push(port)
  }
  return ports
}

/**
 * 判断「准不准在这个端口上跑冲烟」。
 *
 * @param {object} input - 判定输入
 * @param {number} input.port - 目标 CDP 端口
 * @param {boolean} [input.launch] - 是否自启动（`--launch`）
 * @param {boolean | null} [input.targetListening] - 目标端口探测结果：
 *   `true`=有人在听，`false`=**明确空闲**，`null`/省略=判不出来（按 fail-closed 处理）
 * @param {Record<string, string | undefined>} [input.env] - 环境变量
 * @returns {{ allowed: boolean, code: string | null, reason: string }} 判定结果
 */
export function evaluateSmokeGuard({ port, launch = false, targetListening = null, env = {} }) {
  const mode = launch ? '自启动' : '附着'
  if (parsePort(port) === null) {
    return {
      allowed: false,
      code: 'invalid-port',
      reason: `目标端口不合法：${JSON.stringify(port)}（应为 1..65535 的整数）`,
    }
  }
  if (port === MAIN_INSTANCE_PORT) {
    return {
      allowed: false,
      code: 'main-instance',
      reason: `拒绝在 :${MAIN_INSTANCE_PORT} 上跑冲烟（${mode}）—— 那是用户主实例，`
        + '会读到/扰动用户真实会话。用 CDP_PORT=9333（或别的空闲端口）重试。',
    }
  }
  const executorPorts = collectExecutorPorts(env)
  if (executorPorts.includes(port)) {
    return {
      allowed: false,
      code: 'executor-port',
      reason: `拒绝${mode}到 :${port} —— 它是**执行端自己**的端口（来自 `
        + 'CORUM_SMOKE_EXECUTOR_PORT / CORUM_DEBUG_PORT）。测自己不构成证据。'
        + ' 处置：用一个与执行端不同的空闲端口（如 CDP_PORT=9333）。',
    }
  }
  // attach：无法证明「不是自己」就必须拒绝（fail-closed）。
  if (!launch && targetListening !== false && executorPorts.length === 0) {
    return {
      allowed: false,
      code: 'unproven-isolation',
      reason: `无法证明 :${port} 不是执行端自己（端口${targetListening === true ? '有人在听' : '探测结果未知'}，`
        + '且环境里没有 CORUM_SMOKE_EXECUTOR_PORT / CORUM_DEBUG_PORT）。'
        + ' 处置：① 用一个明确空闲的端口（先停掉该端口上的实例）；或 '
        + '② 声明执行端端口 CORUM_SMOKE_EXECUTOR_PORT=<本实例端口>，让守卫能判「不同」。',
    }
  }
  return { allowed: true, code: null, reason: '' }
}

/**
 * 自启动前的端口判据（原有拒绝逻辑的纯函数版，T4 要求保留并覆盖测试）。
 *
 * 为什么**未知**也拒绝：启动后本脚本的判据是「连上 :PORT 的主页面 + 读 launch.log」。
 * 端口上若已有别的实例，`waitPage` 会连上它、日志却来自新进程 ⇒ 结论来源混杂。
 * 判不出是否被占时宁可明确失败，也不给出一个来源混杂的「通过」。
 *
 * @param {object} input - 判定输入
 * @param {number} input.port - 目标 CDP 端口
 * @param {boolean | null} input.listening - 探测结果（`false` = 明确空闲）
 * @returns {{ allowed: boolean, code: string | null, reason: string }} 判定结果
 */
export function evaluateLaunchPort({ port, listening }) {
  if (listening === false) return { allowed: true, code: null, reason: '' }
  if (listening === true) {
    return {
      allowed: false,
      code: 'port-occupied',
      reason: `端口 :${port} 已被占用 —— 拒绝启动。否则可能附着到旧实例`
        + '（验的是旧进程却报告新进程通过，假绿）。处置：停掉它，或换 CDP_PORT 重跑。',
    }
  }
  return {
    allowed: false,
    code: 'port-unproven',
    reason: `判不出端口 :${port} 是否空闲（探测超时/异常）—— 按 fail-closed 拒绝启动。`
      + ' 处置：确认该端口无监听后重跑，或换 CDP_PORT。',
  }
}

/**
 * 是否启用「自启动实例清理」（opt-in，默认关闭 —— 不改变人工 smoke 的语义）。
 * @param {Record<string, string | undefined>} env - 环境变量
 * @returns {boolean} 是否启用
 */
export function shouldReap(env = {}) {
  return env.CORUM_SMOKE_REAP === '1'
}

/**
 * 清理计划（纯判定，不动进程）。
 *
 * 只允许清理**本次 launchApp 启动的 pid**，且必须是**进程组**目标：
 * `spawn(..., { detached: true })` 让子进程成为新进程组的组长 ⇒ `-pid` 覆盖它
 * spawn 出来的全部 Electron 助手进程（子树）。任何其它 pid 都不许碰。
 *
 * @param {object} input - 判定输入
 * @param {boolean} input.enabled - 是否 opt-in（`shouldReap`）
 * @param {number | null | undefined} input.launchedPid - 本次启动的 pid
 * @param {number} [input.selfPid] - 当前进程 pid（绝不自杀）
 * @returns {{ reap: boolean, pid: number | null, reason: string }} 清理计划
 */
export function reapPlan({ enabled, launchedPid, selfPid = process.pid }) {
  if (!enabled) return { reap: false, pid: null, reason: '未启用（CORUM_SMOKE_REAP!=1）' }
  if (typeof launchedPid !== 'number' || !Number.isInteger(launchedPid)) {
    return { reap: false, pid: null, reason: '本次没有自启动实例（无 pid）' }
  }
  if (launchedPid <= 1) {
    return { reap: false, pid: null, reason: `pid=${launchedPid} 不是可清理的目标` }
  }
  if (launchedPid === selfPid) {
    return { reap: false, pid: null, reason: '目标 pid 等于本进程，拒绝自杀' }
  }
  return { reap: true, pid: launchedPid, reason: '' }
}

/**
 * 进程组信号目标（`-pid`）。
 * @param {number} pid - 组长 pid
 * @returns {number} 负 pid（进程组）
 */
export function processGroupTarget(pid) {
  return -pid
}

/**
 * 清理本次自启动的 pid 子树：`SIGTERM` → 等待 → 仍活着则 `SIGKILL`。
 *
 * 一切副作用都经注入（`kill` / `probe` / `sleep`），因此可用 mock 覆盖而不真起进程。
 * 失败**不抛**：清理是收尾，不该把一次已经跑完的 smoke 变成崩溃。
 *
 * @param {object} input - 清理输入
 * @param {number | null | undefined} input.pid - 本次启动的 pid
 * @param {boolean} input.enabled - 是否 opt-in
 * @param {number} [input.selfPid] - 当前进程 pid
 * @param {number} [input.termWaitMs] - TERM 之后等待多久再 KILL
 * @param {(target: number, signal: string) => void} [input.kill] - 发信号（可注入）
 * @param {(target: number) => boolean} [input.probe] - 是否还活着（可注入）
 * @param {(ms: number) => Promise<void>} [input.sleep] - 等待（可注入）
 * @returns {Promise<{ reaped: boolean, signals: string[], error?: string }>} 结果
 */
export async function reapLaunchedSubtree({
  pid,
  enabled,
  selfPid = process.pid,
  termWaitMs = 2000,
  kill = (target, signal) => process.kill(target, signal),
  probe = (target) => {
    try {
      process.kill(target, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  },
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const plan = reapPlan({ enabled, launchedPid: pid, selfPid })
  if (!plan.reap) return { reaped: false, signals: [], error: plan.reason }

  const target = processGroupTarget(plan.pid)
  const signals = []
  try {
    kill(target, 'SIGTERM')
    signals.push('SIGTERM')
  } catch (error) {
    // ESRCH = 早就退了（正常），其它错误如实回报但不抛。
    if (error?.code !== 'ESRCH') {
      return { reaped: true, signals, error: `SIGTERM 失败：${error?.message ?? String(error)}` }
    }
    return { reaped: true, signals }
  }
  await sleep(termWaitMs)
  if (!probe(target)) return { reaped: true, signals }
  try {
    kill(target, 'SIGKILL')
    signals.push('SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      return { reaped: true, signals, error: `SIGKILL 失败：${error?.message ?? String(error)}` }
    }
  }
  return { reaped: true, signals }
}

/**
 * 同步兜底清理（给 `process.on('exit')` 用：那一刻不能再等待）。
 *
 * 只对**本次启动的 pid** 发 `SIGKILL`，其余一律不动。
 *
 * @param {object} input - 输入
 * @param {number | null | undefined} input.pid - 本次启动的 pid
 * @param {number} [input.selfPid] - 当前进程 pid
 * @param {(target: number, signal: string) => void} [input.kill] - 发信号（可注入）
 * @returns {boolean} 是否真的发了信号
 */
export function forceKillLaunched({ pid, selfPid = process.pid, kill = (target, signal) => process.kill(target, signal) }) {
  const plan = reapPlan({ enabled: true, launchedPid: pid, selfPid })
  if (!plan.reap) return false
  try {
    kill(processGroupTarget(plan.pid), 'SIGKILL')
    return true
  } catch {
    return false
  }
}
