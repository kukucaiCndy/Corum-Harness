/**
 * smoke-reap.mjs —— `corum-smoke.mjs --launch` **自启动进程的受控回收**（opt-in）。
 *
 * ## 为什么需要它（2026-11-07 rc3 实测）
 * 冲烟自启动的应用是「node 启动器 → Electron → 渲染器/host 桥」一整棵树。旧实现
 * `spawn(detached:true)` 之后**从不回收**：脚本退出后 Electron 仍活着并**独占 CDP 端口**
 * （实测 TERM 掉 node 启动器，Electron 继续 LISTEN :9345），下一次冲烟就因「端口被占」
 * 被自己的守卫拒绝，只能人工 TERM。故必须由**启动方**在收尾时回收自己起的那棵树。
 *
 * ## 归属边界（本模块的全部安全性都建在这条线上）
 * **只回收本次 launch 的那棵树**，绝不按名字/端口宽匹配：
 *  1. 启动方记录 `owned = { pid, marker, port }`（`pid` 就是 `detached` 子进程的 pid，
 *     POSIX 上 `setsid` 之后它同时是**进程组 id**）；
 *  2. 归属判定只认三条证据（见 {@link planOwned}）：
 *     - `pid` 本身（命令行必须含本次启动的 `marker`，否则判为 **pid 复用**并拒绝信号）；
 *     - `pgid === pid` 的组成员（**只有** `detached` 真的成立时才成立，见下）；
 *     - 监听**本次端口**的进程（端口在 spawn 前已验证空闲，见 smoke 的 `portInUse`）。
 *     其余 pid 一律不进信号集；
 *  3. **关键安全不变量**：只有 `ps` 报出的 `pgid === leader.pid` 才允许 `kill(-pgid)`
 *     （组信号）。若实测 leader 的 pgid 是**别人的组**（实测存在这种形态：启动器由
 *     非 detached 的父进程拉起，pgid 指向父组），组信号会打到父组 —— 那可能是
 *     冲烟自己/CTS/**用户主实例**所在的组。此时降级为**精确 pid 树**逐 pid 发信号
 *     （只发往已验明归属的 pid）。
 *
 * ## 平台边界
 * POSIX（darwin/linux）用「owned process group + 精确 pid 树」，**已在本机实测**。
 * Windows 没有进程组语义、`taskkill /T` 也不在本机可验证 ⇒ **不实现**，返回
 * `state:'skip'` 并写明平台边界（宁可留痕不假装回收）。
 *
 * ## opt-in
 * 只有 `CORUM_SMOKE_REAP=1`（CTS 的 GT4/GT5 显式传）才回收；默认不开关 =
 * **旧语义不变**（脚本不主动杀任何东西）。
 *
 * @module smoke-reap
 */
import { spawnSync } from 'node:child_process'
import { connect as netConnect } from 'node:net'
import { platform as processPlatform } from 'node:process'

/** 开启回收的环境变量名（CTS 的 GT4/GT5 会传 `1`）。 */
export const REAP_ENV = 'CORUM_SMOKE_REAP'

/** 真值集合（只认显式真值；空/其它一律视为关闭，防「传了个 0 却被当开」）。 */
const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/**
 * `CORUM_SMOKE_REAP` 是否开启。
 * @param env - 进程环境（测试可注入）。
 * @returns 是否开启回收。
 */
export function isReapEnabled(env = process.env) {
  const raw = env?.[REAP_ENV]
  return typeof raw === 'string' && TRUTHY.has(raw.trim().toLowerCase())
}

/**
 * 解析 `ps -A -o pid=,ppid=,pgid=,command=` 的输出。
 *
 * 为什么用 `ps` 而不是 `/proc`：macOS 没有 `/proc`，而本仓要三平台同一实现（红线 7）。
 * @param text - ps 的 stdout。
 * @returns 进程行（pid/ppid/pgid/command）。
 */
export function parseProcessTable(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    // 前三个字段是数字列，其余**整行**都是命令行（可能含空格/引号，不做分词）。
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] ?? '' })
  }
  return rows
}

/**
 * 取当前进程表。拿不到就返回空表（调用方按「无法判定归属」处理，即拒绝信号）。
 * @returns 进程行数组。
 */
