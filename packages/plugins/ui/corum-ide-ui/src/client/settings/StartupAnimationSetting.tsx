import { useEffect, useState } from 'react'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { SettingGroup } from './SettingGroup.tsx'
import { SettingRow } from './SettingRow.tsx'
import { Switch } from './Switch.tsx'
import css from './StartupAnimationSetting.module.css'

interface StartupThemeInfo {
  id: string; name: string; version: string; type: 'html' | 'video'; builtin: boolean
  author?: string; previewUrl?: string
  /** Present on segmented video themes: one clip per boot stage. */
  segments?: { stage: string; file: string }[]
}
interface StartupThemeCatalog { themes: StartupThemeInfo[]; selectedId: string }

interface StartupBridge {
  getStartupAnimationEnabled: () => Promise<boolean>
  setStartupAnimationEnabled: (enabled: boolean) => Promise<boolean>
  listStartupThemes: () => Promise<StartupThemeCatalog>
  importStartupTheme: () => Promise<{ cancelled: boolean }>
  selectStartupTheme: (id: string) => Promise<void>
  deleteStartupTheme: (id: string, options?: { confirmed?: boolean }) => Promise<{ cancelled: boolean }>
  previewStartupTheme: (id: string) => Promise<void>
}

/**
 * One-line description of a theme.
 *
 * Segmented themes get called out explicitly: they look like plain "视频" in the
 * catalog otherwise, and the fact that the animation changes per boot stage is the
 * whole point of picking one.
 */
function describeTheme(theme: StartupThemeInfo): string {
  const kind = theme.type === 'html'
    ? 'HTML 动画'
    : theme.segments && theme.segments.length > 0
      ? `分段视频（${theme.segments.length} 段）`
      : '视频'
  return [kind, `v${theme.version}`, theme.builtin ? '内置' : '', theme.author ?? ''].filter(Boolean).join(' · ')
}

/** 桌面启动偏好由 Electron 壳持久化，网页模式不显示此设置。 */
export function StartupAnimationSetting() {
  const desktop = typeof window === 'undefined' ? undefined
    : (window as unknown as { corumDesktop?: Partial<StartupBridge> }).corumDesktop
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [catalog, setCatalog] = useState<StartupThemeCatalog | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * 待确认删除的主题（`null` = 不弹确认框）。
   *
   * 为什么必须过确认框（2026-11-07 修的真实缺口，期望 §3 K7）：
   * 此前删除按钮**直接** `deleteStartupTheme(id)` —— 点一下就没了、无确认、不可撤销；
   * 且若删的正是当前选中主题，下一次启动会静默回退内置，用户事先毫不知情。
   */
  const [pendingDelete, setPendingDelete] = useState<StartupThemeInfo | null>(null)
  useEffect(() => {
    let active = true
    desktop?.getStartupAnimationEnabled?.().then(value => { if (active) setEnabled(value) })
      .catch(err => { if (active) setError(String(err)) })
    desktop?.listStartupThemes?.().then(value => { if (active) setCatalog(value) })
      .catch(err => { if (active) setError(String(err)) })
    return () => { active = false }
  }, [desktop])
  if (desktop?.getStartupAnimationEnabled === undefined || desktop.setStartupAnimationEnabled === undefined) return null

  const save = async (value: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const saved = await desktop.setStartupAnimationEnabled!(value)
      setEnabled(saved)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }
  const run = async (action: () => Promise<unknown>, refresh = true): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      if (refresh) setCatalog(await desktop.listStartupThemes!())
    } catch (err) { setError(String(err)) }
    finally { setBusy(false) }
  }
  return (
    <SettingGroup title="启动">
      <SettingRow label="启动动画" desc="启动时播放所选动画或视频。修改后自动保存，下次启动生效；关闭后仍显示必要的加载状态。">
        <Switch label="启动动画" checked={enabled === true} disabled={enabled === null || busy} onChange={value => { void save(value) }} />
      </SettingRow>
      {desktop.listStartupThemes && <>
        <SettingRow label="启动主题" desc="播放结束且主界面就绪后进入，随时可按 Esc 跳过。主题选择在下次启动生效。">
          <button className={css.button} disabled={busy || !catalog} onClick={() => { void run(() => desktop.importStartupTheme!()) }}>导入主题</button>
        </SettingRow>
        {catalog && <ul className={css.list} aria-label="已安装的启动主题">
          {catalog.themes.map(theme => <li className={css.theme} key={theme.id}>
            {theme.previewUrl && <img className={css.preview} src={theme.previewUrl} alt="" />}
            <div className={css.meta}>
              <strong>{theme.name}</strong>
              <span className={css.detail}>{describeTheme(theme)}</span>
            </div>
            <div className={css.actions}>
              <button className={css.button} aria-label={`预览 ${theme.name}`} disabled={busy} onClick={() => { void run(() => desktop.previewStartupTheme!(theme.id), false) }}>预览</button>
              <button className={css.button} aria-label={`使用 ${theme.name}`} aria-pressed={catalog.selectedId === theme.id} disabled={busy || catalog.selectedId === theme.id} onClick={() => { void run(() => desktop.selectStartupTheme!(theme.id)) }}>{catalog.selectedId === theme.id ? '已使用' : '使用'}</button>
              {/* 非内置主题才有删除入口；点击**只弹确认框**，确认后才真删（内置主题在 UI 无入口，
                  且 host `deleteStartupTheme` 对内置 id 直接抛「内置主题不能删除」）。 */}
              {!theme.builtin && <button className={css.button} aria-label={`删除 ${theme.name}`} disabled={busy} onClick={() => { setPendingDelete(theme) }}>删除</button>}
            </div>
          </li>)}
        </ul>}
      </>}
      {error !== null && <p role="alert">{error}</p>}
      {pendingDelete !== null && (
        <ConfirmDialog
          title="删除启动主题"
          message={`删除主题「${pendingDelete.name}」？`}
          warning={catalog !== null && catalog.selectedId === pendingDelete.id
            // 选中态必须提前说清后果：删除后下次启动会回退内置（而不是留一个空启动页）
            ? '该主题**正被选中**：删除后下次启动会回退到内置主题，当前选择也随之改变。'
            : undefined}
          tone="danger"
          confirmLabel="删除"
          cancelLabel="取消"
          busy={busy}
          onCancel={() => { setPendingDelete(null) }}
          onConfirm={() => {
            const target = pendingDelete
            setPendingDelete(null)
            // `confirmed:true` = 应用内确认已发生（上面那个 ConfirmDialog），
            // 让主进程跳过原生确认框 —— 否则会连续弹两次确认，且原生框无法被自动化点掉。
            void run(() => desktop.deleteStartupTheme!(target.id, { confirmed: true }))
          }}
        />
      )}
    </SettingGroup>
  )
}
