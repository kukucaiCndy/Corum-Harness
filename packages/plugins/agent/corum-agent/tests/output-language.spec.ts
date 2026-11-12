/**
 * 输出语言段验证（2026-09-15 用户需求）。
 *
 * 用户裁定原文：「我需要**中英文都支持**，并且当用户**选择中文作为母语**时，要求**模型
 * 最终的回复和思考过程的摘要都应该是用户选择的语言**（对于**提示词/思考过程不做要求**，
 * 某些模型确实**英文语料训练的比较多**。**仅在关键结论、输出做要求**）。」
 *
 * 故本测试的**核心是守住那条边界**：约束必须**只落在对外输出**上，**绝不能**写成
 * 「全程用该语言」——否则会强迫英文语料更强的模型用中文思考，正好违背用户意图。
 */
import { describe, expect, it } from 'vitest'
import {
  LOCALE_PREFERENCE_FIELD,
  OUTPUT_LANGUAGE_VARIABLE,
  languageNameOf,
  localeIdFromSection,
  outputLanguageSectionText,
  outputLanguageText,
  outputLanguageVariableValue,
} from '../src/output-language.ts'

describe('语言名映射', () => {
  it('已知语言返回可读名（模型据此产出该语言）', () => {
    expect(languageNameOf('zh')).toContain('Chinese')
    expect(languageNameOf('en')).toBe('English')
    expect(languageNameOf('ja')).toContain('Japanese')
  })

  it('大小写与地区变体归一（BCP 47 宽容）', () => {
    expect(languageNameOf('ZH')).toContain('Chinese')
    expect(languageNameOf('zh-CN')).toContain('Chinese')
    expect(languageNameOf(' zh-tw ')).toContain('Traditional')
  })

  it('未知 id 原样回显（不猜、不编造语言名）', () => {
    expect(languageNameOf('xx-YY')).toBe('xx-YY')
  })
})

describe('locale 段读取（宽容，绝不抛错）', () => {
  it('取 preference 字段', () => {
    expect(localeIdFromSection({ [LOCALE_PREFERENCE_FIELD]: 'zh' })).toBe('zh')
  })

  it('未设置 / 空串 / 结构不符 ⇒ undefined', () => {
    expect(localeIdFromSection({})).toBeUndefined()
    expect(localeIdFromSection({ [LOCALE_PREFERENCE_FIELD]: '' })).toBeUndefined()
    expect(localeIdFromSection({ [LOCALE_PREFERENCE_FIELD]: '   ' })).toBeUndefined()
    expect(localeIdFromSection({ [LOCALE_PREFERENCE_FIELD]: 42 })).toBeUndefined()
    expect(localeIdFromSection(undefined)).toBeUndefined()
    expect(localeIdFromSection(null)).toBeUndefined()
    expect(localeIdFromSection('zh')).toBeUndefined()
    expect(localeIdFromSection([])).toBeUndefined()
  })
})

describe('占位符机制（用户要求：按 setting 变化组装）', () => {
  it('段文本是**静态**的，语言部分写成 {{output_language}} 占位符', () => {
    const t = outputLanguageSectionText()
    expect(t).toContain(`{{${OUTPUT_LANGUAGE_VARIABLE}}}`)
    // 静态：**不掺杂任何具体语言名**（语言名只出现在变量值里）——
    // 换言之换语言时段文本应逐字节不变。
    expect(t).not.toContain('Simplified Chinese')
    expect(t).not.toContain('Traditional Chinese')
    expect(t).toBe(outputLanguageSectionText())
  })

  it('变量名合法（官方 VARIABLE_NAME 要求 [a-z][a-z0-9_]*）', () => {
    expect(OUTPUT_LANGUAGE_VARIABLE).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('**变量值恒为 string**——绝不返回 undefined（严格插值会抛错）', () => {
    for (const v of ['zh', 'en', '', '   ', undefined, 'xx-YY']) {
      expect(typeof outputLanguageVariableValue(v as string | undefined)).toBe('string')
      expect(outputLanguageVariableValue(v as string | undefined).length).toBeGreaterThan(0)
    }
  })

  it('无偏好时给出可读回退（「not specified」——规则本体在段文本第一条，不在这里复述）', () => {
    // 2026-11-12c T2-6：回退值由「not specified — follow the rule above: if the user's messages
    // are in a particular language, reply in that language」压成「not specified」——第一条规则
    // 自足（match the language of their latest message），变量位置不再整句复述。
    const v = outputLanguageVariableValue(undefined)
    expect(v).toMatch(/not specified/i)
    expect(v).toBe('not specified')
    // 回退值不得把「匹配用户语言」这条规则复制进变量值（单一事实源在段文本）。
    expect(v).not.toMatch(/reply in that language/i)
  })

  it('有偏好时变量值含该语言名', () => {
    expect(outputLanguageVariableValue('zh')).toContain('Simplified Chinese')
    expect(outputLanguageVariableValue('en')).toContain('English')
  })

  it('outputLanguageText == 占位符插值结果（与真实组装逐字一致）', () => {
    for (const id of ['zh', 'en', undefined]) {
      expect(outputLanguageText(id)).toBe(
        outputLanguageSectionText().replaceAll(`{{${OUTPUT_LANGUAGE_VARIABLE}}}`, outputLanguageVariableValue(id)),
      )
      expect(outputLanguageText(id)).not.toContain('{{')
    }
  })
})

describe('段文本：**边界**必须只有对外输出被约束', () => {
  const text = outputLanguageText('zh')

  it('要求最终回复用该语言', () => {
    expect(text).toMatch(/final answer/i)
    expect(text).toContain('Simplified Chinese')
  })

  it('要求「对用户可见的推理摘要」也用该语言（用户补充的那一点）', () => {
    expect(text).toMatch(/summary|narration/i)
    expect(text).toMatch(/reasoning/i)
  })

  it('**明确放行内部推理**——不得写成「全程用该语言」', () => {
    // 这是本需求最关键的一条：用户要的是「可以用英文思考」
    expect(text).toMatch(/thinking/i)
    expect(text).toMatch(/NOT constrained/i)
    // 2026-11-12c T2-6：删掉理据括注 (English is often stronger for some models) 后，
    // 「放行内部推理」的行为条款本身仍是落点（think in whatever language gives you the best results）。
    expect(text).toMatch(/think in whatever language gives you the best results/i)
  })

  it('明确不翻译代码/标识符/命令/错误输出（否则模型会把代码也翻掉）', () => {
    expect(text).toMatch(/[Dd]o not translate/)
    expect(text).toMatch(/verbatim/)
  })

  it('en 偏好时文本指向 English（同一模板、只换语言名）', () => {
    const en = outputLanguageText('en')
    expect(en).toContain('English')
    expect(en).toMatch(/final answer/i)
    expect(en).toMatch(/NOT constrained/i)
  })
})
