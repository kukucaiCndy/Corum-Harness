export function hasUnsavedEditorTabs(tabs: readonly { content: string; savedContent: string; diff?: unknown }[]): boolean {
  return tabs.some(tab => tab.diff === undefined && tab.content !== tab.savedContent)
}
