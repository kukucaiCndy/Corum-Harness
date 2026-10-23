/**
 * 扩展包根的分类（P1）。
 *
 * ## 为什么需要分类
 *
 * 一个包根目录可能同时有 `extension.json`（扩展包清单）和 `module.json`
 * （预设模块清单，P0 已定义）。两者都是合法的清单文件，但一个包根只能是一种——
 * 如果两个都有，说明包根结构混乱，安装器必须 fail-loud 拒绝，而不是猜一个。
 *
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §3 的包根分类规则。
 *
 * ## 设计要点
 *
 * 1. **classifyPack 是纯函数**：只接收两个布尔值（有没有这两个文件），
 *    不做任何磁盘 IO。文件存在性检查由 P2 的目录扫描层负责。
 * 2. **ambiguous 必须 fail-loud**：调用方拿到 `ambiguous` 后必须拒绝处理，
 *    不能静默选一个——这是安全纪律（与 zip slip 同类：歧义结构宁可拒绝也不要猜）。
 *
 * @module @corum/corum-extension-pack/pack-kind
 */

/**
 * 包根的分类结果。
 *
 * - `extension`      只有 `extension.json` ⇒ 扩展包
 * - `preset-module`  只有 `module.json`   ⇒ 预设模块（P0 已有）
 * - `ambiguous`      两者都有             ⇒ **歧义，必须拒绝**（见下文）
 * - `empty`          两者都没有           ⇒ 空目录或无清单
 */
export type PackKind = 'extension' | 'preset-module' | 'ambiguous' | 'empty'

/**
 * 根据包根的清单文件存在性分类包类型。
 *
 * ⚠️ **当 `hasExtensionJson` 和 `hasModuleJson` 同时为 true 时返回 `ambiguous`**：
 * 包根同时有 `extension.json` 和 `module.json` 是**歧义结构**——安装器无法判断
 * 这是一个扩展包还是一个预设模块。调用方（P2 的安装逻辑）拿到 `ambiguous` 后
 * **必须 fail-loud 拒绝**，不能静默选一个。这是安全纪律：歧义结构宁可拒绝也不要猜。
 *
 * @param hasExtensionJson - 包根是否有 `extension.json`
 * @param hasModuleJson - 包根是否有 `module.json`
 * @returns 包类型分类
 */
export function classifyPack(hasExtensionJson: boolean, hasModuleJson: boolean): PackKind {
  if (hasExtensionJson && hasModuleJson) return 'ambiguous'
  if (hasExtensionJson) return 'extension'
  if (hasModuleJson) return 'preset-module'
  return 'empty'
}
