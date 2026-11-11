/**
 * 官方五模式的**显示名对账**（同一个模式，两个界面必须同一个名字）。
 *
 * ## 事故（2026-11-11 用户报障「五个内置的模式有些又显示为英文了，比如标准模式」）
 *
 * 用户在新建会话的 Agent 下拉/输入框胶囊上看到的是裸 `standard`。根因不是某处文案漏翻，
 * 而是**同一条显示链上没有中文可拿**：官方 `dsh-agent-preset` 行的 config 里没有 `name`
 * （rc3 的 standard/ptc/minimal/cordis 与本仓 `presets.patch.yml` 的覆盖行都没写），
 * registry 返回 `name: undefined`，而 UI 的显示名口径是 `nickname ?? title ?? id`
 * ⇒ 两个元数据都缺就直落 id。
 *
 * 修法有两半，缺一半就会复发：
 *   ① host 侧 `OFFICIAL_MODE_LABELS`（corum-agent）把五个 id 译成中文交给显示链；
 *   ② 这张表必须与设置页 `OFFICIAL_MODE_META`（corum-ide-ui 的 Agent 预设页）**逐条一致**
 *      ——那边早就有中文标签，只是没有任何一处对账把它们绑在一起，于是同一个模式在
 *      「继承模板卡片」叫标准模式、在「当前会话跑的是谁」叫 standard。
 *
 * 本测试就是那根绑绳：任一侧改了文案却忘了另一侧，这里直接红。用**读源码文本**而不是
 * import 两个包——`corum-ide-ui` 是 client bundle（有 React/CSS 依赖），host 单测不该把它
 * 拖进来；文案是常量字面量，文本对账足够且不会因构建顺序失效。
 *
 * @module @corum/corum-agent/tests/official-mode-labels
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONDUCTOR_MODE_LABEL, CONDUCTOR_PRESET_ID } from '../src/conductor.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT_SERVICE = join(HERE, '..', 'src', 'agent-service.ts')
const PRESETS_SETTINGS = join(
  HERE, '..', '..', '..', 'ui', 'corum-ide-ui', 'src', 'client', 'settings', 'sections',
  'SettingsAgentPresetsSection.tsx',
)

/** 五个官方基础模式的 id（= 设置页展示的五张「继承模板」卡）。 */
const OFFICIAL_MODE_IDS = ['standard', CONDUCTOR_PRESET_ID, 'ptc', 'minimal', 'cordis'] as const

/**
 * 从源码里截出一段 `const <name> … = { … }` 的对象字面量文本。
 * @param source - 文件原文。
 * @param name - 常量名。
 * @returns 花括号内的文本；找不到抛错（改名后本测试应当红，而不是静默跳过）。
 */
function objectLiteral(source: string, name: string): string {
  const start = source.indexOf(`const ${name}`)
  if (start < 0) throw new Error(`"${name}" not found in source — did the constant get renamed?`)
  const open = source.indexOf('{', start)
  const close = source.indexOf('\n}', open)
  if (open < 0 || close < 0) throw new Error(`"${name}" has no object literal body`)
  return source.slice(open + 1, close)
}

/** 解析 `id: '中文'` 形态的字面量条目（agent-service 的 OFFICIAL_MODE_LABELS）。 */
function literalLabels(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of body.matchAll(/([a-z][a-z-]*)\s*:\s*'([^']*)'/g)) out[match[1]!] = match[2]!
  return out
}

/** 解析 `id: { label: '中文', … }` 形态的条目（设置页的 OFFICIAL_MODE_META）。 */
function uiModeLabels(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of body.matchAll(/([a-z][a-z-]*)\s*:\s*\{\s*label:\s*'([^']*)'/g)) out[match[1]!] = match[2]!
  return out
}

describe('官方五模式的显示名（host 标签表 × 设置页卡片）', () => {
  const hostLabels = literalLabels(objectLiteral(readFileSync(AGENT_SERVICE, 'utf8'), 'OFFICIAL_MODE_LABELS'))
  const uiLabels = uiModeLabels(objectLiteral(readFileSync(PRESETS_SETTINGS, 'utf8'), 'OFFICIAL_MODE_META'))

  it('host 侧标签表覆盖除 conductor 外的四个模式（conductor 走 CONDUCTOR_MODE_LABEL）', () => {
    expect(Object.keys(hostLabels).sort()).toEqual(['cordis', 'minimal', 'ptc', 'standard'])
  })

  it('设置页的五张官方卡片文案齐全', () => {
    expect(Object.keys(uiLabels).sort()).toEqual([...OFFICIAL_MODE_IDS].sort())
  })

  it.each(['standard', 'ptc', 'minimal', 'cordis'] as const)('「%s」两侧同名', (id) => {
    expect(hostLabels[id]).toBe(uiLabels[id])
  })

  it('指挥模式两侧都等于 CONDUCTOR_MODE_LABEL（单一事实源在 conductor.ts）', () => {
    expect(uiLabels[CONDUCTOR_PRESET_ID]).toBe(CONDUCTOR_MODE_LABEL)
    expect(CONDUCTOR_MODE_LABEL).toBe('指挥模式')
  })

  it('五个模式都有中文名，没有一个是裸 id（回归事故形态）', () => {
    for (const id of OFFICIAL_MODE_IDS) {
      const label = id === CONDUCTOR_PRESET_ID ? CONDUCTOR_MODE_LABEL : hostLabels[id]
      expect(label, `official mode "${id}" has no Chinese label`).toBeDefined()
      expect(label).not.toBe(id)
    }
  })
})