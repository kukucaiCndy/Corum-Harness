/**
 * GitPanelButton —— 输入框工具栏的 git 按钮（`conversation.input.left` 槽）。
 *
 * ## 职责只有「开/关」
 *
 * 面板本体在 `conversation.input.dock` 槽（`GitPanelDock`）——与「文件更改」
 * 「TODO LIST」「排队条」同款：吸附在输入框上方的玻璃卡。按钮这边只留一个
 * 26×26 图标，点击切换该会话的面板开关。
 *
 * 早先面板是按钮旁的 `position: absolute` 浮窗：在窄窗 / 输入框贴底时会被
 * composer 的 overflow 裁掉，宽度也与相邻卡片对不齐。拆开后几何由槽位系统保证。
 *
 * 三态在面板里（空闲可操作 / 提交后结果+注入预览 / Agent 工作中全置灰）。
 *
 * ## 开关状态来自 cordis 服务
 *
 * 按钮与面板在不同槽、由不同 bundle 组装；dsh 把 `@corum/*` 源码内联进每个消费方
 * bundle，模块级变量在两个 bundle 里是**两份独立实例**（红线 1）。故开关状态走
 * `GitPanelOpenService`，其唯一性由根上下文的 `reflect.store` 保证。
 */
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GitPanelOpenState } from './panel-open.ts'
import { GitBranch } from 'lucide-react'
import styles from './GitPanel.module.css'

/**
 * 创建 GitPanelButton 组件。
 *
 * `openState` **必须**来自槽注册的 `inject` 面（渲染时取服务实例），不能用工厂
 * 闭包捕获——两个槽由不同 bundle 组装，闭包里那份与 renderer 挂载时的实例不是
 * 同一个（实测闭包拿到 undefined ⇒ `reading '#listeners'` 崩溃）。
 */
export function createGitPanelButton() {
  return function GitPanelButton({ sessionId, openState }: { sessionId?: SessionId; openState: GitPanelOpenState }) {
    const key = sessionId === undefined ? undefined : String(sessionId)
    const open = useSyncExternalStore(
      openState.subscribe,
      () => (key === undefined ? false : openState.isOpen(key)),
    )

    if (key === undefined) return null

    return (
      <button
        type="button"
        className={styles.gitBtn}
        aria-label="版本控制"
        aria-expanded={open}
        onMouseDown={e => e.preventDefault()}
        onClick={() => openState.toggle(key)}
      >
        <GitBranch size={19} />
      </button>
    )
  }
}
