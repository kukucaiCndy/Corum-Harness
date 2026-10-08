/**
 * corum-desktop/corum-terminal — 真实终端 Host 半（Typert Remote，service 名
 * `corumTerminal`）。把 IDE 底部面板（corum.panel 槽）的假 TERM_LINES 换成
 * node-pty 驱动的真实登录 shell：renderer 的 xterm.js 经本服务 spawn / 输入 /
 * resize / kill，输出走统一事件中心推送。
 *
 * 输出回流（统一事件中心一期，2026-09 迁移）：pty.onData 同步
 * `ctx.emit('corum/terminal/output', { id, data })`——该事件经 fork 包
 * @corum/corum-api-remotes 的官方 forwarded-Remote-event 通道实时推给
 * renderer（client `ctx.remote.$on('corum/terminal/output', ...)` 直收）。
 * 三期（2026-09）：`poll` 端点 + 会话环形缓冲已删——host 与 renderer 同一
 * 构建产物、同生同死，「host 旧版不 emit」永不发生（审计
 * .dbg/event-bus-audit-2026-09.md P1-1；一期 CDP 实测 pollStarts=0）。
 *
 * @Remote 方法直接 return value（信封自动包成 `{ ok: true, value }`），失败
 * throw（包成 `{ ok: false, error }`）。
 * @module corum-desktop/corum-terminal
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import * as pty from 'node-pty'
// 拉入 corum 领域事件的 cordis Events 声明（'corum/terminal/output' 等）——
// 声明在 fork 包 @corum/corum-api-remotes 自包含（UNIFIED-EVENT-BUS §2.2 类型
// 安全三段式之一），type-only import 编译期即擦除，无运行时依赖。
import type {} from '@corum/corum-api-remotes/corum-events'

/** 终端会话的 shell 与其参数（按平台解析；见 {@link resolveTerminalShell}）。 */
interface TerminalShell {
  readonly shell: string
  /** 可变数组：`node-pty` 的 `spawn` 形参是 `string[]`，不接 `readonly`。 */
  readonly args: string[]
}

/**
 * 在 PATH 里找一个可执行的 shell。
 *
 * Windows 上 `pwsh` 常是**后装的**（PowerShell 7），`powershell.exe` 才是系统自带；
 * 而 `cmd.exe` 一定在。故这里做「按序探测第一个存在的」，避免把一个不存在的
 * 可执行名交给 `pty.spawn`（那会抛，整块终端不可用）。
 * @param candidates - 按优先级排列的可执行名（含扩展名，Windows 用）。
 * @returns 第一个在 PATH 中找到的；都没有时返回 `undefined`。
 */
function firstOnPath(candidates: readonly string[]): string | undefined {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((d) => d !== '')
  for (const name of candidates) {
    for (const dir of dirs) {
      if (existsSync(join(dir, name))) return name
    }
  }
  return undefined
}

/**
 * 按平台解析终端要 spawn 的 shell 与参数。
 *
 * **为什么必须有这个函数**：原实现硬编码 `process.env.SHELL || '/bin/zsh'` + `['-l']`，
 * 在 Windows 上两个前提都不成立（`SHELL` 通常未设、`/bin/zsh` 不存在、`-l` 也不是
 * Windows shell 的参数）⇒ `pty.spawn` 必抛，**整块终端面板不可用**。
 * 平台口径与 `corum-orchestration` 保持一致：win32 = pwsh 系，POSIX = 登录 shell。
 * @returns 要 spawn 的 shell 名与其参数。
 */
function resolveTerminalShell(): TerminalShell {
  if (process.platform === 'win32') {
    const shell = firstOnPath(['pwsh.exe', 'powershell.exe']) ?? 'cmd.exe'
    // cmd.exe 不认识 -NoLogo；pwsh/powershell 用它抑制版权头。
    return { shell, args: shell === 'cmd.exe' ? [] : ['-NoLogo'] }
  }
  return { shell: process.env.SHELL || '/bin/zsh', args: ['-l'] }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 真实终端服务（IDE 底部面板 xterm.js 的数据源）。 */
    corumTerminal: CorumTerminalService
  }
}

/** 缓冲的一帧输出（断链补帧用；seq 单调递增，renderer 据此发现缺帧）。 */
interface BufferedFrame {
  seq: number
  data: string
}

/** 断链补帧缓冲上限（字符；超出从最旧帧起整帧裁剪，不切碎 ANSI 序列）。 */
const TERMINAL_BUFFER_LIMIT = 256 * 1024

/** 一个终端会话：pty 句柄 + 退出状态 + 输出缓冲。 */
interface TerminalSession {
  proc: pty.IPty
  /** 子进程退出码（未退出为 undefined）。 */
  exitCode?: number
  /** 是否已退出（exitCode 可能在异常路径下缺席，故独立标记）。 */
  exited: boolean
  /** 已发出的输出帧序号（每帧 +1）。 */
  seq: number
  /** 最近输出帧（环形裁剪到 TERMINAL_BUFFER_LIMIT；断链补帧的数据源）。 */
  frames: BufferedFrame[]
  /** frames 的字符总长（避免每帧重算）。 */
  buffered: number
}

/**
 * 真实终端 Remote：node-pty 登录 shell 会话管理。
 *
 * 不走 fiber 的 static inject：本服务由 boot 回调在根 ctx 直 new（与
 * CorumFsService 同一模式），无依赖服务。
 */
