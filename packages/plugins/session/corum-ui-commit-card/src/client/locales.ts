/** `gitPanel` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  ns: 'gitPanel',
  title: '版本控制',
  branch: '当前分支',
  changes: '未提交的更改',
  commit: '提交',
  cancel: '取消',
  close: '关闭',
  commitMessage: '提交信息',
  selectAll: '全选',
  idle: 'Agent 空闲中 · 可切换分支',
  busy: 'Agent 工作中',
  injectPreview: '下轮注入给 Agent 的内容',
} satisfies Record<string, string>

/** Dictionary key union. */
export type GitPanelKey = keyof typeof zh

/** English dictionary (must cover every zh key). */
export const en: Record<GitPanelKey, string> = {
  ns: 'gitPanel',
  title: 'Version Control',
  branch: 'Current Branch',
  changes: 'Uncommitted Changes',
  commit: 'Commit',
  cancel: 'Cancel',
  close: 'Close',
  commitMessage: 'Commit Message',
  selectAll: 'Select All',
  idle: 'Agent idle · branch switching available',
  busy: 'Agent working',
  injectPreview: 'Content to inject next turn',
}

/** Locale namespace name. */
export const NS = 'gitPanel'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Git panel copy. */
    gitPanel: GitPanelKey
  }
}
