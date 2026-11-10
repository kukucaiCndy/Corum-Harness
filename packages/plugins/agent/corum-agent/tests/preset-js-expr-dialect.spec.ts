/**
 * 用户 preset 的 `!!js` 方言 —— 「标准模式没有 bash」的直接根因守卫（2026-11-11）。
 *
 * ## 实测证据（同一台机、同一构建、同一 host，只换 preset）
 *
 * | 会话 | `agentPreset` | 工具目录里有 `bash` |
 * | --- | --- | --- |
 * | `corum-task-452a5fe8` | `standard`（**官方** preset，走 bundle 的 `dsh-agent-preset` 行） | **有** |
 * | `corum-task-201d5795` | `standard-mode`（corum 自建，读 `.agent-presets/<id>/agent.cordis.yml`） | **没有** |
 * | `corum-task-3eb0c476` | `minimal-assistant`（同上） | **没有** |
 * | `corum-task-e4e9b1d1` | `android-app-engineer`（同上） | **没有** |
 *
 * 判据取的是**会话日志里模型收到的请求头**：`corum-task-452a5fe8` 的 `tools[]` 含
 * `"name":"bash"`，其余三个只到 `write`（read / glob / grep / edit / web_* / todo /
 * present / subagent / cdp_* 都在，单单没有 shell）。用户口径：「标准模式没有 bash
 * 是很离谱的一个 BUG」。
 *
 * ## 根因
 *
 * `compile.ts` 把行写成官方 entry-list 方言：`disabled: !!js process.platform === 'win32'`、
 * `cwd: !!js process.env.DSH_CWD ?? process.cwd()`。`preset-registration.ts` 用裸
 * `yaml.parse` 读回来时，`tag:yaml.org,2002:js` 是**未知标签** ⇒ 节点降级为**字符串**
 * （运行日志里就是成串的 `TAG_RESOLVE_FAILED … Unresolved tag: tag:yaml.org,2002:js`）：
 *
 * · `disabled` = `"process.platform === 'win32'"` ⇒ 非空字符串 ⇒ **真值** ⇒ 行被禁用；
 * · 于是 `tool-bash`（darwin 上本该启用）与 `tool-pwsh` 一起消失 ⇒ **没有 shell**；
 * · 附带损伤：`config.cwd` 成了字符串字面量而不是表达式。
 *
 * 修法：用同一个 `!!js` 标签解析，产出 loader 认的表达式标记 `{ __jsExpr }`
 * （`@deepseek-ai/cordis-plugin-loader` 的 `isJsExpr` 只判这个字段），由 loader 在行
 * 激活时求值 —— 与官方 patch / preset 完全同语义。
 *
 * ## 这里钉住什么
 *
 * ① `disabled: !!js …` 解成**表达式标记**（不是字符串、更不是 `true`）；
 * ② 该标记能被 loader 自己的 `isJsExpr` 认出（否则 loader 会把它当普通对象/真值）；
 * ③ `config` 里的 `!!js` 同样解成标记；
 * ④ 普通布尔/字符串/null 不受影响；
 * ⑤ 源码不变式：`preset-registration.ts` **不得**再出现裸 `parseYaml(` 调用
 *    （防回退成「标准模式又没 bash」）。
 * @module @corum/corum-agent/tests/preset-js-expr-dialect
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import { parsePresetYaml } from '../src/preset-registration.ts'

/** compile.ts 的 standardRows 里真实写出的两行（逐字取自 `compile.ts`）。 */
const STANDARD_SHELL_ROWS = `
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'
`

describe('parsePresetYaml — !!js 按官方方言解析', () => {
  it('★ disabled: !!js … 解成表达式标记（不是字符串、不是 true）', () => {
    const rows = parsePresetYaml(STANDARD_SHELL_ROWS) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    const bash = rows[0] as { id: string, disabled: unknown }
    expect(bash.id).toBe('tool-bash')
    expect(typeof bash.disabled).toBe('object')
    expect(bash.disabled).toEqual({ __jsExpr: "process.platform === 'win32'" })
    // 事故形态就是「字符串」：非空字符串 = 真值 = 行被禁用。
    expect(typeof bash.disabled).not.toBe('string')
  })

  it('★ 标记能被 loader 的 isJsExpr 认出（否则 loader 仍按原值处理）', () => {
    const rows = parsePresetYaml(STANDARD_SHELL_ROWS) as Array<Record<string, unknown>>
    expect(isJsExpr(rows[0]?.disabled)).toBe(true)
    expect(isJsExpr(rows[1]?.disabled)).toBe(true)
  })

  it('config 里的 !!js 也解成标记（cwd 不再退化成字面量）', () => {
    const rows = parsePresetYaml(`
- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: !!js process.env.DSH_CWD ?? process.cwd()
`) as Array<{ config: { cwd: unknown } }>
    expect(rows[0]?.config.cwd).toEqual({ __jsExpr: 'process.env.DSH_CWD ?? process.cwd()' })
    expect(isJsExpr(rows[0]?.config.cwd)).toBe(true)
  })

  it('普通标量不受影响（布尔/字符串/null 保持原义）', () => {
    const rows = parsePresetYaml(`
- id: a
  disabled: true
- id: b
  name: '@x/y'
- id: c
  config:
    n: null
`) as Array<Record<string, unknown>>
    expect(rows[0]?.disabled).toBe(true)
    expect(rows[1]?.name).toBe('@x/y')
    expect((rows[2]?.config as { n: unknown }).n).toBeNull()
  })
})

describe('源码不变式 — 不许再出现裸解析', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/preset-registration.ts'),
    'utf8',
  )

  it('★ 每一处解析都走 parsePresetYaml（裸 parseYaml 即回归）', () => {
    const bare = [...source.matchAll(/(?<!export function )\bparseYaml\(/g)]
    expect(bare).toHaveLength(1) // 只剩 parsePresetYaml 自己那一处
    expect(source).toMatch(/export function parsePresetYaml\(text: string\): unknown \{\s*\n\s*return parseYaml\(text, \{ customTags: JS_EXPRESSION_TAGS \}\)/)
    // 事故原样：`parseYaml(cordisRaw.toString('utf8'))`
    expect(source).not.toContain("parseYaml(cordisRaw.toString('utf8'))")
    expect(source).not.toContain("parseYaml(raw.toString('utf8'))")
  })

  it('!!js 标签常量指向官方的 tag:yaml.org,2002:js', () => {
    expect(source).toContain("const JS_EXPRESSION_TAG = 'tag:yaml.org,2002:js'")
  })
})