export function readProcessTable() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' })
  if (r.error || r.status !== 0) return []
  return parseProcessTable(r.stdout)
}

/**
 * 端口上的 LISTEN pid 列表（只作**归属证据**，判定本身用 TCP 探测）。
 *
 * Windows 没有 `lsof` ⇒ 返回空数组（不影响回收：组/树判定不依赖它）。
 * @param port - 端口号。
 * @returns pid 数组（拿不到为空）。
 */
export function listPortHolders(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  if (r.error || typeof r.stdout !== 'string') return []
  return r.stdout.split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
}

/**
 * 端口是否仍有人监听（三平台通用判据：能否建立 TCP 连接）。
 * @param port - 端口号。
 * @returns 是否在监听。
 */
export function portInUse(port) {
  return new Promise((resolvePromise) => {
    const socket = netConnect({ host: '127.0.0.1', port })
    const done = (inUse) => {
      socket.destroy()
      resolvePromise(inUse)
    }
    socket.setTimeout(800)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * 命令行里声明的调试端口（`--remote-debugging-port=N`）。
 * @param command - 命令行全文。
 * @returns 端口号；没写返回 null。
 */
function portMarkerOf(command) {
  const m = /--remote-debugging-port=(\d+)/.exec(String(command ?? ''))
  return m ? Number(m[1]) : null
}

/**
 * 判定「本次 launch 的那棵树」里有哪些 pid，并给出**可复核的证据**。
 *
 * 纯函数（不碰进程），便于单测覆盖归属边界：{@link planOwned} 的每条规则都能用
 * 一份 `ps` 快照断言。安全语义：
 *  - **不在** `targets` 里的 pid 永远不会收到信号；
 *  - `refusals` 非空 ⇒ 调用方**不得**发组信号（保守策略，见 {@link createReaper}）。
 *
 * @param input - 判定输入
 * @param input.table - 进程表（{@link parseProcessTable} 的结果）
 * @param input.owned - 本次启动记录 `{ pid, marker, port }`
 * @param input.port - 本次 CDP 端口
 * @param input.portHolders - 该端口的 LISTEN pid
 * @param input.selfPid - 本进程 pid（绝不信号自己）
 * @param input.protectedPids - 绝不允许进信号集的 pid（如主实例/执行端）
 * @returns `{ targets, groupSafe, groupPid, evidence, refusals }`
 */
export function planOwned({ table, owned, port, portHolders = [], selfPid = process.pid, protectedPids = [] }) {
  const evidence = {
    leaderPid: owned?.pid ?? null,
    leader: null,
    leaderPgid: null,
    groupPids: [],
    seeds: [],
    portHolders: [...portHolders],
    foreignPortHolders: [],
    protected: [],
  }
  const refusals = []
  const targets = new Set()
  const add = (pid, why) => {
    if (!Number.isInteger(pid) || pid <= 0) return
    if (pid === selfPid) {
      refusals.push(`候选 pid ${pid} 就是本进程 —— 绝不信号自己`)
      return
    }
    if (!targets.has(pid)) {
      targets.add(pid)
      evidence.seeds.push({ pid, why })
    }
  }

  if (!owned || !Number.isInteger(owned.pid)) {
    refusals.push('没有本次 launch 的记录（未起进程）')
    return { targets: [], groupSafe: false, groupPid: null, evidence, refusals }
  }
  if (owned.pid <= 1) {
    refusals.push(`非法 leader pid=${owned.pid} —— 绝不信号 pid<=1`)
    return { targets: [], groupSafe: false, groupPid: null, evidence, refusals }
  }
  if (owned.pid === selfPid) {
    refusals.push(`leader pid=${owned.pid} 就是本进程 —— 绝不信号自己`)
    return { targets: [], groupSafe: false, groupPid: null, evidence, refusals }
  }

  const byPid = new Map(table.map((p) => [p.pid, p]))
  const leader = byPid.get(owned.pid) ?? null
  evidence.leader = leader
  evidence.leaderPgid = leader ? leader.pgid : null

  const groupPids = table.filter((p) => p.pgid === owned.pid && p.pid !== selfPid)
  evidence.groupPids = groupPids.map((p) => p.pid)

  // ── 1. leader 归属：命令行必须含本次启动的 marker（否则是 pid 复用/别的实例）
  let leaderOwned = false
  if (leader) {
    const marker = owned.marker
    if (marker && !leader.command.includes(marker)) {
      refusals.push(
        `leader pid=${owned.pid} 的命令行不含本次启动标记「${marker}」⇒ 疑似 pid 复用，拒绝信号`
        + `（实测命令行：${leader.command.slice(0, 120)}）`,
      )
    } else {
      const markerPort = portMarkerOf(leader.command)
      if (markerPort !== null && markerPort !== port) {
        refusals.push(`leader pid=${owned.pid} 的调试端口=${markerPort} ≠ 本次端口 ${port} ⇒ 疑似别的实例，拒绝信号`)
      } else {
        leaderOwned = true
        add(leader.pid, 'launch pid（命令行含本次启动标记）')
      }
    }
  }

  // ── 2. 进程组：只有 `pgid === leader pid`（detached 真的成立）才是「我们建的组」
  let groupSafe = false
  if (leaderOwned && leader.pgid === owned.pid) {
    groupSafe = true
  } else if (!leader && groupPids.length > 0) {
    // leader 已退出、组仍在：组成员必须逐条可认（marker 或**本次端口**）。全认得才敢发组信号。
    const unrecognized = groupPids.filter((p) => {
      if (owned.marker && p.command.includes(owned.marker)) return false
      // 认不出启动标记时，只接受「声明了**本次端口**」的成员（端口在 spawn 前已验空闲）。
      return portMarkerOf(p.command) !== port
    })
    if (unrecognized.length === 0) groupSafe = true
    else {
      refusals.push(
        `leader 已退出但组内 ${unrecognized.length} 个成员无法验明归属（pgid=${owned.pid}）`
        + ` ⇒ 不发组信号（见证据 pids=${unrecognized.map((p) => p.pid).join(',')}）`,
      )
    }
  }
  if (groupSafe) {
    for (const p of groupPids) add(p.pid, `pgid=${owned.pid} 组成员`)
  }

  // ── 3. 本次端口上的 LISTEN 进程：端口是 spawn 前验证空闲的，按证据纳入
  for (const pid of portHolders) {
    const p = byPid.get(pid)
    if (!p) continue
    if (targets.has(pid)) continue
    const mp = portMarkerOf(p.command)
    if (mp !== null && mp !== port) {
      evidence.foreignPortHolders.push({ pid, command: p.command.slice(0, 160), reason: `调试端口=${mp}≠${port}` })
      refusals.push(`端口 :${port} 上 pid=${pid} 声明的是**别的**调试端口 ${mp} ⇒ 别的实例，拒绝信号`)
      continue
    }
    add(pid, `端口 :${port} 的 LISTEN 进程`)
  }

  // ── 4. 精确 pid 树：从已确认的 pid 出发按 ppid 闭包补齐后代（跨组也认，因为**父链可证**）
  let grew = true
  while (grew) {
    grew = false
    for (const p of table) {
      if (targets.has(p.pid) || p.pid === selfPid) continue
      if (targets.has(p.ppid)) {
        add(p.pid, `ppid=${p.ppid} 的后代`)
        grew = true
      }
    }
  }

  // ── 5. 保护名单：主实例/执行端 pid 一旦出现在信号集里就整体拒绝（永不发信号）
  for (const pid of protectedPids) {
    if (targets.has(pid)) {
      evidence.protected.push(pid)
      refusals.push(`信号集里出现了受保护 pid=${pid}（主实例/执行端）⇒ 整体拒绝信号`)
    }
  }

  return {
    targets: refusals.some((r) => r.includes('整体拒绝信号')) ? [] : [...targets],
    groupSafe,
    groupPid: groupSafe ? owned.pid : null,
    evidence,
    refusals,
  }
}

/**
 * 建一个「本次 launch 的回收器」。
 *
 * 生命周期：`ownProcess()`（spawn 成功后立刻）→ 收尾 `await reap()`（成功/失败/异常路径
 * 都要调）。`reap()` 幂等（第二次直接返回首轮报告）。开关关闭时 `reap()` 返回
 * `state:'skip'` 且**不发任何信号**（旧语义不变）。
 *
 * @param options - 配置
 * @param options.enabled - 是否 opt-in 开启（`CORUM_SMOKE_REAP`）
 * @param options.port - 本次 CDP 端口
 * @param options.protectedPids - 绝不允许信号的 pid（主实例等）
 * @param options.protectedPorts - 绝不允许信号的端口（主实例 9222 / 执行端端口）：其 LISTEN pid 自动进保护名单
 * @param options.platform - 平台（测试可注入）
 * @param options.deps - 依赖注入（测试用：readTable/kill/sleep/listPortHolders/isPortInUse/时限）
 * @returns 回收器 `{ isEnabled, ownProcess, describe, reap }`
 */
export function createReaper(options = {}) {
  const {
    enabled = false,
    port,
    protectedPids = [],
    protectedPorts = [],
    platform = processPlatform,
    deps = {},
  } = options
  const readTable = deps.readTable ?? readProcessTable
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal))
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const portHoldersOf = deps.listPortHolders ?? listPortHolders
  const portOpen = deps.isPortInUse ?? portInUse
  const termGraceMs = deps.termGraceMs ?? 3000
  const killGraceMs = deps.killGraceMs ?? 2000
  const pollMs = deps.pollMs ?? 100

  let owned = null
  let firstRun = null

  /**
   * 登记「本次自己起的进程」。
   * @param record - `{ pid, marker, port }`；`marker` 是命令行里应出现的启动标记。
   */
  function ownProcess(record) {
    owned = {
      pid: record?.pid,
      marker: record?.marker ?? '',
      port: record?.port ?? port,
      startedAt: Date.now(),
      command: record?.command ?? '',
    }
  }

  /** 报告摘要（写进 result.json 的 `cleanup` 字段）。 */
  function describe() {
    return firstRun
  }

  /** 等条件成立（或超时），返回是否成立。 */
  async function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await predicate()) return true
      if (Date.now() >= deadline) return false
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    }
  }

  /** 目标里还活着几个（按当前进程表）。 */
  function livingTargets(ids) {
    const table = readTable()
    const set = new Set(ids)
    return table.filter((p) => set.has(p.pid)).map((p) => ({ pid: p.pid, ppid: p.ppid, command: String(p.command ?? '').slice(0, 160) }))
  }

  /**
   * 执行回收。
   * @returns 报告（`state: pass|fail|skip`）。
   */
  async function reap() {
    if (firstRun !== null) return firstRun

    const started = Date.now()
    const report = {
      requested: true,
      enabled,
      platform,
      port,
      ownedPid: owned?.pid ?? null,
      signalPath: 'none',
      phases: [],
      before: null,
      after: null,
      refusals: [],
      errors: [],
      durationMs: 0,
      state: 'skip',
      detail: '',
    }
    const finish = (state, detail) => {
      report.state = state
      report.detail = detail
      report.durationMs = Date.now() - started
      firstRun = report
      return report
    }

    if (!enabled) {
      return finish('skip', `未开启 ${REAP_ENV}（opt-in）⇒ 本次**不回收**任何进程，旧语义不变`)
    }
    if (!owned || !Number.isInteger(owned.pid)) {
      return finish('skip', '本次未 launch（或启动早期就失败、没有子进程）⇒ 没有可回收的进程')
    }
    if (platform === 'win32') {
      return finish(
        'skip',
        'Windows 无 POSIX 进程组语义，`taskkill /T` 未在本机真机验证 ⇒ **未实现自动回收**（平台边界，'
        + `不等于回收成功；留痕 pid=${owned.pid} 供人工清理）`,
      )
    }

    const holders = portHoldersOf(port)
    // 受保护 pid = 显式给的 + 受保护端口（主实例/执行端）上的 LISTEN 进程。
    const guarded = [...protectedPids]
    for (const p of protectedPorts) {
      if (!Number.isInteger(p) || p === port) continue
      guarded.push(...portHoldersOf(p))
    }
    const plan = planOwned({
      table: readTable(),
      owned,
      port,
      portHolders: holders,
      protectedPids: guarded,
    })
    report.before = plan.evidence
    report.refusals = plan.refusals
    // 归属不能完全证实 ⇒ **不发信号**（宁留痕迹，也不误杀）。但如果确实已无目标，判 pass。
    const blockedByRefusal = plan.refusals.length > 0 && plan.targets.length === 0

    if (plan.targets.length === 0) {
      const stillListening = await portOpen(port)
      report.after = { residual: [], portOpen: stillListening }
      if (stillListening) {
        return finish('fail', `端口 :${port} 仍被监听，但没找到可确认归属的进程 ⇒ 未发信号（见 refusals）`)
      }
      return finish(
        blockedByRefusal ? 'skip' : 'pass',
        blockedByRefusal
          ? `没有可回收的已确认进程（${plan.refusals.join('；')}）——证据已记录，未发任何信号`
          : '启动的进程已经自行退出（无可回收进程，端口已关闭）',
      )
    }

    // ── 发信号：组信号仅在「组真的是我们建的」时使用；否则精确 pid 树
    const groupSignal = plan.groupSafe && plan.groupPid !== null
    report.signalPath = groupSignal ? 'process-group' : 'pid-tree'

    const signal = (targetIds, sig, phase) => {
      const entry = { signal: sig, path: report.signalPath, phase, targets: targetIds.slice(), errors: [] }
      if (groupSignal && targetIds.length > 0) {
        // 只发一次负 pid（组）；逐 pid 的那轮仅用于**不属于本组**的少数目标。
        const outside = targetIds.filter((id) => !plan.evidence.groupPids.includes(id))
        try {
          kill(-plan.groupPid, sig)
          entry.sent = `kill(-${plan.groupPid}, ${sig})`
        } catch (e) {
          // ESRCH = 组已不存在（正常竞态）；其余如实记录。
          entry.errors.push({ target: -plan.groupPid, code: e?.code ?? 'UNKNOWN', message: String(e?.message ?? e) })
        }
        for (const id of outside) {
          try {
            kill(id, sig)
          } catch (e) {
            entry.errors.push({ target: id, code: e?.code ?? 'UNKNOWN', message: String(e?.message ?? e) })
          }
        }
      } else {
        for (const id of targetIds) {
          try {
            kill(id, sig)
          } catch (e) {
            entry.errors.push({ target: id, code: e?.code ?? 'UNKNOWN', message: String(e?.message ?? e) })
          }
        }
      }
      report.errors.push(...entry.errors)
      report.phases.push(entry)
    }

    signal(plan.targets, 'SIGTERM', 'term')
    await waitFor(() => livingTargets(plan.targets).length === 0, termGraceMs)

    let residual = livingTargets(plan.targets)
    if (residual.length > 0) {
      signal(residual.map((p) => p.pid), 'SIGKILL', 'kill')
      await waitFor(() => livingTargets(plan.targets).length === 0, killGraceMs)
      residual = livingTargets(plan.targets)
    }

    const stillListening = await portOpen(port)
    report.after = { residual, portOpen: stillListening, checkMs: Date.now() - started }

    const reaped = plan.targets.length - residual.length
    const summary = `pid=${owned.pid}（${report.signalPath}）目标 ${plan.targets.length} 个，已回收 ${reaped} 个，`
      + `残留 ${residual.length} 个，端口 :${port} ${stillListening ? '仍在监听' : '已关闭'}`

    if (residual.length > 0 || stillListening) {
      const why = residual.length > 0
        ? `残留：${residual.map((p) => `${p.pid}(${p.command.slice(0, 60)})`).join('、')}`
        : '进程已退出但端口仍在监听'
      return finish(
        'fail',
        `${summary}；${why}${report.errors.length > 0 ? `；信号错误：${report.errors.map((e) => `${e.target}:${e.code}`).join(',')}` : ''}`,
      )
    }
    return finish(
      'pass',
      `${summary}${report.errors.length > 0 ? `（信号错误已如实记录：${report.errors.map((e) => `${e.target}:${e.code}`).join(',')}）` : ''}`,
    )
  }

  return { isEnabled: () => enabled, ownProcess, describe, reap }
}
