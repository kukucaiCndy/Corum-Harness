/**
 * 桌面**运行期 bundle**：把「行定义」（insert 行）从 overlay 层挪到 profile 的
 * bundle 层，这样它们才既能热重组保留、又能被设置中心写。
 *
 * ## 为什么必须这么做（rc3 实测，两条判据互相拉扯）
 *
 * 官方 `readProfilePatches()` 的层栈顺序是固定的：
 *
 *     bundle 层 → profile 的 cordis.patch.yml → home patch → profileContext.overlays
 *
 * 而 `composeEntries()`（`@deepseek-ai/cordis-plugin-include` 的 patch 语义）有两条
 * 不可绕过的事实（实测，见 packages/desktop/tests/desktop-overlays.test.mjs）：
 *
 * 1. **`insert` 行是 append 语义、不按 id 去重** ⇒ 同一行定义叠两层会插入两行 →
 *    loader 报 id 重复。所以 insert 行只能出现在**一层**里。
 * 2. **只带 `id`/`config` 的覆盖行无法创建行**：目标行还不存在时，这一行被**丢弃**。
 *    因此「先用 insert 建行、再用后面层的 config 覆盖」这个顺序是唯一有效的写法。
 *
 * 把 insert 行留在 overlay 层（也就是 profile patch **之后**）会同时踩两条：
 *   - `dsh-config-editor.edit()` 的守卫（`ConfigEditor` 写 profile patch 后重新组合，
 *     要求「该行的生效 config == 用户刚写进去的值」）对 overlay 建出来的行必然不成立
 *     （profile 层的 config 行在 insert 之前被丢弃）⇒ 设置中心写 corum 的任何 ns 都报
 *     `Configuration for "…" is overridden by a home patch or command-line overlay`；
 *   - 反过来把 profileContext.overlays 清空（rc3 修复前的形态）⇒ 热重组丢覆盖层，
 *     webserver 回落 3080、官方 plugin-manager/credentials 复活撞服务名。
 *
 * 唯一同时满足的层就是 **bundle 层**：它在 profile patch **之前**，所以
 *   · 行在 profile 层之前就存在 ⇒ 用户的 config 覆盖能生效、设置写通过官方守卫；
 *   · 它在 `readProfilePatches()` 里同样被读出（从 profile manifest 的
 *     `dsh.profile.bundles` 解析）⇒ 热重组的组合与冷启动一致。
 *
 * ## 为什么是「生成的 bundle」而不是静态 bundle
 *
 * 需要搬进 bundle 的 insert 行不只是一个静态文件：它随 **IDE/最小模式**、
 * **combo 注入的插件**（`CORUM_COMBO_PLUGINS`）变化，而这几样在进程启动时定死。
 * 所以每次 boot 按当前进程的层栈重新生成 bundle 的 patch 文件——生成物只含
 * **insert 块原文**（从源 patch 文件里按行切出来，`!!js` 表达式原样保留，绝不
 * 反序列化再序列化）+ combo 插件行。
 *
 * overlay 层剩下的（`disabled` 行、config 覆盖行）继续走 profileContext.overlays，
 * 见 `desktop-overlays.ts` 的分层表。
 *
 * @module corum-desktop/host/runtime-bundle
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readProfileManifest, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'

/** 生成 bundle 的包名（写进 profile manifest 的 `dsh.profile.bundles`）。 */
export const RUNTIME_BUNDLE_NAME = 'corum-desktop-runtime'

/** 生成 bundle 在 `$DSH_HOME` 下的目录名。 */
export const RUNTIME_BUNDLE_DIRNAME = 'desktop-runtime-bundle'

/** 生成 bundle 的 patch 文件名（与其 package.json 的 `dsh.bundle.patch` 同名）。 */
const BUNDLE_PATCH_FILENAME = 'cordis.patch.yml'

/** 一条待插入的插件行（combo 注入用）。 */
export interface RuntimeInsertRow {
  readonly id: string
  readonly name: string
}

