/**
 * Agent 预设模块的 **zip 打包/解包**。
 *
 * ## 为什么用 `fflate` 而不是 `node:zlib` / `archiver`
 *
 * `node:zlib` 只做 gzip/deflate，不带 zip 容器（目录结构 + 多文件元数据）；
 * `archiver` 是流式 API，对一个纯函数库来说过度且会引入异步复杂度。`fflate` 提供
 * **同步**的 `zipSync` / `unzipSync`，调用方式简单、零依赖、已在 pnpm store 里，
 * 与本包「纯函数库、不注册服务、无异步编排」的定位一致。
 *
 * ## 安全：防 zip slip
 *
 * 解包时恶意 zip 的条目名可能含 `../`（`../../etc/passwd` 这类），若直接按条目名
 * join，会写到 destDir **之外**——这是真实的路径穿越漏洞（不是形式）。故解包前
 * 对**每个**条目的规范化路径做校验：必须落在 destDir 之内，否则**拒绝整个解包**
 * （不跳过单条——跳过会掩盖「这个 zip 有问题」，不如直接失败让调用方换一个）。
 *
 * @module @corum/corum-preset-modules/module-archive
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
// fflate 是同步 zip/unzip 库（无依赖，已在 pnpm store）。
import { zipSync, unzipSync, type Unzipped } from 'fflate'

/**
 * 把一个模块目录打包成 zip。
 *
 * 递归读取 moduleDir 下所有文件，用 fflate 的 `zipSync` 生成 zip 二进制。
 * 条目名用**相对路径**（POSIX 风格 `/` 分隔，zip 规范要求正斜杠），保证解包后
 * 目录结构与原始一致。
 *
 * @param moduleDir - 模块目录（磁盘上的真实目录）。
 * @param zipPath - 输出 zip 文件路径。
 * @returns 写入的 zip 文件绝对路径。
 */
export function packModuleArchive(moduleDir: string, zipPath: string): string {
  const resolvedZip = resolve(zipPath)
  const entries = collectEntries(moduleDir, '')
  // fflate 的 zipSync 接受 { "相对路径": Uint8Array } 的扁平映射。
  const input: Record<string, Uint8Array> = {}
  for (const [relPath, absPath] of entries) {
    // 读取文件二进制。用 readFileSync 的 "latin1" 之外的方式会丢字节，故直接构造 Buffer。
    // Buffer 是 Uint8Array 的子类，fflate 接受 Uint8Array。
    const buf = readFileSyncAsUint8Array(absPath)
    input[relPath] = buf
  }
  const zipped = zipSync(input)
  // 确保输出目录存在。
  mkdirSync(dirname(resolvedZip), { recursive: true })
  writeFileSync(resolvedZip, zipped)
  return resolvedZip
}

/**
 * 把一个 zip 解包到目标目录。
 *
 * **防 zip slip**：每个条目规范化后必须落在 destDir 之内，否则抛错（拒绝整个解包）。
 *
 * @param zipPath - zip 文件路径。
 * @param destDir - 解包目标目录（不存在则递归创建）。
 * @returns 解包后的目录绝对路径。
 * @throws 当条目路径逃逸 destDir 时（zip slip 防护）。
 */
export function unpackModuleArchive(zipPath: string, destDir: string): string {
  const resolvedDest = resolve(destDir)
  const zipped = readFileSyncAsUint8Array(resolve(zipPath))
  const files: Unzipped = unzipSync(zipped)
  mkdirSync(resolvedDest, { recursive: true })
  for (const [name, data] of Object.entries(files)) {
    // zip 条目名可能是目录（末尾 `/`）或文件；目录条目跳过（mkdir 会随文件创建）。
    if (name.endsWith('/')) continue
    // 规范化条目路径：zip 规范用正斜杠，但恶意 zip 可能混入反斜杠或绝对路径。
    const normalized = normalizeZipEntryName(name)
    const target = join(resolvedDest, normalized)
    // **zip slip 判据**：规范化后的绝对路径必须以 destDir 为前缀。
    // 用 resolve + startsWith 而不是字符串拼接比对——resolve 会展开 `..`。
    if (!isWithinDir(target, resolvedDest)) {
      throw new Error(`corum-preset-modules: zip 条目 "${name}" 逃逸目标目录（zip slip 防护），拒绝解包`)
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
  }
  return resolvedDest
}

// ── 辅助 ──────────────────────────────────────────────────────────

/**
 * 递归收集目录下所有文件的 [相对路径(POSIX), 绝对路径] 对。
 *
 * 相对路径用正斜杠分隔（zip 规范），与平台无关——解包时也按此还原。
 */
function collectEntries(dir: string, prefix: string): [string, string][] {
  const result: [string, string][] = []
  const entries = readdirSync(dir).sort()
  for (const entry of entries) {
    const absPath = join(dir, entry)
    const relPath = prefix === '' ? entry : `${prefix}/${entry}`
    const stat = statSyncOrNull(absPath)
    if (stat === null) continue
    if (stat.isDirectory()) {
      result.push(...collectEntries(absPath, relPath))
    } else if (stat.isFile()) {
      result.push([relPath, absPath])
    }
  }
  return result
}

/** statSync 的安全封装（不存在/不可访问返回 null）。 */
function statSyncOrNull(path: string): { isDirectory(): boolean; isFile(): boolean } | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** 读文件为 Uint8Array（fflate 接受的输入格式）。 */
function readFileSyncAsUint8Array(path: string): Uint8Array {
  // Buffer 是 Uint8Array 子类；fflate 0.8 兼容 Buffer 的底层 ArrayBuffer。
  return readFileSync(path) as unknown as Uint8Array
}

/**
 * 规范化 zip 条目名为平台路径。
 *
 * zip 规范用正斜杠分隔；恶意 zip 可能混入 `\`（Windows 风格）或绝对路径（`/etc/...`、
 * `C:\...`）。这里统一转成正斜杠后交给 `join`，再由 `isWithinDir` 做 `..` 校验。
 * 绝对路径（前导 `/` 或盘符）在 join 时会被当相对路径处理（前导分隔符被 join 剥掉），
 * 但 `isAbsolute` 检查能提前拦住。
 */
function normalizeZipEntryName(name: string): string {
  // 拒绝绝对路径（zip slip 的另一种形态）。
  if (isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
    throw new Error(`corum-preset-modules: zip 条目 "${name}" 是绝对路径，拒绝解包`)
  }
  // 统一分隔符为平台分隔符。
  return name.replace(/\//g, sep).replace(/\\/g, sep)
}

/**
 * 判断 target 是否在 baseDir 之内（含 baseDir 自身）。
 *
 * 用 `resolve` 展开 `..` 后比对前缀——这是 zip slip 防护的核心判据。
 * 仅靠字符串 `startsWith` 会被 `/destDir-evil` 这类同前缀目录骗过，
 * 故必须加分隔符。
 */
function isWithinDir(target: string, baseDir: string): boolean {
  const resolvedTarget = resolve(target)
  const resolvedBase = resolve(baseDir)
  if (resolvedTarget === resolvedBase) return true
  // 加分隔符确保是子目录而非同名前缀。
  return resolvedTarget.startsWith(resolvedBase + sep)
}
