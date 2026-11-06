/**
 * corum 的 monaco 主题（浅/深双份）+ 注册与切换的唯一入口。
 *
 * 为什么单独成模块：**主题注册（defineTheme）是全局的，而 setTheme 也是全局的**。
 * 早期只有 MonacoEditor 在自己挂载时才 `defineCorumThemes()`，于是「没打开过任何文件
 * 就直接看 diff」时，DiffViewer 的 `setTheme('corum-dark')` 遇到的是**未注册的主题**
 * —— monaco 回落到默认的 `vs`（浅色），编辑区就变成白底（用户实测反馈）。
 * 把注册收进这里、任何要设置主题的地方都先调 `applyCorumTheme()`，就不会再有时序洞。
 *
 * 另外**必须显式定义 `diffEditor.*` 颜色**：monaco 的 diff 默认底色是按浅色主题配的
 * （尤其 `diffEditor.diagonalFill` 那条浅灰斜纹），叠在 corum 深色玻璃上会被读成
 * 「浅色背景」。
 *
 * @module corum-desktop/client/editor/monaco-theme
 */

import { editor } from 'monaco-editor'
import type { editor as MonacoEditorApi } from 'monaco-editor'

const CORUM_THEMES: Record<'corum-light' | 'corum-dark', MonacoEditorApi.IStandaloneThemeData> = {
  'corum-light': {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#00000000',
      'editorGutter.background': '#00000000',
      // 小地图开启时概览标记区会回退到 tokenization 背景；透明编辑器必须显式覆盖。
      'editorOverviewRuler.background': '#00000000',
      'editorOverviewRuler.border': '#00000000',
      'editor.lineHighlightBackground': '#0E0E1C08',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#8B8BA3',
      'editorLineNumber.activeForeground': '#0E0E1C',
      'editorCursor.foreground': '#5B21F5',
      'editor.foreground': '#0E0E1C',
      'editorWidget.background': '#FFFFFFCC',
      'editorWidget.border': '#FFFFFF',
      'scrollbarSlider.background': '#8B8BA333',
      'scrollbarSlider.hoverBackground': '#8B8BA355',
      'scrollbarSlider.activeBackground': '#8B8BA377',
      'minimap.background': '#00000000',
      'minimapSlider.background': '#8B8BA322',
      'minimapSlider.hoverBackground': '#8B8BA333',
      'minimapSlider.activeBackground': '#8B8BA344',
      'editorIndentGuide.background1': '#8B8BA326',
      'editorIndentGuide.activeBackground1': '#8B8BA355',
      'editorBracketMatch.background': '#5B21F522',
      'editorBracketMatch.border': '#5B21F566',
      'editor.foldBackground': '#0E0E1C06',
      'editorGutter.foldingControlForeground': '#8B8BA3',
      'editor.findMatchBackground': '#5B21F544',
      'editor.findMatchHighlightBackground': '#5B21F522',
      'editor.findMatchBorder': '#5B21F5',
      'editor.selectionBackground': '#5B21F533',
      'editor.selectionHighlightBackground': '#5B21F522',
      'editorGhostText.foreground': '#8B8BA388',
      // ── diff（影子仓库的改动对比）────────────────────────────────────────
      'diffEditor.insertedLineBackground': '#0BA57C1F',
      'diffEditor.removedLineBackground': '#D93A5C1F',
      'diffEditor.insertedTextBackground': '#0BA57C33',
      'diffEditor.removedTextBackground': '#D93A5C33',
      'diffEditor.diagonalFill': '#0E0E1C0A',
      'diffEditor.border': '#FFFFFF',
      'diffEditorGutter.insertedLineBackground': '#0BA57C14',
      'diffEditorGutter.removedLineBackground': '#D93A5C14',
      'diffEditorOverview.insertedForeground': '#0BA57C66',
      'diffEditorOverview.removedForeground': '#D93A5C66',
    },
  },
  'corum-dark': {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#00000000',
      'editorGutter.background': '#00000000',
      'editorOverviewRuler.background': '#00000000',
      'editorOverviewRuler.border': '#00000000',
      'editor.lineHighlightBackground': '#F3ECFF0A',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#7E719E',
      'editorLineNumber.activeForeground': '#F3ECFF',
      'editorCursor.foreground': '#01CDFE',
      'editor.foreground': '#F3ECFF',
      'editorWidget.background': '#2A1840D9',
      'editorWidget.border': '#B98CFF2E',
      'scrollbarSlider.background': '#7E719E33',
      'scrollbarSlider.hoverBackground': '#7E719E55',
      'scrollbarSlider.activeBackground': '#7E719E77',
      // minimap / 缩进参考线 / 括号匹配 / 折叠（corum 玻璃暗色对齐）。
      'minimap.background': '#00000000',
      'minimapSlider.background': '#7E719E22',
      'minimapSlider.hoverBackground': '#7E719E33',
      'minimapSlider.activeBackground': '#7E719E44',
      'editorIndentGuide.background1': '#7E719E26',
      'editorIndentGuide.activeBackground1': '#7E719E55',
      'editorBracketMatch.background': '#01CDFE22',
      'editorBracketMatch.border': '#01CDFE66',
      'editorBracketHighlight.foreground1': '#01CDFE',
      'editorBracketHighlight.foreground2': '#B98CFF',
      'editorBracketHighlight.foreground3': '#01FEA5',
      'editorBracketHighlight.unexpectedBracket.foreground': '#FF5B5B',
      'editor.foldBackground': '#F3ECFF08',
      'editorGutter.foldingControlForeground': '#7E719E',
      // 查找高亮。
      'editor.findMatchBackground': '#01CDFE44',
      'editor.findMatchHighlightBackground': '#01CDFE22',
      'editor.findMatchBorder': '#01CDFE',
      // 选区。
      'editor.selectionBackground': '#5B21F533',
      'editor.selectionHighlightBackground': '#5B21F522',
      // 幽灵文本（补全）。
      'editorGhostText.foreground': '#7E719E88',
      // ── diff（影子仓库的改动对比）────────────────────────────────────────
      // 必须显式给：monaco 默认的 diff 底色（尤其 diagonalFill 的浅灰斜纹）是按
      // 浅色主题设计的，落在 corum 的深色玻璃上会读成「浅色背景」。
      'diffEditor.insertedLineBackground': '#3EE6B01F',
      'diffEditor.removedLineBackground': '#FF7B6E1F',
      'diffEditor.insertedTextBackground': '#3EE6B033',
      'diffEditor.removedTextBackground': '#FF7B6E33',
      'diffEditor.diagonalFill': '#F3ECFF0A',
      'diffEditor.border': '#B98CFF2E',
      'diffEditorGutter.insertedLineBackground': '#3EE6B014',
      'diffEditorGutter.removedLineBackground': '#FF7B6E14',
      'diffEditorOverview.insertedForeground': '#3EE6B066',
      'diffEditorOverview.removedForeground': '#FF7B6E66',
    },
  },
}

/** Registered-once flag (defineTheme is global, not per-editor). */
let corumThemesDefined = false

/**
 * 注册（幂等）corum 主题。**必须在任何 `editor.create` / `createDiffEditor` 之前调用**：
 * 传一个未注册的主题名进去，monaco 会静默回落到默认的 `vs`（浅色）。
 */
export function defineCorumThemes(): void {
  if (corumThemesDefined) return
  corumThemesDefined = true
  editor.defineTheme('corum-light', CORUM_THEMES['corum-light'])
  editor.defineTheme('corum-dark', CORUM_THEMES['corum-dark'])
}

/** 主题名（与 CORUM_THEMES 的键一致）。 */
export type CorumThemeName = 'corum-light' | 'corum-dark'

/** 按深浅取主题名。 */
export function corumThemeName(dark: boolean): CorumThemeName {
  return dark ? 'corum-dark' : 'corum-light'
}

/**
 * 注册（幂等）corum 主题并把它设为当前主题。**任何** monaco 编辑器（主编辑器与
 * diff 视图）在创建/切换主题时都应调这个，而不是直接 `editor.setTheme`。
 */
export function applyCorumTheme(dark: boolean): void {
  defineCorumThemes()
  editor.setTheme(corumThemeName(dark))
}
