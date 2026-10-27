/**
 * fork（corum）：**输出语言段**——把「用户的母语是什么」作为**事实**注入系统提示词，
 * 让模型的**最终回复**与**对用户可见的思考摘要**使用用户所选语言（2026-09-15 用户需求）。
 *
 * ## 用户裁定的边界（照抄，别自行扩大）
 *
 * 用户原话：「我需要**中英文都支持**，并且当用户**选择中文作为母语**时，要求**模型最终的
 * 回复和思考过程的摘要都应该是用户选择的语言**（对于**提示词/思考过程不做要求**，
 * 某些模型确实**英文语料训练的比较多**。**仅在关键结论、输出做要求**）。」
 *
 * 故约束**只落在「对用户可见的输出面」**：
 *   · ✅ **最终回复** —— 必须用用户语言；
 *   · ✅ **思考过程的摘要/可见段落** —— 必须用用户语言（用户补充：「有些模型会在思考后
 *     返回一些段落，这些段落可以让 LLM 输出中文」）；
 *   · ❌ **内部推理（thinking）与提示词本身** —— **不限制**。英文语料更强的模型用英文
 *     思考质量更好，强行要求反而降质。措辞里必须写明这一点，否则模型会过度泛化。
 *
 * ## 语言来源
 *
 * 读官方 locale 设置（settings ns `locale`、字段 `preference`，见
 * `@deepseek-ai/dsh-client-locale`）。它与界面语言**同源**——用户「选择的语言」既是界面
 * 语言也是交流语言，符合用户原话「用户**选择的**语言」。
 *
 * 未设置时**不注入本段**（保持各 profile 原有措辞；英文用户的模型自然会用英文）。
 *
 * ## 为什么用 `{{output_language}}` **占位符**注册（而非把文本算好塞进段里）
 *
 * 走官方 `systemPrompt.variable(name, provider)` 机制——与 `{{model}}`
 * **同一套**（`dsh-agent-loop/src/index.ts:421-423` 注册那两个；corum 的 profile
 * persona 模板里也一直在用 `{{model}}`，见 `compile.ts:304-309`）。
 * 理由：
 *   1. **按 setting 变化组装**（用户要求）：provider **每次组装时求值**
 *      （`VariableProvider = (context) => string | undefined`），
 *      用户在设置里改语言 ⇒ 下一次组装即用新值，**不缓存、不重启**；
 *   2. **与既有通路一致**：模型看到的仍是同一套变量插值，不引入第二套「动态文本」机制；
 *   3. **可被 profile 模板复用**：任何 profile 的 persona 都能写 `{{output_language}}`
 *      （本段文本即「用户母语是什么」的完整交代），而不是只有本段能用到。
 *
 * ⚠️ **严格插值约束**（实测 `dsh-system-prompt/src/index.ts:334-339`）：
 * 变量值若为 `undefined`，**组装会抛错**（`prompt variable "{{…}}" has no value`）。
 * 故 provider **绝不能返回 `undefined`** —— 未设语言偏好时返回**空串**（安全空值），
 * 由段文本里的空值分支处理（见 {@link OUTPUT_LANGUAGE_SECTION_TEXT}）。
 *
 * `systemPrompt.section` 的 `text` 同样支持函数形态，两条路都能「按组装求值」；
 * 此处选占位符是因为用户明确要求「**这个 language 要用占位符**」，
 * 且它让上述第 3 点（profile 模板可用）成立。
 *
 * @module @corum/corum-agent/output-language
 */

/** 输出语言段的段名（root scope；所有 corum 会话继承）。 */
export const OUTPUT_LANGUAGE_SECTION = 'corum:output-language'

/**
 * 语言变量的**引用名**（在段文本/persona 模板里写作 `{{output_language}}`）。
 * 需匹配官方 `VARIABLE_NAME`（`[a-z][a-z0-9_]*`）。
 */
export const OUTPUT_LANGUAGE_VARIABLE = 'output_language'

/** 官方 locale 设置命名空间（与 `@deepseek-ai/dsh-client-locale` 同源）。 */
export const LOCALE_SETTINGS_NAMESPACE = 'locale'

/** 官方 locale 设置里承载所选语言的字段名。 */
export const LOCALE_PREFERENCE_FIELD = 'preference'

/** 语言 id → 给模型看的语言名（模型要能据此产出该语言文本）。 */
const LANGUAGE_NAMES: Record<string, string> = {
  zh: 'Simplified Chinese (简体中文)',
  'zh-cn': 'Simplified Chinese (简体中文)',
  'zh-hans': 'Simplified Chinese (简体中文)',
  'zh-tw': 'Traditional Chinese (繁體中文)',
  'zh-hant': 'Traditional Chinese (繁體中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
  es: 'Spanish (Español)',
  ru: 'Russian (Русский)',
  pt: 'Portuguese (Português)',
}

