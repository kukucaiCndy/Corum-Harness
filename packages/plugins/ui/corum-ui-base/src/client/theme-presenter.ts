/**
 * Global theme DOM applier: projects the resolved ThemeSnapshot onto the
 * document — `html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]`
 * for the token palette, the active theme's alias-token overrides as inline CSS
 * variables on body, the content font-size axis (`--dsh-content-font-size`), and
 * one presenter-owned `meta[name="theme-color"]`. Pure DOM writes, no React
 * involvement. This is a fork of ui-layout's presenter: a corum shell owns the
 * same projection duty (the official ui-layout is disabled, so nothing else
 * writes the body palette attribute).
 *
 * ## 正文字号轴（2026-09-16 补上，修「运行时断链」）
 *
 * 官方把 `--dsh-content-font-size` 的写入职责放在 **ui-layout 的 ThemePresenter** 里
 * （`ui-layout/src/client/theme-presenter.ts:47`）。corum 禁用了 ui-layout，
 * 而本 fork 起初**只投影了调色板、漏了这条轴** ⇒ 于是出现：
 * - `boot-theme.ts` 在**加载时**写入一次（值 = 当时的设置），所以变量**存在**；
 * - 但**运行时更新无人负责** ⇒ 用户改「会话正文字号」后变量纹丝不动，
 *   **改了等于没改**（真机实测：设 17 后变量仍为 14px）。
 *
 * 这正是 PRD §4.3.1 记的「⚠️ 运行时断链，需修」。现按官方语义补上写入，
 * 并把该变量纳入 `dispose()` 的撤回集（与官方一致：presenter 只撤回自己写的东西）。
 */
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

/** Body attribute selecting the dark base palette in the token stylesheets. */
export const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/**
 * Body variable carrying the user's content font size in px.
 *
 * ⚠️ 必须与官方 `ui-layout/src/client/theme-presenter.ts` 的
 * `CONTENT_FONT_SIZE_VARIABLE` 保持**同名**，否则消费端（corum-ui-chat /
 * corum-ui-conversation 等大量 CSS 里的 `var(--dsh-content-font-size, 14px)`）
 * 解析不到。
 */
export const CONTENT_FONT_SIZE_VARIABLE = '--dsh-content-font-size'

/** Applies theme snapshots to the document; one instance per plugin fiber. */
export class ThemePresenter {
  /** Token names this presenter wrote in the last apply (its retraction set). */
  private appliedTokens: string[] = []
  /** The single metadata node this presenter inserts and removes. */
  private readonly themeColorMeta: HTMLMetaElement

  constructor() {
    this.themeColorMeta = document.createElement('meta')
    this.themeColorMeta.name = 'theme-color'
  }

  apply(snapshot: ThemeSnapshot): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    const body = document.body
    if (scheme === 'dark') body.setAttribute(DARK_ATTRIBUTE, '')
    else body.removeAttribute(DARK_ATTRIBUTE)
    // 正文字号轴：官方由 ui-layout 的 ThemePresenter 写，corum 侧必须自己写，
    // 否则「会话正文字号」设置只落盘、不生效（PRD §4.3.1 的运行时断链）。
    // 0.2.1 起 ThemeSnapshot 把单个 fontSize(number) 拆成 fontSizes(Record<FontRole, number>)；
    // content 轴对应 'text' role（FONT_ROLES = ['text','code','terminal']），变量名不变。
    body.style.setProperty(CONTENT_FONT_SIZE_VARIABLE, `${snapshot.fontSizes.text}px`)
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value)
      this.appliedTokens.push(name)
    }
    this.themeColorMeta.content = getComputedStyle(body).backgroundColor
    if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta)
  }

  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    const body = document.body
    body.removeAttribute(DARK_ATTRIBUTE)
    body.style.removeProperty(CONTENT_FONT_SIZE_VARIABLE)
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    this.themeColorMeta.remove()
  }
}
