/** `commitCard` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  ns: 'commitCard',
  title: '整理改动并提交',
  pending: '待提交',
  progress: '进行中',
  done: '已完成',
  stashed: '已暂存',
} satisfies Record<string, string>

/** Dictionary key union. */
export type CommitCardKey = keyof typeof zh

/** English dictionary (must cover every zh key). */
export const en: Record<CommitCardKey, string> = {
  ns: 'commitCard',
  title: 'Review and commit changes',
  pending: 'Pending',
  progress: 'Committing',
  done: 'Done',
  stashed: 'Stashed',
}

/** Locale namespace of the commit card. */
export const NS = 'commitCard'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Commit-card status panel copy. */
    commitCard: CommitCardKey
  }
}
