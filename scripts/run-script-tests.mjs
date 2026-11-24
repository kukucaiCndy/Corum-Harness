#!/usr/bin/env node
/**
 * run-script-tests.mjs —— 跑 `scripts/lib/*.spec.mjs`（仓库级门禁模块的回归网）。
 *
 * ## 为什么需要这个中间层（2026-11-25，PR #243 在 windows-latest 上红）
 *
 * 这些测试不属于任何 workspace 包，`pnpm -r run test` 扫不到；而直接写
 * `node --test scripts/lib/*.spec.mjs` 有两个跨平台陷阱：
 *
 * 1. **glob 由 shell 展开，不保证存在**：GitHub Actions 上 Linux/macOS 用 bash
 *    （会展开），Windows 用 PowerShell（**不展开**）⇒ node 收到字面量
 *    `scripts/lib/*.spec.mjs`、报「找不到文件」。同一行命令在两个平台上语义不同。
 * 2. **`node --test <dir>` 也不行**：Node 的默认发现规则只认
 *    `*.test.mjs` / `test-*.mjs` 等，**不认 `.spec.mjs`** ⇒ 目录里一个都匹配不到。
 *
 * 所以这里用 node 自己枚举目录（`readdirSync`，跨平台一致）再交给 `node --test`，
 * 新增 spec 时**不需要**改任何清单。
 *
 * @module scripts/run-script-tests
 */

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), 'lib')

/** 本目录下的测试文件（`.spec.mjs`；按名字排序以保证输出稳定）。 */
export function specFiles(dir = LIB_DIR) {
  return readdirSync(dir)
    .filter(name => name.endsWith('.spec.mjs'))
    .sort()
    .map(name => join(dir, name))
}

const files = specFiles()
if (files.length === 0) {
  // 不是「无事可做」，而是判据面被误删了 —— 门禁失效必须 fail loud。
  process.stderr.write('[script-tests] scripts/lib 下没有任何 *.spec.mjs —— 门禁测试面丢失，请检查\n')
  process.exit(1)
}

process.stdout.write(`[script-tests] 运行 ${files.length} 个 spec：${files.map(f => f.split(/[\\/]/).pop()).join('、')}\n`)
try {
  execFileSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
} catch (error) {
  process.exit(typeof error.status === 'number' ? error.status : 1)
}
