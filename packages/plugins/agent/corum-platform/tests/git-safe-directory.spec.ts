/**
 * Windows git dubious-ownership 对策的语义守卫（2026-10-12 真机事故的回归网）。
 *
 * ## 事故锚点（用户真机原始报错）
 *
 * ```
 * gateway/internal: git initial commit failed (exit 128):
 *   fatal: detected dubious ownership in repository at 'F:/work/agent'
 *   'F:/work/agent' is owned by: USER-20231001WG/Administrator
 *   but the current user is:     USER-20231001WG/remote
 * ```
 *
 * 根因：git 的检查按**工作区根目录**属主判定；应用以 `remote` 运行而目录属主是
 * `Administrator` ⇒ 所有 git 命令 exit 128（连 `rev-parse` 都失败 ⇒ `isGitRepo`
 * 误判「非仓库」⇒ 接着 init + commit 才报上面那句）。
 *
 * ## 本测试守什么
 *
 * 纯函数面（不 spawn git、不依赖平台），守三条**容易改错**的语义：
 *   ① 非 Windows **绝不注入**（三平台纪律：改一处不能让另两处行为变化）；
 *   ② 注入的形态必须是 `-c safe.directory=<正斜杠路径>`（`-c` 必须在子命令前）；
 *   ③ 拿不到根目录时**不注入**（宁可少注入，也不要注入错路径把豁免浪费掉）。
 *
 * ⚠️ 本测试**不**代替真机验证：真机实测（`remote` 用户 + `Administrator` 属主目录）
 * 是 `exit 128 → exit 0` 的唯一判据，已单独做过（记在 `docs/tasks/log.jsonl`）。
 * 这里守的是「后人重构时别把这段逻辑改坏」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  gitSafeDirectoryArgs,
  gitSafeDirectoryArgsForRepo,
  needsGitSafeDirectory,
} from '../src/index.ts'

/** 临时把 `process.platform` 伪装成指定平台（只在本文件内生效）。 */
function withPlatform(platform: NodeJS.Platform, body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    body()
  } finally {
    if (original !== undefined) Object.defineProperty(process, 'platform', original)
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('git safe.directory —— Windows dubious-ownership 对策', () => {
  it('① 仅 Windows 需要注入；darwin/linux 一律不注入', () => {
    withPlatform('win32', () => expect(needsGitSafeDirectory()).toBe(true))
    withPlatform('darwin', () => expect(needsGitSafeDirectory()).toBe(false))
    withPlatform('linux', () => expect(needsGitSafeDirectory()).toBe(false))
  })

  it('① 非 Windows 上即使给了根目录也返回空数组（不改变既有行为）', () => {
    withPlatform('darwin', () => {
      expect(gitSafeDirectoryArgs('F:/work/agent')).toEqual([])
    })
    withPlatform('linux', () => {
      expect(gitSafeDirectoryArgs('/home/u/ws')).toEqual([])
    })
  })

  it('② Windows 上注入 `-c safe.directory=<正斜杠路径>`（-c 必须在子命令之前）', () => {
    withPlatform('win32', () => {
      // 反斜杠输入要被归一成正斜杠（与 git 自己打印的 'F:/work/agent' 一致，
      // 也避免任何一层把反斜杠当转义序列吃掉）。
      expect(gitSafeDirectoryArgs('F:\\work\\agent')).toEqual(['-c', 'safe.directory=F:/work/agent'])
      // 已是正斜杠则原样通过。
      expect(gitSafeDirectoryArgs('F:/work/agent')).toEqual(['-c', 'safe.directory=F:/work/agent'])
      // 必须是「两个元素」：`-c` 与 `safe.directory=...` 分开传，
      // 合成一个字符串会被 git 当成子命令名而报错。
      expect(gitSafeDirectoryArgs('C:/ws')).toHaveLength(2)
      expect(gitSafeDirectoryArgs('C:/ws')[0]).toBe('-c')
    })
  })

  it('② 值里不得出现 `*`（不得退化成 safe.directory=* 全放行）', () => {
    withPlatform('win32', () => {
      const args = gitSafeDirectoryArgs('F:/work/agent')
      expect(args.join(' ')).not.toContain('safe.directory=*')
      // 精确到该目录：豁免列表里只有这一条。
      expect(args.filter((a) => a.startsWith('safe.directory='))).toEqual(['safe.directory=F:/work/agent'])
    })
  })

  it('③ 拿不到根目录（undefined / 空串 / 纯空白）时不注入', () => {
    withPlatform('win32', () => {
      expect(gitSafeDirectoryArgs(undefined)).toEqual([])
      expect(gitSafeDirectoryArgs('')).toEqual([])
      expect(gitSafeDirectoryArgs('   ')).toEqual([])
    })
  })

  it('别名 gitSafeDirectoryArgsForRepo 与主函数一致（同一语义，两个入口）', () => {
    withPlatform('win32', () => {
      expect(gitSafeDirectoryArgsForRepo('F:\\work\\agent')).toEqual(gitSafeDirectoryArgs('F:\\work\\agent'))
    })
    withPlatform('darwin', () => {
      expect(gitSafeDirectoryArgsForRepo('/tmp/ws')).toEqual([])
    })
  })
})
