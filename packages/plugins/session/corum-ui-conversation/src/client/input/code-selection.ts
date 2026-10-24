export interface CodeSelection {
  path: string
  startLine: number
  endLine: number
  text: string
}

export function parseCodeSelection(ref: string): CodeSelection | null {
  try {
    const value = JSON.parse(ref) as Partial<CodeSelection> | null
    if (value === null || typeof value.path !== 'string' || value.path === '' || typeof value.text !== 'string' || value.text === ''
      || !Number.isInteger(value.startLine) || !Number.isInteger(value.endLine)
      || value.startLine! < 1 || value.endLine! < value.startLine!) return null
    return value as CodeSelection
  } catch { return null }
}

/** 发送插入时的选区快照，不在提交时重新读盘。 */
export function serializeCodeSelection(ref: string): string {
  const selection = parseCodeSelection(ref)
  if (selection === null) throw new Error('代码引用已失效，请重新选择代码')
  return `文件 ${JSON.stringify(selection.path)} 第 ${selection.startLine}–${selection.endLine} 行（选区快照）：\n${selection.text}`
}
