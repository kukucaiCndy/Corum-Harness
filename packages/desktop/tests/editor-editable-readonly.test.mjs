/**
 * 编辑器**读写态同步**（`editable` → monaco `readOnly`）的守卫测试（防御修复）。
 *
 * ## 缺陷形态
 *
 * `MonacoEditor.tsx` 原先只在 `editor.create({ readOnly: !editable })` 里设一次读写态，
 * `updateOptions` 那条路从不更新 `readOnly`。也就是说：`editable` 变了能不能生效，完全
 * 取决于「create effect 会不会因为 `editable` 变而重建实例」这条隐式耦合。一旦这条耦合
 * 被改掉（把 editable 从依赖里摘掉 / 换重建策略），编辑器就停在旧读写态——只读面板要能
 * 编辑时仍然打不进字，或本该只读的预览反而可写（数据面是真实文件）。
 *
 * 现在：create 走 `readOnlyOptionOf(editable)`，变化走 `syncEditableReadOnly(instance, editable)`
 * （`updateOptions`，只写 readOnly 一个键，不碰字体/小地图/主题）。
 *
 * ## 判据
 *
 *   ① false → true → false 三次切换，每次都真的调 `updateOptions({ readOnly })`；
 *   ② 每次只写 `readOnly` 一个键（其它选项行为不被覆盖）；
 *   ③ 实例尚未创建 / 已销毁（null/undefined）时不抛；
 *   ④ 源码不变式：create 用同一映射点、同步走 effect 且 `[editable]` 依赖恰好一处。
 *
 * 注：**不用** IME/textarea 的 `readOnly` DOM 属性当判据——那既受 Monaco 内部 DOM 结构
 * 影响，也和「选项有没有被更新」不是同一件事；这里断言的是传给 editor API 的调用。
 *
 * ⚠️ 这是**防御修复**：它证明读写态不再依赖重建策略，**不等于**旧实机的读写态 BUG
 * 已复现/已关闭。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readOnlyOptionOf, syncEditableReadOnly } from '../lib/types/client/editor/editable-readonly.js'

/** 记录 updateOptions 调用的假实例（不涉及任何 DOM）。 */
function fakeEditor() {
  return {
    calls: [],
    updateOptions(options) { this.calls.push(options) },
  }
}

test('readOnlyOptionOf：editable 与 readOnly 恒为反相', () => {
  assert.equal(readOnlyOptionOf(false), true)
  assert.equal(readOnlyOptionOf(true), false)
})

test('editable 变化（false → true → false）每一步都更新 readOnly', () => {
  const editor = fakeEditor()
  // 初始：editable=false ⇒ readOnly=true（create 时同一个映射点算出来的初值）。
  assert.equal(readOnlyOptionOf(false), true)
  syncEditableReadOnly(editor, true)
  syncEditableReadOnly(editor, false)
  assert.deepEqual(editor.calls, [{ readOnly: false }, { readOnly: true }])
})

test('同步只写 readOnly 一个键（其它选项行为不被覆盖）', () => {
  const editor = fakeEditor()
  syncEditableReadOnly(editor, true)
  syncEditableReadOnly(editor, false)
  for (const call of editor.calls) assert.deepEqual(Object.keys(call), ['readOnly'])
})

test('实例缺席（null / undefined）时静默跳过，不抛', () => {
  assert.doesNotThrow(() => syncEditableReadOnly(null, true))
  assert.doesNotThrow(() => syncEditableReadOnly(undefined, false))
})

test('源码不变式：create 与 update 共用同一个映射点，且 editable 只在 sync effect 里当依赖', () => {
  const source = readFileSync(join(import.meta.dirname, '../src/client/editor/MonacoEditor.tsx'), 'utf8')
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  // create 时走映射点（而不是裸 `!editable`）。
  assert.match(code, /readOnly:\s*readOnlyOptionOf\(editable\)/)
  assert.doesNotMatch(code, /readOnly:\s*!editable/)
  // 变化时走同步函数。
  assert.match(code, /syncEditableReadOnly\(editorRef\.current,\s*editable\)/)
  // `[editable]` 依赖恰好一处 = sync effect（create effect 不再因 editable 重建实例）。
  assert.equal((code.match(/\}, \[editable\]\)/g) ?? []).length, 1)
})
