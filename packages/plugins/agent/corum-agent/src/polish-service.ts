/**
 * fork（corum）：**AI 润色 / 翻译**能力——从 `agent-service.ts` 按关注点抽出（2026-09-20）。
 *
 * ## 为什么独立成文件
 *
 * 用户 2026-09-20 定调：「整个 `agent-service` 混入了太多业务能力。我们可以以一个**整包插件**
 * 为载体装载这些能力，但是各个模块**至少要在文件层面切分清晰**，方便维护。甚至可以将基本的
 * Agent 能力和权限等完全解耦，做成两个甚至多个插件，**比如提示词润色这种其实就可以单独拆出来**。」
 *
 * 润色与 Agent 生命周期/权限/泳道编排**零耦合**：它只依赖「润色配置 + 一个模型端点」，
 * 是最干净的可抽簇。抽走后 `agent-service.ts` 只剩 5 个薄的 `@Remote` 转发
 * （RPC 面与 contract 完全不变 ⇒ UI 零改动）。
 *
 * ## 模块边界
 *
 * - **进**：`Context`（只用于 `ctx.get('llm')` / `ctx.get('localLlm')`）、`PolishConfig`。
 * - **出**：润色/翻译文本、`PolishConversationResult`。
 * - **不碰**：会话、Agent、沙箱、权限、profile 编译 —— 本模块对它们一无所知。
 *
 * @module @corum/corum-agent/polish-service
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { loadPolishConfig, type PolishConfig } from './profile-store.ts'

/** getPolishConfig 返回：润色配置（未配置为 null）。 */
export interface GetPolishConfigResult {
  config: {
    provider: string
    model: string
    engine?: string
    localModel?: string
    reasoningEffort?: string
  } | null
}

/** polishPrompt 返回：润色后文本。 */
export interface PolishPromptResult {
  polished: string
}

/** polishConversation 返回：润色后文本 + 意图（continue/new-topic/bug-report/other/unknown）。 */
export interface PolishConversationResult {
  polished: string
  intent: string
}

/** translatePrompt 返回：译文。 */
export interface TranslatePromptResult {
  translated: string
}

/**
 * 解析润色模型的 JSON 信封（polishConversation）。
 * 模型常把 JSON 包在 ```json 代码块或前后加解释文字里，故先抓第一个平衡的 `{...}`。
 * 解析失败返回 null（调用方回落「整段即润色结果」）。
 * @param raw - 模型原始输出。
 * @returns 解析结果；失败为 null。
 */
export function parsePolishEnvelope(raw: string): PolishConversationResult | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { polished?: unknown; intent?: unknown }
    if (typeof parsed.polished !== 'string' || parsed.polished.trim() === '') return null
    return {
      polished: parsed.polished.trim(),
      intent: typeof parsed.intent === 'string' && parsed.intent.trim() !== '' ? parsed.intent.trim() : 'unknown',
    }
  } catch {
    return null
  }
}

/** 取润色配置；未配置时抛错（客户端把错误显示成「请先配置润色模型」）。 */
export function requirePolishConfig(): PolishConfig {
  const config = loadPolishConfig()
  if (config === undefined) {
    throw new Error('未配置 AI 润色模型：请在「设置 → 扩展 → AI 润色」选择引擎与模型')
  }
  return config
}

/** 本地 LLM 服务的能力面（只取本模块用到的三个方法）。 */
interface LocalLlmFace {
  status: () => Promise<{
    installed: boolean
    running: boolean
    meetsMinMem: boolean
    models: Array<{ name: string; active?: boolean }>
  }>
  ensureServer: () => Promise<{ ok: boolean; error?: string }>
  chat: (options: { model: string; prompt: string; temperature?: number; numPredict?: number }) => Promise<{ text: string }>
}

/** 线上 LLM 服务的能力面（只取 stream）。 */
interface LlmFace {
  stream: (request: unknown) => AsyncIterable<unknown>
}

/**
 * 一次润色调用（引擎路由 + 单次补全）。本地失败时：
 * engine=local 明确指定 → 抛错；engine=auto → 回落线上（本地只是加速项）。
 *
 * @param ctx - 承载 `llm` / `localLlm` 服务的上下文。
 * @param config - 润色配置（引擎与模型选择）。
 * @param system - system 提示词。
 * @param prompt - 待处理文本。
 * @returns 模型输出原文（调用方自行 trim / 解析信封）。
 */
