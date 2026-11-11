/** `modelAsk` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  ns: 'modelAsk',
  barTitle: '子 Agent 模型不可用 · 任务已暂停',
  handle: '处理',
  dismiss: '稍后处理',
  panelTitle: '模型不可用，选择处理方式',
  pickerLabel: '指定模型：选『临时用主模型』或『永久改指定模型』时展开选择',
  pickerEmpty: '没有可用的模型',
  pickerRetry: '重新列举',
  footHint: '挂起后可从子 Agent 卡片随时恢复处理',
  apply: '应用并继续',
  applying: '应用中…',
} satisfies Record<string, string>

/** Dictionary key union. */
export type ModelAskKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  ns: 'modelAsk',
  barTitle: 'Child-Agent model unavailable · task paused',
  handle: 'Handle',
  dismiss: 'Later',
  panelTitle: 'Model unavailable — choose how to proceed',
  pickerLabel: 'Model: expands for ‘temporarily use the main model’ or ‘switch permanently’',
  pickerEmpty: 'No models available',
  pickerRetry: 'Reload',
  footHint: 'You can resume this from the child-Agent card after dismissing',
  apply: 'Apply and continue',
  applying: 'Applying…',
} satisfies Record<ModelAskKey, string>

/** Namespace id registered with the locale service. */
export const NS = 'modelAsk'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Model-ask decision panel copy. */
    modelAsk: ModelAskKey
  }
}
