/** `distillCard` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  ns: 'distillCard',
  title: '经验沉淀完成',
  subtitle: '条候选待取舍',
  viewArchive: '查看归档',
} satisfies Record<string, string>

/** Dictionary key union. */
export type DistillCardKey = keyof typeof zh

/** English dictionary (must cover every zh key). */
export const en: Record<DistillCardKey, string> = {
  ns: 'distillCard',
  title: 'Distillation Complete',
  subtitle: 'facts pending review',
  viewArchive: 'View Archive',
}

/** Locale namespace of the distill card. */
export const NS = 'distillCard'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Distill completion card copy. */
    distillCard: DistillCardKey
  }
}
