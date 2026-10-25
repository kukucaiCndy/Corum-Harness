import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { GlassButton } from '../shared.tsx'
import { createDefaultDirectoryController, type DefaultDirectoryApi, type DefaultDirectoryStatus } from './default-session-directory-controller.ts'
import css from './DefaultSessionDirectoryGroup.module.css'
import { DefaultDirectoryNoticeContext } from '../default-directory-resume.ts'

function desktopDirectoryApi(): DefaultDirectoryApi | null {
  const api = (window as unknown as { corumDesktop?: Partial<DefaultDirectoryApi> }).corumDesktop
  return api?.getDefaultSessionDirectory && api.pickDefaultSessionDirectory && api.migrateDefaultSessionDirectory && api.reloadDefaultSessionDirectory ? api as DefaultDirectoryApi : null
}

const phases: Record<string, string> = { files: '复制并校验文件', metadata: '更新会话路径', commit: '切换默认位置', cleanup: '清理原目录' }
function progress(status: DefaultDirectoryStatus | null): string {
  if (status?.error) return status.error
  if (!status?.migration) return '正在重启会话服务，请稍候…'
  const { phase, completed, total } = status.migration
  return `${phases[phase] ?? '正在迁移'} · ${completed} / ${total}`
}

function DirectoryControls({ api, hasUnsavedChanges }: { api: DefaultDirectoryApi; hasUnsavedChanges: () => boolean }) {
  const notice = useContext(DefaultDirectoryNoticeContext)
  const [controller] = useState(() => createDefaultDirectoryController(api, hasUnsavedChanges))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const overlay = useRef<HTMLDivElement>(null)
  useEffect(() => { void controller.load() }, [controller])
  useEffect(() => {
    if (!state.busy) return
    // IPC 的迁移 Promise 负责判断 ready；离线期间仍可读取持久进度。
    const timer = setInterval(() => { void controller.load() }, 800)
    const block = (event: KeyboardEvent): void => { event.preventDefault(); event.stopImmediatePropagation() }
    document.addEventListener('keydown', block, true)
    overlay.current?.focus()
    return () => { clearInterval(timer); document.removeEventListener('keydown', block, true) }
  }, [controller, state.busy])
  const { status, target } = state
  return <>
    <SettingRow label="当前位置" divider={target !== null}>
      <span className={css.path}>{status?.root ?? '加载中…'}</span>
      <GlassButton disabled={!status || state.busy || state.picking} onClick={() => { void controller.pick() }}>更改并迁移</GlassButton>
    </SettingRow>
    {target !== null && <>
      <SettingRow label="迁移到" desc={`将迁移 ${status?.sessionCount ?? 0} 个会话的目录，并短暂重启会话服务。`} divider={false}>
        <span className={css.path}>{target}</span>
      </SettingRow>
      <div className={css.actions}>
        <GlassButton disabled={state.busy} onClick={controller.cancel}>取消</GlassButton>
        <GlassButton variant="primary" disabled={state.busy || state.picking} onClick={() => { void controller.migrate() }}>迁移并重启</GlassButton>
      </div>
    </>}
    {(state.error || status?.error) && <p className={css.message} role="alert">{state.error || status?.error}</p>}
    {status && !state.error && !status.error && !status.warning && notice && <p className={css.message} role="status">{notice === 'migrated' ? '默认会话目录迁移完成。' : '迁移未完成，请检查当前位置。'}</p>}
    {status?.warning && <p className={css.message} role="status">{status.warning}</p>}
    {state.busy && createPortal(
      <div className={css.overlay} role="dialog" aria-modal="true" aria-label="正在迁移默认会话目录" tabIndex={-1} ref={overlay} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
        <div className={css.progress}>
          <strong>正在迁移默认会话目录</strong>
          <p role="status" aria-live="polite">{state.error || progress(status)}</p>
        </div>
      </div>, document.body,
    )}
  </>
}

export function DefaultSessionDirectoryGroup({ hasUnsavedChanges }: { hasUnsavedChanges: () => boolean }) {
  const api = desktopDirectoryApi()
  return <SettingGroup title="默认会话目录">
    {api ? <DirectoryControls api={api} hasUnsavedChanges={hasUnsavedChanges} /> : <SettingRow label="当前环境不支持更改默认会话目录" divider={false} />}
  </SettingGroup>
}
