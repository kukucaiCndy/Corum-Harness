/**
 * acl-elevation —— ACL 提权引导的可观察状态（同包 apply() → AppFrame 的最简机制）。
 *
 * 非跨 bundle 状态——只活在本壳 bundle 内（apply 订阅事件写、AppFrame 读），
 * 故不需要 cordis 服务（红线 1 针对的是跨 bundle 共享状态）。与 floatingApiSingleton
 * 同款：模块级单例 + listener 集合，inject 面经 hooks 把 getSnapshot/subscribe
 * 交给 AppFrame 的 useSyncExternalStore。
 *
 * @module corum-ide-ui/client/acl-elevation
 */

/** ACL 提权事件载荷的窄化（corum/acl/elevation-required 的 data 字段）。 */
export interface AclElevationState {
  /** 工作区根目录（传给 RPC fixWorkspaceAclElevated 的 workspaceRoot）。 */
  readonly workspaceRoot: string
  /** 用户可读文案（issue #246：按失败原因分叉，不再是笼统的「需要管理员权限」）。 */
  readonly message: string
  /** 手工修复命令文本（UAC 拒绝/取消时的兜底引导，可复制）。 */
  readonly manualCommands: string
}

let aclElevation: AclElevationState | null = null
const listeners = new Set<() => void>()

/** 写入事件载荷（apply 的 $on 回调调）。 */
export function setAclElevation(state: AclElevationState): void {
  aclElevation = state
  for (const fn of listeners) fn()
}

/** 清除 state（AppFrame dialog onClose 调 / effect dispose 调）。 */
export function clearAclElevation(): void {
  if (aclElevation === null) return
  aclElevation = null
  for (const fn of listeners) fn()
}

/** uSES 快照（inject hooks.aclElevation 的 getSnapshot 用）。 */
export function getAclElevationSnapshot(): AclElevationState | null {
  return aclElevation
}

/** uSES 订阅（inject hooks.aclElevation 的 subscribe 用）。 */
export function subscribeAclElevation(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