export async function runPolishEngine(
  ctx: Context,
  config: PolishConfig,
  system: string,
  prompt: string,
  /**
   * 调用级覆盖（可选）。
   *
   * 为什么需要它（2026-10-11 实机）：默认 `maxTokens: 1024` 对**推理型模型**不够——
   * 发布流程里用 `kimi-k3-1`（reasoning high）补全 MCP 安装说明时，模型把整个 1024 的
   * 预算花在思维链上，**一个文本块都没产出** ⇒ 解析拿到的 raw 是空串 ⇒ 用户只看到
   * 「Agent 未能确认」而没有任何可actionable的原因。
   * 故允许调用方给这类"要结构化输出"的调用加大预算并关掉推理（off = 直接答）。
   * 缺省不传 = 与既有润色/翻译行为完全一致（那条路不该被本参数改变）。
   */
  override?: { readonly maxTokens?: number; readonly reasoningEffort?: string },
): Promise<string> {
  const engine = config.engine ?? 'auto'
  if (engine !== 'online') {
    const local = ctx.get('localLlm' as never) as unknown as LocalLlmFace | undefined
    if (local === undefined) {
      if (engine === 'local') throw new Error('本地引擎不可用：请先在「设置 → 扩展 → Ollama」安装并下载模型')
    } else {
      try {
        const status = await local.status()
        // 严格已激活（用户定调 2026-09-09）：只有加载到内存的模型才用于润色——
        // 未激活模型首次调用要冷加载，可用性没保证，auto 档也不该挑它。
        const activated = status.models.filter(m => m.active === true)
        const usable = status.installed && status.running && status.meetsMinMem && activated.length > 0
        if (engine === 'local' || usable) {
          const ensured = status.running ? { ok: true } : await local.ensureServer()
          if (!ensured.ok) {
            throw new Error(ensured.error ?? '本地引擎启动失败')
          }
          // 模型选择：配置值必须在**已激活**集合里（可能已被停止/卸载），否则回落
          // 第一个已激活模型——与设置页下拉的语义一致（不手填模型 id）。
          const configured = config.localModel === undefined
            ? undefined
            : activated.find(m => m.name === config.localModel)
          const model = (configured ?? activated[0])?.name ?? ''
          if (model === '') {
            throw new Error('本地引擎没有已激活的模型：请在「设置 → 扩展 → Ollama」激活一个模型（未激活的模型不进润色候选）')
          }
          const out = await local.chat({ model, prompt: `${system}\n\n${prompt}`, temperature: 0.2, numPredict: 1024 })
          if (out.text.trim() !== '') return out.text
          throw new Error('本地模型返回空结果')
        }
      } catch (error) {
        if (engine === 'local') throw error
        // auto：本地不可用时静默回落线上。
      }
    }
  }
  return await generateOnline(ctx, config, system, prompt, override)
}

/** 线上一次性补全（ctx.llm.stream + BlockAssembler，与官方 compaction 同法）。 */
async function generateOnline(
  ctx: Context,
  config: PolishConfig,
  system: string,
  prompt: string,
  override?: { readonly maxTokens?: number; readonly reasoningEffort?: string },
): Promise<string> {
  const llm = ctx.get('llm' as never) as unknown as LlmFace | undefined
  if (llm === undefined) throw new Error('llm 服务不可用（无法调用线上模型）')
  const assembler = new BlockAssembler()
  const effort = override?.reasoningEffort ?? config.reasoningEffort
  for await (const chunk of llm.stream({
    provider: config.provider,
    model: config.model,
    ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    system,
    messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'corum-agent' } })],
    temperature: 0.2,
    maxTokens: override?.maxTokens ?? 1024,
  })) {
    assembler.push(chunk as never)
  }
  return assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** polishPrompt 的 system 提示词（kind 给模型一点体裁提示）。 */
export function polishPromptSystem(kind: string): string {
  return [
    'You are a prompt-polishing assistant. Rewrite the text the user gives you so it is clearer, more specific, and easier for an AI to execute,',
    'Preserve the original meaning and language (Chinese in, Chinese out; English in, English out). Do not answer the question, do not explain, and do not add any prefix or suffix.',
    `Text kind: ${kind}. Output only the polished text itself.`,
  ].join(' ')
}

/** polishConversation 的 system 提示词（JSON 信封协议）。 */
export function polishConversationSystem(): string {
  return [
    'You are a prompt-polishing assistant. You are given the recent conversation context and the draft the user just typed.',
    'Rewrite the draft into input that states its intent clearly, flows with the context, and can be executed by an AI directly:',
    'Fill in omitted references and make vague requests concrete, but do **not** make decisions for the user and do not add requirements the user did not state.',
    "Keep the user's language.",
    'Output exactly one JSON object, with no markdown code fence and no extra text, shaped like:',
    '{"polished":"the polished text","intent":"continue|new-topic|bug-report|other"}',
  ].join(' ')
}

/** translatePrompt 的 system 提示词。 */
export function translatePromptSystem(): string {
  return [
    'You are a translation assistant. Translate Chinese into English, English into Chinese, and any other language into Chinese.',
    'Output only the translation itself: no explanation and no quotation marks.',
  ].join(' ')
}
