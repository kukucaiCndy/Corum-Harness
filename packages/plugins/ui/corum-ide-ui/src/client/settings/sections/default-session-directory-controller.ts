export interface DefaultDirectoryStatus {
  root: string
  sessionCount: number
  migration: null | { phase: string; completed: number; total: number }
  error?: string
  warning?: string
}
export interface DefaultDirectoryApi {
  getDefaultSessionDirectory(): Promise<DefaultDirectoryStatus>
  pickDefaultSessionDirectory(): Promise<string | null>
  migrateDefaultSessionDirectory(path: string): Promise<DefaultDirectoryStatus>
  reloadDefaultSessionDirectory(options?: { notice: 'migrated' | 'restored' }): Promise<void>
}
export function createDefaultDirectoryController(api: DefaultDirectoryApi, hasUnsavedChanges: () => boolean) {
  let state = { status: null as DefaultDirectoryStatus | null, target: null as string | null, busy: false, picking: false, error: '' }
  const listeners = new Set<() => void>()
  const update = (patch: Partial<typeof state>): void => {
    state = { ...state, ...patch }
    listeners.forEach(listener => listener())
  }
  const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    load: async () => {
      try { update({ status: await api.getDefaultSessionDirectory() }) }
      catch (error) { update({ error: message(error) }) }
    },
    pick: async () => {
      if (state.busy || state.picking) return
      update({ picking: true, error: '' })
      try {
        const target = await api.pickDefaultSessionDirectory()
        if (target !== null) update({ target: target === state.status?.root ? null : target })
      } catch (error) { update({ error: message(error) }) }
      finally { update({ picking: false }) }
    },
    cancel: () => { if (!state.busy) update({ target: null, error: '' }) },
    migrate: async () => {
      if (state.busy || state.picking || !state.target) return
      try {
        if (hasUnsavedChanges()) { update({ error: '请先保存编辑器中所有未保存的文件，再迁移默认会话目录。' }); return }
      } catch (error) { update({ error: message(error) }); return }
      update({ busy: true, error: '' })
      let status: DefaultDirectoryStatus
      try { status = await api.migrateDefaultSessionDirectory(state.target!) }
      catch (error) { update({ busy: false, error: message(error) }); return }
      update({ status, target: null })
      // resolve 保证新宿主 ready，失败回退结果同样必须重新加载旧关联。
      try { await api.reloadDefaultSessionDirectory({ notice: status.error ? 'restored' : 'migrated' }) }
      catch (error) { update({ error: message(error) }) }
    },
  }
}
