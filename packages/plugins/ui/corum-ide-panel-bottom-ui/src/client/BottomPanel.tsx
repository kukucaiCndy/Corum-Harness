/**
 * BottomPanel — the IDE terminal region (design.pen ⑥, 浅 xGd58 / 深 mOtXy).
 * A normal grid leaf like every other region — resizable and freely composable
 * with the rest, no special floating/fixed semantics. Structure follows the
 * design frame: tabs (bU2zf: pt-终端 active glass-2 + active-border r10
 * pad[6,12] + spacer + × close) → term (JYZCL: 真实 xterm.js 终端，JetBrains
 * Mono，经 host corumTerminal RPC 驱动 node-pty 登录 shell)。
 * The × close hides this leaf via `ctx.layout.closeRegion`.
 *
 * 真实终端接线（统一事件中心一期，2026-09 迁移）：
 *   - onMount：`create` 拿会话 id → **`onTerminalOutput`（ctx.remote.$on
 *     'corum/terminal/output'）实时推送** `term.write(data)` → xterm `onData`
 *     调 `write` 透传输入 → ResizeObserver 触发 FitAddon.fit() + `resize`
 *     同步行列 → unmount / 关闭区域时 `kill` + dispose $on 订阅。
 *   - 三期（2026-09）：60ms poll 降级兜底已删——host 与 renderer 同一构建
 *     产物、同生同死，「host 旧版不 emit」永不发生（审计
 *     .dbg/event-bus-audit-2026-09.md P1-1；一期 CDP 实测 pollStarts=0）。
 *     终端输出完全走 $on 推送，观测面 window.__corumEventStats。
 */
import { useEffect, useRef } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import css from './BottomPanel.module.css'

/** RPC 信封（host Typert Remote：成功 `{ok:true,value}` / 失败 `{ok:false,error}`）。 */
interface RpcEnvelope<T> {
  ok: boolean
  value?: T
  error?: { message?: string }
}

/** 本插件的注入面（见 client/index.ts apply：connection.rpc.call 封装 + closeRegion）。 */
export interface BottomPanelInjected {
  /** 关闭本区域（隐藏叶子，可在插件中心「视图管理」恢复）。 */
  closeRegion: () => void
  /** spawn 登录 shell 会话（host node-pty；cwd 缺省 host 进程 cwd = 项目根）。 */
  create: () => Promise<RpcEnvelope<{ id: string }>>
  /** 向会话写输入（xterm onData 原样透传）。 */
  writeTerm: (id: string, data: string) => Promise<RpcEnvelope<{ written: boolean }>>
  /** 同步窗口尺寸（FitAddon.fit() 后）。 */
  resizeTerm: (id: string, cols: number, rows: number) => Promise<RpcEnvelope<{ resized: boolean }>>
  /** 终止会话（幂等）。 */
  kill: (id: string) => Promise<RpcEnvelope<{ killed: boolean }>>
  /**
   * 断链补帧：取会话在 afterSeq 之后的缓冲输出（host 环形缓冲 256KB）。
   * 收到 seq 跳号的帧时调用，把断链窗口错过的输出补写进 xterm。
   */
  snapshot: (id: string, afterSeq?: number) => Promise<RpcEnvelope<{ seq: number; data: string; truncated: boolean }>>
  /**
   * 订阅终端输出推送（统一事件中心主路径：ctx.remote.$on
   * 'corum/terminal/output'）。listener 收到 { id, data, seq } 帧；返回 dispose
   * （组件 unmount 时调用）。
   */
  onTerminalOutput: (listener: (frame: { id: string; data: string; seq: number }) => void) => () => void
  /**
   * 终端字面真源（PRD §4.2 乙类）：fontPrefs cordis 服务的终端分组子面。
   * 缺省（服务未 provide）时组件回落现状硬编码值，不构成破坏。
   */
  fontPrefs?: {
    getTerminal: () => { fontSize: number; fontFamily: string }
    subscribe: (listener: () => void) => () => void
  } | undefined
}

/** Composed props: the shell's owner share + 本插件注入面。 */
export type BottomPanelProps = PropsRuntime<'corum.panel'> & BottomPanelInjected