export class CorumTerminalService extends TypertRemoteService {
  /** 活跃会话表（id → session）。 */
  private sessions = new Map<string, TerminalSession>()

  constructor(ctx: Context) {
    super(ctx, 'corumTerminal')
  }

  /**
   * spawn 一个交互 shell 会话。**按平台选 shell 与参数**（2026-10-08）：
   *   - POSIX：`$SHELL || '/bin/zsh'` + `['-l']`（登录 shell 让 PATH/别名等用户配置生效）；
   *   - Windows：`pwsh` 优先（与 `corum-orchestration` 的平台 shell 口径一致：
   *     win32 = pwsh，POSIX = bash），缺失时回落 `powershell.exe`，再回落 `cmd.exe`。
   *     **绝不能**在 Windows 上沿用 `/bin/zsh` —— `SHELL` 通常未设、且该路径不存在 ⇒
   *     `pty.spawn` 必抛，整块终端面板不可用（`docs/PLATFORM-SPLIT.md` §5 已登记）。
   *     参数用 `-NoLogo`（pwsh/powershell 的等价于「不打印版权头」）；cmd 没有该参数。
   * cwd 缺省回退 host 进程 cwd（IDE 场景即项目根）。
   * @param cwd - 会话初始工作目录（绝对路径；不存在时 node-pty 抛错，信封
   *   自动包成 `{ ok: false, error }`）。
   * @returns 会话 id（后续 write/resize/poll/kill 的句柄）。
   */
  @Remote('create')
  async create(cwd?: string): Promise<{ id: string }> {
    const { shell, args } = resolveTerminalShell()
    const id = randomUUID()
    let proc: pty.IPty
    try {
      proc = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: cwd ?? process.cwd(),
        env: process.env,
      })
    } catch (error) {
      throw new Error(`cannot spawn shell ${shell}: ${String(error)}`)
    }
    const session: TerminalSession = { proc, exited: false, seq: 0, frames: [], buffered: 0 }
    proc.onData((data) => {
      // 统一事件中心：pty 输出实时推给 renderer（client $on 直收，唯一路径）。
      // 帧带单调 seq + 进环形缓冲——renderer 发现 seq 跳号（断链窗口丢帧）时经
      // snapshot(id, lastSeq) 补拉，见 docs/fork-delta.md 事件总线「断链补帧」。
      session.seq += 1
      session.frames.push({ seq: session.seq, data })
      session.buffered += data.length
      while (session.buffered > TERMINAL_BUFFER_LIMIT && session.frames.length > 1) {
        const dropped = session.frames.shift()
        session.buffered -= dropped?.data.length ?? 0
      }
      this.ctx.emit('corum/terminal/output', { id, data, seq: session.seq })
    })
    proc.onExit(({ exitCode }) => {
      session.exited = true
      session.exitCode = exitCode
    })
    this.sessions.set(id, session)
    return { id }
  }

  /**
   * 向会话写输入（xterm onData 的键盘/粘贴数据原样透传）。
   * @param id - create 返回的会话 id。
   * @param data - 要写入 pty 的数据（含控制序列，如 \r 回车、ANSI）。
   */
  @Remote('write')
  async write(id: string, data: string): Promise<{ written: boolean }> {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`unknown terminal session: ${id}`)
    session.proc.write(data)
    return { written: true }
  }

  /**
   * 调整会话窗口尺寸（xterm FitAddon.fit() 后同步给 pty，让 shell 的
   * readline/全屏程序按真实行列排版）。
   * @param id - 会话 id。
   * @param cols - 列数。
   * @param rows - 行数。
   */
  @Remote('resize')
  async resize(id: string, cols: number, rows: number): Promise<{ resized: boolean }> {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`unknown terminal session: ${id}`)
    // pty.resize 对非法尺寸（0/负）抛错；钳到最小 1。
    session.proc.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)))
    return { resized: true }
  }

  /**
   * 终止会话（client unmount / 关闭区域 / 手动 kill）。幂等：id 不存在不
   * 报错（关闭路径可能重复触发）。
   * @param id - 会话 id。
   */
  @Remote('kill')
  async kill(id: string): Promise<{ killed: boolean }> {
    const session = this.sessions.get(id)
    if (session === undefined) return { killed: false }
    this.sessions.delete(id)
    try {
      session.proc.kill()
    } catch {
      // pty 已死亡（子进程先退出）时 kill 抛错——幂等语义下吞掉。
    }
    return { killed: true }
  }

  /**
   * 断链补帧：取某会话在 afterSeq 之后的缓冲输出（含当前缓冲内全部帧）。
   * renderer 收到 seq 跳号的帧时调用（或重连后主动调一次），把断链窗口里错过的
   * 输出补写进 xterm；`truncated=true` 表示缺失部分已超出缓冲上限（只能接受空洞）。
   * @param id - create 返回的会话 id。
   * @param afterSeq - 已知的最新帧序号（省略 = 取全部缓冲）。
   */
  @Remote('snapshot')
  snapshot(id: string, afterSeq?: number): { seq: number; data: string; truncated: boolean } {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`unknown terminal session: ${id}`)
    const from = afterSeq ?? 0
    const frames = session.frames.filter(frame => frame.seq > from)
    const oldest = session.frames[0]?.seq
    return {
      seq: session.seq,
      data: frames.map(frame => frame.data).join(''),
      // 缓冲里最旧的帧已晚于「已知序号 + 1」→ 中间有一段永久丢失。
      truncated: oldest !== undefined && oldest > from + 1,
    }
  }
}
