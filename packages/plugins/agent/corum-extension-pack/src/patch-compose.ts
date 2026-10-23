/**
 * 扩展包 patch 列表合成（P3b 纯函数辅助）。
 *
 * 把 boot 层栈的三段 patch 合成成一份**完整有序**列表，供热应用喂给
 * `loader.resolve('include').update({ config: { ..., patches } })`。
 *
 * ## 为什么顺序重要（见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md section 5.2.1）
 *
 * 三段的顺序 = 它们在 boot.ts 的层栈顺序：
 *   1. base：bundle 层 + profile cordis.patch.yml + home patch + overlays + 模式 overlay
 *            + combo overlay（插件中心 / combo 的静态 insert 行）。
 *   2. extension：`extension-packs/<packId>/entries.json` 折出来的 insert 行
 *      （P3a 的 `extensionPatches()` 结果）。
 *   3. disabled：`plugins.disabled.json` 折出来的 `{ id, disabled: true }` 行
 *      （插件中心启停的持久层）。
 *
 * 这条顺序就是 boot.ts 里 `composeEntries([..., extensionPackPatches, disabledPatches])`
 * 与 `composedOverlays = [..., ...extensionPackPatches, ...disabledPatches]` 的顺序。
 * 热应用必须**复刻同一顺序**，否则 disabled 行可能盖不到 extension insert 行
 * （盖错方向 = 想关的插件被热应用打开）。
 *
 * ## 为什么每次都从 base 重算（见 section 5.2.1.1）
 *
 * `applyEntryPatches` 的 `insert` 是 **append 语义、不按 id 去重**
 * （官方实现 `cordis-plugin-include/lib/index.js` 的 `data.push(...insert)`）。
 * 如果拿「当前 Loader 里已含上次 insert 结果的状态」当输入再插一次，**会出现
 * 重复行**。所以热应用的 base **必须不含任何 extension insert 结果**——
 * base 由 boot.ts 在启动时算好、且只含 boot 层栈（bundle/profile/home/overlay/combo），
 * 不含 extension/disabled 折行。每次热应用都用同一份 base 重新追加，自然幂等。
 *
 * @module @corum/corum-extension-pack/patch-compose
 */

import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/**
 * 合成一份完整有序的 patch 列表：`[...base, ...extension, ...disabled]`。
 *
 * 纯函数：不改入参、无 IO。三段均只读引用（返回新数组，元素仍是原引用——
 * 调用方在喂给 `loader.resolve('include').update` 前会 `structuredClone`，
 * 与 boot.ts 的 `structuredClone([...])` 同款，防止 Loader 把 patch 里的对象
 * 烘进它自己的状态）。
 *
 * @param base - boot 层栈（不含 extension/disabled 折行）。
 * @param extension - `extensionPatches(loadExtensionEntries(home))` 结果。
 * @param disabled - `loadDisabledPatches()` 等价物（`{ id, disabled: true }` 行）。
 * @returns 合成后的完整有序 patch 列表（同一引用顺序，无去重）。
 */
export function composeExtensionPatchList(
  base: readonly PatchOptions[],
  extension: readonly PatchOptions[],
  disabled: readonly PatchOptions[],
): PatchOptions[] {
  return [...base, ...extension, ...disabled]
}