/**
 * 语言 id → 可读语言名（未知 id 原样回显，让模型自己理解，不猜）。
 * @param localeId - BCP 47 风格的语言 id（如 `zh` / `en` / `zh-CN`）。
 * @returns 给模型看的语言名。
 */
export function languageNameOf(localeId: string): string {
  const key = localeId.trim().toLowerCase()
  return LANGUAGE_NAMES[key] ?? localeId
}

/**
 * 构造输出语言段的文本（**含 `{{output_language}}` 占位符**）。
 *
 * **措辞纪律**（重要，别删这几条约束）：
 *   1. 明确**只约束对外输出**（final answer + 可见摘要），**不约束内部推理**——
 *      理由（英文语料更强）写明，避免模型过度泛化到整条链路；
 *   2. 明确「**不要求翻译**」——提示词、工具名、代码标识符、命令、错误原文保持原样，
 *      只要求**自然语言叙述**用该语言（否则模型会把代码注释/命令也翻译掉）；
 *   3. 措辞是**指示**而非可选项（用户要求「**要求**模型…」），但不写成「违反即失败」
 *      那种压迫式表述——这是在软约束与不干扰工作之间取平衡。
 *
 * @returns 段文本（**静态**，语言部分由 `{{output_language}}` 占位符在组装时插入）。
 */
export function outputLanguageSectionText(): string {
  return [
    'OUTPUT LANGUAGE',
    // 2026-09-27 修（用户报障：要求母语输出但多数仍英文）：原文本第一条依赖**变量值**，
    // 而变量的语言偏好存在客户端（主机读不到 settings.locale）⇒ 回退成软条件 ⇒ 模型照英文走。
    // 现在把「匹配用户语言」提升为**正文第一条规则**（自足、不依赖偏好是否存在）；
    // 偏好只在**指名了语言**时覆盖它。措辞仍保持静态（不出现具体语言名，守卫会检查）。
    '- **Your final answer to the user must be in the language the user writes in**: match the language of their latest message.',
    `- Configured preference (overrides the line above when it names a language): {{${OUTPUT_LANGUAGE_VARIABLE}}}`,
    `- When you surface a summary or narration of your reasoning to the user, write that in the same language as well — the user must be able to read what you did without translating.`,
    `- Your internal reasoning (thinking), your prompts, and tool arguments are NOT constrained: think in whatever language gives you the best results (English is often stronger for some models). Only the text the user reads must follow the language above.`,
    `- Do not translate code, identifiers, commands, file paths, or error output — keep them verbatim; only the natural-language prose around them follows that language.`,
  ].join('\n')
}

/**
 * 供 `{{output_language}}` 占位符使用的**变量值**：把语言 id 说成人话。
 *
 * ⚠️ **绝不返回 `undefined`**（严格插值会抛错，见模块头的约束说明）。
 * 未设偏好时返回一句「未指定语言」，让上面的段文本仍然是一句**自洽的指示**
 * （「the user's language is not specified」+ 后续条款指向「上面的语言」，
 * 语义仍然成立），而不是留下半个空句子或让组装失败。
 *
 * @param localeId - 用户所选语言 id（可为空/未设）。
 * @returns 变量的字符串值（**恒为 string**）。
 */
export function outputLanguageVariableValue(localeId: string | undefined): string {
  if (localeId === undefined || localeId.trim() === '') {
    return "not specified — follow the rule above: if the user's messages are in a particular language, reply in that language"
  }
  return `the user's language is ${languageNameOf(localeId)}`
}

/**
 * 兼容旧签名：给定语言 id 直接产出**完整段文本**（把占位符替换为具体值）。
 *
 * 保留它是为了单测与直接消费方能拿到「最终形态」，与真实组装结果**逐字一致**
 * （`{{name}}` 的插值就是纯字符串替换）。运行期走占位符路径。
 *
 * @param localeId - 用户所选语言 id。
 * @returns 组装后的段文本（未设偏好时也返回完整可读文本）。
 */
export function outputLanguageText(localeId: string | undefined): string {
  return outputLanguageSectionText().replaceAll(
    `{{${OUTPUT_LANGUAGE_VARIABLE}}}`,
    outputLanguageVariableValue(localeId),
  )
}

/**
 * 从 locale 设置段里取语言 id。
 *
 * 宽容读取（设置文档可能未写、写空、或结构不符）：任何异常都视为「无偏好」，
 * 不让一个可选的用户偏好阻断会话组装。
 * @param section - `settings.get()` 风格的 locale 段（未知形）。
 * @returns 语言 id；无有效偏好时 `undefined`。
 */
export function localeIdFromSection(section: unknown): string | undefined {
  if (section === null || typeof section !== 'object') return undefined
  const raw = (section as Record<string, unknown>)[LOCALE_PREFERENCE_FIELD]
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}
