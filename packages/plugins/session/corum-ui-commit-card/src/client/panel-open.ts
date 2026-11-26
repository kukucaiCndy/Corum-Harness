/**
 * Git 面板的**开关状态**（跨槽共享的单例）。
 *
 * ## 为什么必须是 cordis 服务
 *
 * 面板被拆成两个槽的两个组件：
 *   · 输入框工具栏的 git 按钮（`conversation.input.left`）——只负责开/关；
 *   · composer 上方的玻璃面板（`conversation.input.dock`）——只负责渲染。
 *
 * 两者在不同槽、由不同的 bundle 组装。dsh 会把 `@corum/*` 源码内联进每个消费方
 * bundle，故**模块级变量在两个 bundle 里是两份独立实例**（红线 1 的
 * `__corumSidebarMode` 事故就是这个形态）：按钮写的那份，面板永远读不到。
 * cordis 服务实例的唯一性由根上下文的 `reflect.store` 保证，天然跨 bundle 单例，
 * 所以状态必须放这里。
 *
 * ## 为什么不用 window 全局
 *
 * 红线 1 明文禁止：窗口挂载只能用于「写一次、只读」的桥接（`window.corumDesktop` 等），
 * 共享可变状态一律走 cordis 服务。
 *
 * ## 粒度选择
 *
 * 按**会话**存开关：面板内容是「该工作区的分支与改动」，一个会话一个面板。
 * 用户在某会话里打开面板、切到另一个会话，不该看到别人的面板也开着。
 */

/** 面板开关状态的只读快照面（按钮与面板都只用这一面 + 订阅）。 */
export interface GitPanelOpenState {
  /** 某会话的面板是否展开。 */
  isOpen(sessionId: string): boolean
  /** 订阅变化（`useSyncExternalStore` 的 subscribe 契约：返回退订函数）。 */
  subscribe(listener: () => void): () => void
  /** 取快照（`useSyncExternalStore` 的 getSnapshot 契约；同一状态必须返回同一值）。 */
  getSnapshot(): ReadonlySet<string>
  /** 设置某会话的开/关。 */
  setOpen(sessionId: string, open: boolean): void
  /** 切换某会话的开关。 */
  toggle(sessionId: string): void
}

/**
 * 开关状态的实现：一个会话 id 集合 + 变更通知。
 *
 * 用不可变 Set 做快照（每次变更换新引用），这样 `useSyncExternalStore` 的相等判据
 * 天然成立——直接改同一个 Set 会让 React 认为「没变化」而不重渲染。
 */
export class GitPanelOpenService implements GitPanelOpenState {
  #open: ReadonlySet<string> = new Set()
  readonly #listeners = new Set<() => void>()

  /**
   * @param sessionId - 会话 id。
   *
   * ⚠️ 读快照的三个成员必须是**实例级箭头函数**：它们会以裸回调的形式传给
   * `useSyncExternalStore(openState.subscribe, openState.getSnapshot)`，原型的
   * 普通方法一旦脱离实例调用 `this` 就是 undefined，私有字段 `#listeners`
   * 随即抛 `Cannot read properties of undefined (reading '#listeners')`
   * ——真机实测过，这不是理论风险。
   */
  isOpen = (sessionId: string): boolean => this.#open.has(sessionId)

  /** @param listener - 状态变化回调。 */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** @returns 当前打开着的会话 id 快照。 */
  getSnapshot = (): ReadonlySet<string> => this.#open

  /**
   * @param sessionId - 会话 id。
   * @param open - 是否展开。
   */
  setOpen(sessionId: string, open: boolean): void {
    if (this.#open.has(sessionId) === open) return
    const next = new Set(this.#open)
    if (open) next.add(sessionId)
    else next.delete(sessionId)
    this.#open = next
    for (const listener of this.#listeners) listener()
  }

  /** @param sessionId - 会话 id。 */
  toggle(sessionId: string): void {
    this.setOpen(sessionId, !this.#open.has(sessionId))
  }
}
