import type { editor } from 'monaco-editor'

/** Monaco 依靠不透明小地图遮住长行；玻璃主题需裁切正文，保留独立的小地图列。 */
export function installMinimapViewport(instance: editor.ICodeEditor): () => void {
  const sync = (): void => {
    // Monaco 在首次 setModel 时才建立正文层，不能在 create 后一次性查找。
    const content = instance.getDomNode()?.querySelector<HTMLElement>('.lines-content')
    if (!content) return
    const { contentLeft, minimap } = instance.getLayoutInfo()
    if (minimap.renderMinimap === 0) { content.style.clipPath = ''; return }
    const left = instance.getScrollLeft()
    const right = left + Math.max(0, minimap.minimapLeft - contentLeft - 8)
    content.style.clipPath = `inset(0 calc(100% - ${right}px) 0 ${left}px)`
  }
  const layout = instance.onDidLayoutChange(sync)
  const scroll = instance.onDidScrollChange(sync)
  const model = instance.onDidChangeModel(sync)
  sync()
  return () => {
    layout.dispose(); scroll.dispose(); model.dispose()
    const content = instance.getDomNode()?.querySelector<HTMLElement>('.lines-content')
    if (content) content.style.clipPath = ''
  }
}
