/**
 * fork（corum）：配额/限流类失败的识别（issue #230，2026-11-13）。
 *
 * ## 为什么需要
 *
 * 阿里云 Model Studio 的**暂时性 TPM 限流**（官方分类 Throttling.AllocationQuota，
 * 等待后可重试）与**终态余额耗尽**共用 `insufficient_quota` 码串；基座分类器
 * （dsh-llm `isQuotaExceededError`）先命中配额正则，把限流判成终态 `QUOTA`，
 * 自动重试码表（RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE）不覆盖它。
 * 用户看到的是裸 JSON「429 insufficient_quota…」，极易误读为「输入过长」
 * （真正的上下文溢出是 400 + input length 措辞，另一条分类路径）。
 *
 * 本模块只做**展示层识别**：把分类码与供应商措辞映射成可操作提示的类别，
 * 不改分类、不加重试（那属基座/供应商配置层）。原始错误在 UI 里折叠保留。
 *
 * @module corum-ui-chat/failure-kind
 */

/** 配额/限流的供应商措辞兜底（分类码缺失或为供应商原始码时）。 */
const QUOTA_WORDING = /insufficient[\s_-]+quota|allocated quota exceeded|quota[\s_-]+(?:exceeded|exhausted|reached)/i
const RATE_LIMIT_WORDING = /rate[\s_-]?limit|\b429\b|throttling/i

/** 展示层失败类别：quota=配额受限（可能暂时也可能终态），rateLimit=速率限制（暂时性）。 */
export type FailureKind = 'quota' | 'rateLimit'

/**
 * 识别配额/限流类失败。分类码优先（基座 canonical code），措辞兜底。
 * @param code - turn/end 失败携带的分类码（可能缺失或为供应商原始码）。
 * @param message - 失败消息文本。
 * @returns 类别；非配额/限流失败返回 undefined。
 */
export function failureKind(code: unknown, message: string): FailureKind | undefined {
  if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') return 'quota'
  if (code === 'RATE_LIMIT') return 'rateLimit'
  if (QUOTA_WORDING.test(message)) return 'quota'
  if (RATE_LIMIT_WORDING.test(message)) return 'rateLimit'
  return undefined
}