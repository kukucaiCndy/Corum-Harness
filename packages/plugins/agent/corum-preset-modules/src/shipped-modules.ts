/**
 * shipped-modules — 随包分发的「内置模块集」路径解析与列举。
 *
 * ## 为什么存在
 *
 * 与 `shipped-skills` 同理：内置模块此前只活在 dev home 的托管库，换机器或装打包版
 * 就没有。W3 把内置模块实体搬到 `packages/desktop/shipped-modules/<module-dir>/`（与
 * `shipped-skills/` 同款 staging），本模块提供路径解析 + 列举，供导入向导列出
 * 「可装的内置模块」。
 *
 * ## 路径解析手法
 *
 * **照抄 `corum-skill-manager/src/shipped-skills.ts` 的 `resolveShippedSkillsRoot`**：
 * 两种布局的锚点深度不同，故按「自模块目录逐级上溯」探测，而不是写死相对跳数：
 *   - 打包态：`<runtime>/node_modules/@corum/corum-preset-modules/lib/index.js`
 *     → 上溯到 `<runtime>/` 命中 `<runtime>/shipped-modules/`。
 *   - 源码态：`packages/plugins/agent/corum-preset-modules/lib/index.js`
 *     → 上溯到 `packages/` 命中 `packages/desktop/shipped-modules/`。
 *
 * `CORUM_SHIPPED_MODULES_DIR` 环境变量存在时直接采信（自检脚本与自定义打包用）。
 *
 * @module @corum/corum-preset-modules/shipped-modules
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  MODULE_MANIFEST_FILE,
  validateManifest,
  type ModuleManifest,
} from './module-format.ts'

/** 覆盖随包模块目录的环境变量（自检脚本与自定义打包用；未设时按布局探测）。 */
export const SHIPPED_MODULES_ENV = 'CORUM_SHIPPED_MODULES_DIR'

/**
 * 探测随包模块目录。
 *
 * 两种布局的锚点深度不同，所以按「自模块目录逐级上溯」探测，而不是写死相对跳数
 * （与 `resolveShippedSkillsRoot` 同法，已在 dev 与打包两种布局下验证过）。
 *
 * @returns 随包模块目录绝对路径；两种布局都没命中时 undefined。
 */
export function resolveShippedModulesRoot(): string | undefined {
  const override = process.env[SHIPPED_MODULES_ENV]
  if (override !== undefined && override.trim() !== '') return override

  const markers = ['shipped-modules', join('desktop', 'shipped-modules')]
  let dir = import.meta.dirname
  for (let depth = 0; depth < 8; depth += 1) {
    for (const marker of markers) {
      const candidate = join(dir, marker)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * 扫描随包模块目录：只认「一层子目录 + 其中含合法 `module.json`」。
 *
 * @param root - 随包模块目录。
 * @returns 按模块 id 升序的列表；目录不存在或不可读时返回空数组。
 */
export function listShippedModules(root?: string): readonly { readonly dir: string; readonly manifest: ModuleManifest }[] {
  const resolved = root ?? resolveShippedModulesRoot()
  if (resolved === undefined) return []
  if (!existsSync(resolved)) return []
  let entries: string[]
  try {
    entries = readdirSync(resolved)
  } catch {
    return []
  }
  const modules: { dir: string; manifest: ModuleManifest }[] = []
  for (const entry of entries) {
    const dir = join(resolved, entry)
    const manifestPath = join(dir, MODULE_MANIFEST_FILE)
    if (!existsSync(manifestPath)) continue
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    // 只收合法清单（坏的跳过，不 fail-loud——列举不该因一个坏模块全挂）。
    if (validateManifest(raw).length > 0) continue
    modules.push({ dir, manifest: raw as ModuleManifest })
  }
  return modules.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
}
