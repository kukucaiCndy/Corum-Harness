/**
 * 内置的 DeepSeek 子 provider —— 聚合 provider 的**默认**激活项。
 *
 * ## 为什么直接实例化官方类
 *
 * 官方 `@deepseek-ai/dsh-web-search-deepseek` 把 `DeepSeekSearchProvider` 类导出
 * 了（`lib/index.js:306`），而「下一个操作的选项」投影函数 `resolveOptions` 没有
 * 导出（同文件 270-291 是模块私有）。所以这里实例化**同一个类**、只自己写那份投影
 * —— 请求构造、Anthropic Messages 调用、`web_search_20250305` server tool、结果
 * 归一化、错误文案、取消语义全部复用官方实现，corum 不 fork、不 vendor。
 *
 * ## 为什么天然「配了 Key 就能用」
 *
 * 投影读的是**同一个 settings 面** `web-search-deepseek`（官方 provider 行注册的
 * namespace，`WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE`）：
 *   - `apiKeyEnv` / `baseURL` / `model` / `apiVersion` / `maxTokens` / `maxUses`
 *     都从该 section 取值（缺省回落到官方的同一组默认常量）；
 *   - Key 本身仍走 credentials 域 / 启动环境解析（`credentialRef` + `resolve`），
 *     与官方 provider 完全同一条路。
 * ⇒ 用户不需要为本插件新增任何配置项；官方设置面里已有的值直接生效。
 *
 * ⚠️ 已知与官方的**唯一**行为差异：这里的 `recordRequest` 会往当前发起方会话追加
 * 同名的 `web/deepseek-search-llm-request` 事件（与官方逐字一致），但当 `agents`
 * 服务缺席（非 agent 组合）时静默跳过——官方同样如此。
 *
 * @module @corum/corum-web-search/deepseek-sub-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
// Type-only：拉入 `ctx.agents` 的 Context 合并（可观测面 recordRequest 才用得到）。
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekSearchProvider,
  WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE,
} from '@deepseek-ai/dsh-web-search-deepseek'
import type { DeepSeekSearchLlmRequest, DeepSeekSearchProviderOptions } from '@deepseek-ai/dsh-web-search-deepseek'
import type { WebSearchSubProvider } from './types.ts'

/** 聚合 provider 里内置 DeepSeek 子 provider 的注册键（= 默认激活项）。 */
export const DEEPSEEK_SUB_PROVIDER_ID = 'deepseek'

/** 官方 provider 在 section 未声明 `apiKeyEnv` 时解析的凭据引用。 */
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/**
 * 官方 provider 使用的「搜索端点」环境变量。**刻意**与
 * `$DEEPSEEK_BASE_URL` 不同：搜索说的是 Anthropic 兼容的 Messages API，
 * 一个变量不能同时服务两者。
 */
const SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL'

/**
 * `web-search-deepseek` settings section 里本插件消费的字段。
 * 结构与官方 `Config` 同形（此处重声明为可选，因为 namespace 未注册时投影到空对象）。
 */
export interface DeepSeekSearchSection {
  /** 字面 Key（不推荐；优先 `apiKeyEnv`）。 */
  apiKey?: string
  /** 凭据引用；缺省 `DEEPSEEK_API_KEY`。 */
  apiKeyEnv?: string
  /** Anthropic 兼容端点基址。 */
  baseURL?: string
  /** Anthropic 格式模型名。 */
  model?: string
  /** `anthropic-version` 头。 */
  apiVersion?: string
  /** 生成 token 上限。 */
  maxTokens?: number
  /** 单次请求最多搜索次数。 */
  maxUses?: number
}

/** 读取当前 `web-search-deepseek` section（namespace 未注册时空对象）。
 * rc3：`ctx.settings.get(ns)` 已删除——改走 `describe()` 找 namespace 的 value。 */
export function currentDeepSeekSection(ctx: Context): DeepSeekSearchSection {
  const descriptor = ctx.settings.describe().find(d => d.ns === WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE)
  const value = descriptor?.value
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as DeepSeekSearchSection)
    : {}
}

/**
 * 把一个 section 投影成官方 provider 的下一次操作选项。
 *
 * 这是本包**唯一**与官方重复的一小段逻辑（官方 `resolveOptions` 未导出）：
 * 每条取值、每个默认常量都与官方逐字对齐，环境回落也留在这一层
 * （所以 provider 读到的每个值都已经是「完全默认化」的）。
 *
 * @param ctx - 插件 ctx（credentials / launchEnvironment 两个面）。
 * @param section - 当前 section。
 * @returns 官方 `DeepSeekSearchProvider` 构造函数所需的选项。
 */
export function resolveDeepSeekOptions(
  ctx: Context,
  section: DeepSeekSearchSection,
): DeepSeekSearchProviderOptions {
  const declaredRef = section.apiKeyEnv
  const apiKeyEnv = credentialRef(declaredRef !== undefined && declaredRef.length > 0 ? declaredRef : DEFAULT_API_KEY_ENV)
  const literalApiKey = section.apiKey !== undefined && section.apiKey.length > 0 ? section.apiKey : undefined
  return {
    ...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
    resolveApiKey: async () => {
      // credentials 缺席是合法组合（无凭据域），此时按官方语义回落到启动环境。
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: section.baseURL
      ?? launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value
      ?? DEEPSEEK_DEFAULT_BASE_URL,
    model: section.model ?? DEEPSEEK_DEFAULT_MODEL,
    apiVersion: section.apiVersion ?? DEEPSEEK_DEFAULT_API_VERSION,
    maxTokens: positiveIntegerOr(section.maxTokens, DEEPSEEK_DEFAULT_MAX_TOKENS),
    maxUses: positiveIntegerOr(section.maxUses, DEEPSEEK_DEFAULT_MAX_USES),
    recordRequest: (request: DeepSeekSearchLlmRequest) => {
      // 与官方同一句：把「即将发出的、无密钥的」请求记进当前发起方会话（可观测面）。
      ctx.get('agents')?.currentInitiator()?.session.append('web/deepseek-search-llm-request', request)
    },
  }
}

/**
 * 造内置的 DeepSeek 子 provider。
 *
 * 选项是**每次操作现读**的 thunk（与官方同样的理由）：settings section 可以在两次
 * 搜索之间变化，而重注册 provider 会把 seam 的选择过程暴露成一次抖动。
 *
 * @param ctx - 插件 ctx。
 * @returns 可直接注册进聚合 provider 的子 provider。
 */
export function createDeepSeekSubProvider(ctx: Context): WebSearchSubProvider {
  const provider = new DeepSeekSearchProvider(() => resolveDeepSeekOptions(ctx, currentDeepSeekSection(ctx)))
  return {
    id: DEEPSEEK_SUB_PROVIDER_ID,
    label: 'DeepSeek（内置）',
    origin: 'builtin',
    available: () => provider.available(),
    search: (request, signal) => provider.search(request, signal),
  }
}

/** 非正整数的 section 值回落到默认（schema 已约束，这里只防「namespace 未注册」路径）。 */
function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback
}

/** 宽松记录判定（settings 值来自持久化文档，一律先当 unknown）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