/** The IDE terminal panel (real xterm.js driven by host node-pty; see module doc). */
export function BottomPanel({ closeRegion, create, writeTerm, resizeTerm, kill, onTerminalOutput, snapshot, fontPrefs }: BottomPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return

    // 终端字面真源（fontPrefs cordis 服务，跨 bundle 单例）；缺省回落现状硬编码。
    const initialFont = fontPrefs?.getTerminal()

    // xterm 主题色解析：xterm 的 toColor **只接受 #hex 与 rgba()** 两种 CSS 色
    // 字符串——`var(--token)` 走 canvas fillStyle 回落分支，离屏 canvas 解析不
    // 了 var() ⇒ 抛 "Unsupported css format" ⇒ xterm 吞错回落**默认前景 #ffffff
    // （白）**。在透明背景下白色前景贴在浅色卡上 ⇒ 白底白字不可见（白色主题
    // 终端内容看不见的真因）。修法：用 getComputedStyle(document.body) 把设计
    // token 解析成具体色值（xterm 能吃），并随主题切换重解析重应用。
    const resolveToken = (token: string, fallback: string): string => {
      const v = getComputedStyle(document.body).getPropertyValue(token).trim()
      return v !== '' ? v : fallback
    }
    const buildTheme = () => ({
      background: '#00000000',
      foreground: resolveToken('--dsw-alias-label-primary', '#d4d4d4'),
      cursor: resolveToken('--dsw-alias-brand-text', '#d4d4d4'),
      cursorAccent: '#00000000',
      selectionBackground: resolveToken('--corum-glass-3', 'rgba(128,128,128,0.35)'),
    })

    const term = new Terminal({
      fontFamily: initialFont?.fontFamily ?? "'JetBrains Mono', 'SFMono-Regular', 'Menlo', monospace",
      fontSize: initialFont?.fontSize ?? 13,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 2000,
      allowProposedApi: true,
      theme: buildTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)

    // 主题随动：ThemePresenter 切主题时在 body 上加/去 data-ds-dark-theme
    // 属性（见 corum-ui-base theme-presenter.ts:54）并重写 alias token。监听
    // body 属性变化 → 重解析 token → xterm updateOptions theme。
    const themeObserver = new MutationObserver(() => {
      term.options.theme = buildTheme()
    })
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] })

    // 终端字面实时生效（PRD §4.2 乙类）：fontSize/fontFamily 对 xterm updateOptions
    // 有效。订阅 cordis 服务，设置页写入即实时反映到已打开的终端。
    const disposeFontPrefs = fontPrefs?.subscribe(() => {
      const next = fontPrefs.getTerminal()
      term.options.fontSize = next.fontSize
      term.options.fontFamily = next.fontFamily
    })

    // 会话 id 与 $on 订阅 dispose（create 成功后填充）。
    let sessionId: string | null = null
    /** 断链补帧：本会话已知的最新输出帧序号。 */
    let lastSeq: number | null = null
    let disposeOutput: (() => void) | null = null
    let disposed = false
    // 未 attach 前的 kill 防护：unmount 若抢在 create resolve 前，记录后补杀。
    let killRequested = false

    // 输入透传：xterm onData（键盘/粘贴/控制序列）→ host pty。
    const dataSub = term.onData((data) => {
      if (sessionId === null) return
      void writeTerm(sessionId, data).catch(() => {})
    })

    // 尺寸同步：FitAddon.fit() 量出真实行列 → 同步给 host pty。
    const applyFit = (): void => {
      try {
        fit.fit()
      } catch {
        return // 容器尚未布局（display:none / 0 尺寸）时 fit 抛错，跳过本轮。
      }
      if (sessionId !== null) {
        void resizeTerm(sessionId, term.cols, term.rows).catch(() => {})
      }
    }
    // 容器尺寸变化（拖拽调整 grid 叶子）→ 重排。
    const resizeObserver = new ResizeObserver(() => { applyFit() })
    resizeObserver.observe(container)

    // 初次布局（open 后下一帧，容器已有真实尺寸）。
    applyFit()

    // 建会话 → 拿 id → 挂 $on 推送订阅（统一事件中心唯一路径；三期删 poll 兜底）。
    // 此时再把当前行列补同步一次（create 默认 80×24）。
    void create().then((res) => {
      if (disposed || killRequested) {
        // unmount 抢在 create resolve 前：补杀刚建好的会话防泄漏。
        if (res.ok && res.value !== undefined) void kill(res.value.id).catch(() => {})
        return
      }
      if (!res.ok || res.value === undefined) {
        term.write(`\x1b[31m[终端启动失败: ${res.error?.message ?? 'unknown error'}]\x1b[0m\r\n`)
        return
      }
      sessionId = res.value.id
      // 断链补帧：已知的最新帧序号（null = 尚未收到任何帧）。
      lastSeq = null
      // 统一事件中心：host proc.onData → ctx.emit → forwarded Remote
      // event → 本 listener。多终端面板并存时按帧 id 过滤本会话。
      // 断链补帧：帧 seq 跳号（连接闪断窗口丢帧）→ 先补拉缓冲再写，避免空洞。
      disposeOutput = onTerminalOutput(({ id, data, seq }) => {
        if (disposed || id !== sessionId) return
        if (lastSeq !== null && seq > lastSeq + 1) {
          void snapshot(sessionId, lastSeq).then((res) => {
            if (disposed || !res.ok || res.value === undefined) return
            term.write(res.value.data)
            lastSeq = res.value.seq
          }).catch(() => { /* 补帧失败不阻塞实时输出 */ })
          return
        }
        term.write(data)
        lastSeq = seq
      })
      applyFit()
    }).catch((error) => {
      if (!disposed) term.write(`\x1b[31m[终端启动失败: ${String(error)}]\x1b[0m\r\n`)
    })

    return () => {
      disposed = true
      disposeOutput?.()
      disposeFontPrefs?.()
      themeObserver.disconnect()
      resizeObserver.disconnect()
      dataSub.dispose()
      if (sessionId !== null) {
        void kill(sessionId).catch(() => {})
      } else {
        killRequested = true
      }
      term.dispose()
    }
    // 注入面方法在 plugin 生命周期内稳定（index.ts apply 闭包），只需挂一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={css.panel}>
      <div className={css.tabs}>
        <span className={css.tabActive}>终端</span>
        <span className={css.spacer} />
        {/* × 关闭：终端已纳入网格，隐藏本叶子（可在插件中心「视图管理」恢复）。 */}
        <button
          type="button"
          className={css.close}
          title="关闭此区域（可在插件中心「视图管理」恢复）"
          onClick={closeRegion}
        >
          <X size={17} strokeWidth={2} />
        </button>
      </div>
      {/* xterm 挂载点：填满 .term 区域（CSS 里 flex:1 + 内边距由 xterm 自带）。 */}
      <div className={css.term} ref={containerRef} />
    </div>
  )
}
