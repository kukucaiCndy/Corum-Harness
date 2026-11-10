/**
 * `editable` → monaco `readOnly` 的**唯一映射点**（防御修复；2026-11 补）。
 *
 * ## 为什么单独一个模块
 *
 * `MonacoEditor.tsx` 此前只在 `editor.create(...)` 里写了一次 `readOnly: !editable`，
 * `updateOptions` 那条路上**从不**同步 `readOnly`。于是 `editable` 变化能不能生效，
 * 完全取决于「create effect 会不会因为 `editable` 重建实例」这一条隐式耦合——
 * 一旦有人把 `editable` 从依赖里摘掉（或改成别的重建策略），编辑器就停在旧读写态：
 * 只读面板要能编辑时仍然打不进字，或本该只读的预览反而可写（数据面是真实文件）。
 *
 * 现在 create 与 update 共用本模块的两个函数，两处不可能再漂移：
 *   · `readOnlyOptionOf(editable)` —— 创建时算初值；
 *   · `syncEditableReadOnly(instance, editable)` —— 变化时**只**更新 readOnly，
 *     不碰其它选项（字体/小地图/主题等由各自的偏好订阅维护，不能被这里覆盖）。
 *
 * ⚠️ 这是**防御修复**：它保证读写态不再依赖实例重建策略，**不等于**旧实机的
 * 「切换只读后编辑器行为不对」已复现/已关闭。
 * @module corum-desktop/client/editor/editable-readonly
 */

/**
 * 把 `editable` 映射成 monaco 的 `readOnly` 选项值。
 * @param editable - 业务语义的「可编辑」。
 * @returns monaco 语义的 `readOnly`（与 `editable` 相反）。
 */
export function readOnlyOptionOf(editable: boolean): boolean {
  return !editable
}

/** `updateOptions` 的最小能力面（只声明本模块实际写的那一个键）。 */
export interface EditableOptionTarget {
  updateOptions(options: { readOnly: boolean }): void
}

/**
 * 把当前 `editable` 同步进**已存在**的编辑器实例（实例缺席时静默跳过）。
 *
 * 只写 `readOnly` 一个键：`updateOptions` 是浅合并语义，未写的键保持现状，
 * 因此字体/小地图/主题等由偏好订阅维护的选项不受影响。
 * @param target - 编辑器实例（可能尚未创建 / 已销毁）。
 * @param editable - 业务语义的「可编辑」。
 */
export function syncEditableReadOnly(target: EditableOptionTarget | null | undefined, editable: boolean): void {
  if (target === null || target === undefined) return
  target.updateOptions({ readOnly: readOnlyOptionOf(editable) })
}