/** 组成运行期 bundle 的输入。 */
export interface RuntimeBundleLayers {
  /** 按层栈顺序的 patch 文件（桌面层 → presets → IDE 模式层 → combo 规则文件）。 */
  readonly patchFiles: readonly string[]
  /** combo 注入的插件行：作为最后一个 insert 块追加。 */
  readonly extraRows?: readonly RuntimeInsertRow[]
}

export interface PublishRuntimeBundleOptions {
  /** `$DSH_HOME`（bundle 目录与 profiles/node_modules 都在这下面）。 */
  readonly home: string
  /** profile 目录（其 package.json 的 `dsh.profile.bundles` 被追加本 bundle）。 */
  readonly profileDir: string
  /** 宿主应用版本（写进生成的 package.json，仅作审计信息）。 */
  readonly version: string
  /** 层栈输入。 */
  readonly layers: RuntimeBundleLayers
}

export interface RuntimeBundleResult {
  /** 生成目录的绝对路径。 */
  readonly bundleDir: string
  /** 生成 bundle 的包名。 */
  readonly bundleName: string
  /** 本次是否有任何写入（生成物内容或 profile manifest 变了）。 */
  readonly changed: boolean
  /** 抽出并写入的 insert 块数。 */
  readonly blocks: number
  /** 写入的 insert 行数。 */
  readonly rows: number
}

/**
 * 从一份 patch YAML 里按**原文**切出顶层 `- insert:` 块。
 *
 * 为什么按文本切而不是解析再序列化：patch 行里带 `!!js` 表达式
 * （`dshHomePath('storages','kv.sqlite')`、`process.platform === 'win32'` 等），
 * 任何「load → dump」往返都有丢标签的风险；直接复制原文可以保证语义逐字节不变。
 * 顶层块以列 0 的 `- insert:` 开头，到下一个列 0 的 `- ` 行或文件结束为止。
 * @param text - patch 文件原文。
 * @returns 该文件里所有顶层 insert 块的原文（按出现顺序）。
 */
export function extractInsertBlocks(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let start = -1
  const flush = (end: number): void => {
    if (start < 0) return
    // 去掉块尾的注释/空行（它们视觉上属于下一条顶层行）。
    let last = end - 1
    while (last > start) {
      const trimmed = lines[last].trim()
      if (trimmed === '' || trimmed.startsWith('#')) last -= 1
      else break
    }
    blocks.push(lines.slice(start, last + 1).join('\n'))
    start = -1
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (start < 0) {
      if (/^- insert:\s*$/.test(line)) start = index
      continue
    }
    if (/^- /.test(line)) flush(index)
  }
  flush(lines.length)
  return blocks
}

/** 把 combo 插件行折成一个 insert 块（4 空格缩进，与手写 patch 同形）。 */
function renderInsertBlock(rows: readonly RuntimeInsertRow[]): string {
  if (rows.length === 0) return ''
  // id 一样要引号：combo 行 id 是包名（`@corum/corum-agent`），`@` 在 YAML 里是
  // 保留字符，裸写会被解析器判为 bad indentation。
  const body = rows.map(row => `    - id: ${JSON.stringify(row.id)}\n      name: ${JSON.stringify(row.name)}`).join('\n')
  return `- insert:\n${body}`
}

/** 统计一个 insert 块里的行数（`    - id:` 起头的行）。 */
function countRows(block: string): number {
  return block.split('\n').filter(line => /^ {4}- id:/.test(line)).length
}

/** Ensure `link` is a symlink to `target`（与 boot.ts 的同名逻辑同义）。 */
function ensureSymlink(link: string, target: string): void {
  let stat
  try {
    stat = lstatSync(link)
  } catch {
    stat = undefined
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) {
      throw new Error(`corum-desktop: ${link} 已存在且不是符号链接；删掉它让宿主自己管理运行期 bundle`)
    }
    if (readlinkSync(link) === target) return
    unlinkSync(link)
  }
  mkdirSync(dirname(link), { recursive: true })
  try {
    // `junction` 在 win32 上是目录链接、其余平台退化为普通 symlink（与 boot.ts 一致）。
    symlinkSync(target, link, 'junction')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' || !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) throw error
  }
}

