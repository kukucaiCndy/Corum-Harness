/** 项目身份用于编辑现场和 Monaco model，Windows 路径不区分大小写。 */
export function projectKey(root: string): string {
  const path = root.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return /^[a-z]:/i.test(path) || path.startsWith('//') ? path.toLowerCase() : path
}

export interface WorkspaceSnapshot {
  root: string | null
  rootName: string | null
  status: 'empty' | 'loading' | 'ready' | 'error'
  error?: string
}

export interface WorkspaceSource {
  get(): WorkspaceSnapshot
  subscribe(listener: () => void): () => void
  select(root: string | null, force?: boolean): void
  whenReady(): Promise<void>
}

/** setRoot 必须串行：较早的慢请求不能在用户切换后把 host 根目录改回去。 */
export function createWorkspaceSource(
  setRoot: (root: string) => Promise<{ ok: boolean; error?: { message?: string } }>,
): WorkspaceSource {
  let snapshot: WorkspaceSnapshot = { root: null, rootName: null, status: 'empty' }
  let revision = 0
  let pending = Promise.resolve()
  const listeners = new Set<() => void>()
  const publish = (next: WorkspaceSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  return {
    get: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    select: (root, force = false) => {
      if (!force && (root === null ? snapshot.root === null : snapshot.root !== null && projectKey(root) === projectKey(snapshot.root))
        && snapshot.status !== 'error') return
      const current = ++revision
      const next = { root, rootName: root?.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? null }
      if (root === null) { publish({ ...next, status: 'empty' }); return }
      publish({ ...next, status: 'loading' })
      pending = pending.then(async () => {
        if (current !== revision) return
        try {
          const result = await setRoot(root)
          if (!result.ok) throw new Error(result.error?.message ?? '无法切换项目')
          if (current === revision) publish({ ...next, status: 'ready' })
        } catch (error) {
          if (current === revision) publish({ ...next, status: 'error', error: String(error instanceof Error ? error.message : error) })
        }
      })
    },
    whenReady: async () => {
      const task = pending
      await task
      if (task !== pending) throw new Error('项目已切换，请重新打开文件')
      if (snapshot.status !== 'ready') throw new Error(snapshot.error ?? '当前没有就绪的项目')
    },
  }
}
