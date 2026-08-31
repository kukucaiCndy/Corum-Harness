/** `corum-question` namespace dictionaries（提问卡片文案，corum 重设计）。 */
export const NS = 'corum-question'

export const zh = {
  title: '提问',
  submit: '提交',
  submitting: '提交中…',
  skip: '跳过本题',
  prev: '上一题',
  next: '下一题',
  collapse: '收起问题',
  expand: '展开问题',
  abandon: '放弃整组问题',
  'placeholder.free': '输入你的回答…',
  'placeholder.extra': '补充说明（可选）…',
} satisfies Record<string, string>

export type CorumQuestionKey = keyof typeof zh

export const en = {
  title: 'Question',
  submit: 'Submit',
  submitting: 'Submitting…',
  skip: 'Skip',
  prev: 'Previous',
  next: 'Next',
  collapse: 'Collapse',
  expand: 'Expand',
  abandon: 'Dismiss all',
  'placeholder.free': 'Type your answer…',
  'placeholder.extra': 'Add a note (optional)…',
} satisfies Record<CorumQuestionKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Question card copy (corum). */
    'corum-question': CorumQuestionKey
  }
}