/** 仅当内容不同才写（避免无意义的 mtime 抖动与 HMR 噪音）。 */
function writeIfChanged(file: string, content: string): boolean {
  try {
    if (readFileSync(file, 'utf8') === content) return false
  } catch {
    // 不存在 = 需要写。
  }
  writeFileSync(file, content)
  return true
}

/**
 * 生成（或刷新）运行期 bundle，并确保它出现在 profile manifest 的 bundle 列表里。
 *
 * 幂等：内容与 manifest 都没变时返回 `changed: false`，调用方不必重新装载 profile。
 * @param options - home / profile 目录 / 版本 / 层栈输入。
 * @returns 生成结果（changed 决定调用方是否要重新 loadProfile）。
 * @throws 源 patch 文件读不了，或 `profiles/node_modules` 里的同名路径不是符号链接。
 */
export function publishRuntimeBundle(options: PublishRuntimeBundleOptions): RuntimeBundleResult {
  const { home, profileDir, version, layers } = options
  const bundleDir = join(home, RUNTIME_BUNDLE_DIRNAME)
  mkdirSync(bundleDir, { recursive: true })

  // 1) 抽 insert 块原文（层栈顺序），再追加 combo 插件行。
  const blocks: string[] = []
  for (const file of layers.patchFiles) {
    blocks.push(...extractInsertBlocks(readFileSync(file, 'utf8')))
  }
  const comboBlock = renderInsertBlock(layers.extraRows ?? [])
  if (comboBlock !== '') blocks.push(comboBlock)
  // 顶层必须是 YAML 数组：没有任何 insert 块时要写成 `[]`，否则官方解析器会抛。
  const patchContent = blocks.length === 0 ? '[]\n' : `${blocks.join('\n\n')}\n`
  const rows = blocks.reduce((total, block) => total + countRows(block), 0)

  // 2) 生成包的 manifest（`dsh.bundle.patch` 指相对路径，官方按包目录解析）。
  const manifestContent = `${JSON.stringify({
    name: RUNTIME_BUNDLE_NAME,
    version,
    private: true,
    description: 'corum-desktop 运行期 bundle：桌面/preset/模式/combo 的 insert 行定义（每次 boot 生成，勿手改）',
    dsh: { bundle: { patch: `./${BUNDLE_PATCH_FILENAME}` } },
  }, null, 2)}\n`
  let changed = writeIfChanged(join(bundleDir, 'package.json'), manifestContent)
  changed = writeIfChanged(join(bundleDir, BUNDLE_PATCH_FILENAME), patchContent) || changed

  // 3) 让 profile 能解析到这个包：$DSH_HOME/profiles/node_modules/<name> → bundle 目录。
  //    官方 resolveBundleDir 的回落路径就是这里（boot.ts 的 heal 维护同一目录）。
  const linkDir = join(home, 'profiles', 'node_modules')
  mkdirSync(linkDir, { recursive: true })
  const link = join(linkDir, RUNTIME_BUNDLE_NAME)
  if (!existsSync(link) || (lstatSync(link).isSymbolicLink() && readlinkSync(link) !== bundleDir)) {
    ensureSymlink(link, bundleDir)
  }

  // 4) 追加进 profile manifest 的 bundle 列表（保持不变式：已有的顺序不动，只追加一次）。
  const manifest = readProfileManifest('corum-desktop', profileDir)
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
  if (!bundles.includes(RUNTIME_BUNDLE_NAME)) {
    writeProfileBundles(profileDir, manifest, [...bundles, RUNTIME_BUNDLE_NAME])
    changed = true
  }

  return { bundleDir, bundleName: RUNTIME_BUNDLE_NAME, changed, blocks: blocks.length, rows }
}
