/**
 * 目标准备 —— 每次 run 前把一个供应商 + 模型 + API KEY 配置到被测实例。
 *
 * ## 为什么需要它
 *
 * 用户口径（原话）：
 * > 「配置 API KEY 让模型调用是核心前提…我希望可以配置给 CTS 一个，
 * >   让脚本每次自行配置到目标，这样既有 APIKEY 又可以测试用户配置供应商模型的功能是否 OK」
 *
 * 没有它，被测实例上没有 KEY ⇒ 模型调用一律失败 ⇒ 大量脚本用例的「模型相关功能」
 * 永远跑不了真实路径，只能验证「缺 KEY 时的报错文案」。
 *
 * ## 安全纪律
 *
 * - **绝不存明文 API KEY**：`target-prep.json` 只存 `credentialRef`（一个环境变量名）；
 * - KEY 的值存在**执行端自己的**加密 credentials 存储（`$DSH_HOME/.credentials.yaml`，
 *   AES-256-GCM 加密；Windows DPAPI / macOS Keychain 封主密钥）；
 * - `saveTargetPrep` RPC 携带一次性 `apiKey` 字段 → 经执行端本地 `credentials/set` 写入 →
 *   值不落 JSON、不进日志、不写存档；
 * - 准备时从执行端 credentials 解析值，经目标页内 `fetch` 写到目标实例的
 *   `credentials/set`（同源免鉴权）。
 *
 * ## 顺序纪律（先写 profile 再写 key）
 *
 * 反了会在目标上留孤儿密钥（key 指向一个不存在的 provider）。这与 LESSONS §5.7
 * 「成对写入」同一精神：改字段就一次 op 写字段整体。
 *
 * @module @corum/corum-test-suite-dev/prep-target
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { testSuiteDir } from './storage'
import type { TargetExecutor } from './target'

// ── 类型 ──────────────────────────────────────────────

/** 供应商配置（写入目标的 `llm-pi-ai` settings namespace）。 */
export interface TargetPrepProvider {
  /** 供应商 route（`/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`）。 */
  readonly route: string
  /** 显示名（可选，写入 `displayName`）。 */
  readonly displayName?: string
  /** API 协议（如 `openai-completions`）；写入 provider profile 的 `api` 字段。 */
  readonly api: string
  /** base URL（如 `https://api.deepseek.com`）。 */
  readonly baseURL: string
}

/** 模型条目（写入 provider profile 的 `models` 数组）。 */
export interface TargetPrepModel {
  /** 模型 id（如 `deepseek-chat`）。 */
  readonly id: string
  /** 显示名（可选）。 */
  readonly name?: string
}

/** 目标准备完整配置（存盘形态；不含密钥值）。 */
export interface TargetPrepConfig {
  /** 是否启用；`false` 时三条执行路径静默跳过。 */
  readonly enabled: boolean
  /** 供应商配置。 */
  readonly provider: TargetPrepProvider
  /** 模型列表。 */
  readonly models: readonly TargetPrepModel[]
  /** credentials 引用名（KEY 在执行端加密存储里的 key）。 */
  readonly credentialRef: string
  /** 是否把第一个模型设为目标的默认模型（`agent-default-model` namespace）。 */
  readonly setDefaultModel?: boolean
  /** 是否做连通验证（`llm/discoverModels`）；失败只告警不阻塞。 */
  readonly verifyConnectivity?: boolean
}

/** `saveTargetPrep` 的入参（含一次性密钥）。 */
export interface SaveTargetPrepInput {
  readonly enabled?: boolean
  readonly provider?: TargetPrepProvider
  readonly models?: readonly TargetPrepModel[]
  readonly credentialRef?: string
  readonly setDefaultModel?: boolean
  readonly verifyConnectivity?: boolean
  /** 一次性 API KEY（经执行端 `credentials/set` 写入加密存储；不落 JSON）。 */
  readonly apiKey?: string
}

/** `getTargetPrep` 的返回（不含密钥值）。 */
export interface TargetPrepView {
  readonly config: TargetPrepConfig | null
  /** credentials 引用是否已在执行端配置（加密存储里有值）。 */
  readonly credentialConfigured: boolean
}

/** 单步准备结果。 */
interface PrepStep {
  readonly name: string
  readonly ok: boolean
  readonly detail?: string
}

/** `prepareTarget` 的返回。 */
export interface PrepareTargetResult {
  readonly targetId: string
  readonly ok: boolean
  readonly steps: readonly PrepStep[]
  readonly error?: string
}

// ── 配置文件读写 ──────────────────────────────────────

/** target-prep.json 的文件名（在 `<CORUM_HOME>/corumTestSuite/` 下）。 */
const PREP_FILENAME = 'target-prep.json'

/** target-prep.json 的完整路径。 */
export function prepConfigFile(home?: string): string {
  return join(testSuiteDir(home), PREP_FILENAME)
}

/** route 校验正则（与 host settings 的 provider route 限制一致）。 */
const ROUTE_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * 校验配置合法性（route / models 非空 / api / baseURL）。
 * @returns 错误消息数组；空 = 合法
 */
export function validatePrepConfig(config: unknown): string[] {
  const errors: string[] = []
  if (typeof config !== 'object' || config === null) {
    errors.push('配置必须是一个对象')
    return errors
  }
  const c = config as Record<string, unknown>
  const provider = c.provider
  if (typeof provider !== 'object' || provider === null) {
    errors.push('缺少 provider 配置')
  } else {
    const p = provider as Record<string, unknown>
    if (typeof p.route !== 'string' || !ROUTE_RE.test(p.route)) {
      errors.push(`provider.route 非法（须匹配 ${ROUTE_RE}）`)
    }
    if (typeof p.api !== 'string' || p.api === '') {
      errors.push('provider.api 不能为空')
    }
    if (typeof p.baseURL !== 'string' || p.baseURL === '') {
      errors.push('provider.baseURL 不能为空')
    }
  }
  if (!Array.isArray(c.models) || c.models.length === 0) {
    errors.push('models 必须是非空数组')
  } else {
    for (let i = 0; i < c.models.length; i++) {
      const m = c.models[i] as Record<string, unknown>
      if (typeof m?.id !== 'string' || m.id === '') {
        errors.push(`models[${i}].id 不能为空`)
      }
    }
  }
  if (typeof c.credentialRef !== 'string' || c.credentialRef === '') {
    errors.push('credentialRef 不能为空')
  }
  return errors
}

/** 读 target-prep.json（坏文件 / 不存在 = null）。 */
export function readPrepConfig(home?: string): TargetPrepConfig | null {
  try {
    const raw = JSON.parse(readFileSync(prepConfigFile(home), 'utf8'))
    const errors = validatePrepConfig(raw)
    if (errors.length > 0) return null
    return raw as TargetPrepConfig
  } catch {
    return null
  }
}

/** 写 target-prep.json（不含密钥值）。 */
export function writePrepConfig(config: TargetPrepConfig, home?: string): string {
  const errors = validatePrepConfig(config)
  if (errors.length > 0) {
    throw new Error(`corum-test-suite: target-prep 配置非法：${errors.join('；')}`)
  }
  const dir = testSuiteDir(home)
  mkdirSync(dir, { recursive: true })
  const file = prepConfigFile(home)
  // 只写不含密钥的字段
  const content: TargetPrepConfig = {
    enabled: config.enabled,
    provider: { ...config.provider },
    models: config.models.map(m => ({ ...m })),
    credentialRef: config.credentialRef,
    ...(config.setDefaultModel === undefined ? {} : { setDefaultModel: config.setDefaultModel }),
    ...(config.verifyConnectivity === undefined ? {} : { verifyConnectivity: config.verifyConnectivity }),
  }
  writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`, 'utf8')
  return file
}

// ── 执行端本地 credentials 解析面 ────────────────────

/**
 * 执行端本地 credentials 服务的最小能力面。
 *
 * CTS 不 inject 任何 cordis 服务（见 index.ts 头注释），用 `ctx.get('credentials')`
 * 按需解析。执行端的 credentials provider（`dsh-credentials-local`）注册名为
 * `credentials`，提供 `resolve(ref)` → `Promise<{ value, source } | undefined>`。
 */
export interface LocalCredentialFace {
  /** 解析一个 ref 的值（从执行端加密存储读）。 */
  resolve: (ref: string) => Promise<{ value: string; source: string } | undefined>
  /** 写一个 ref 的值到执行端加密存储。 */
  set: (ref: string, value: string) => Promise<void>
  /** describe 一个 ref（返回 configured / source / writable）。 */
  describe: (ref: string) => Promise<{ configured: boolean; source?: string; writable: boolean }>
}

/**
 * 从 `ctx.get('credentials')` 适配出 {@link LocalCredentialFace}。
 *
 * 服务不在就返回 `undefined`（由调用方按 fail-closed 处理，不崩）。
 */
export function resolveLocalCredentialService(getService: (name: string) => unknown): LocalCredentialFace | undefined {
  const svc = getService('credentials')
  if (svc === undefined) return undefined
  const s = svc as Record<string, unknown>
  if (typeof s.resolve !== 'function') return undefined
  return {
    resolve: (ref: string) => (s.resolve as (ref: unknown) => Promise<{ value: string; source: string } | undefined>)(ref),
    set: (ref: string, value: string) => (s.set as (ref: unknown, value: string) => Promise<void>)(ref, value),
    describe: (ref: string) => (s.describe as (ref: unknown) => Promise<{ configured: boolean; source?: string; writable: boolean }>)(ref),
  }
}

// ── 核心：prepareTarget ──────────────────────────────

/**
 * 往一个被测目标实例配置供应商 + KEY + 默认模型。
 *
 * 步骤顺序（纪律：先 profile 再 key）：
 *  1. `settings/mutate`（`llm-pi-ai`）写 provider profile（含 models、apiKeyEnv=credentialRef）；
 *  2. `credentials/set` 往目标实例写 key 值（值从执行端本地 credentials 解析）；
 *  3. `setDefaultModel` 时按真实 schema（`agent-default-model` 三个独立顶层键：
 *     `provider` / `model` / `reasoningEffort`）成对写 `provider` + `model`；
 *  4. `verifyConnectivity` 时 `llm/discoverModels`，失败只告警不阻塞。
 *
 * @param executor - 被测实例执行器（经 CDP 到目标页内 fetch）
 * @param prep - 目标准备配置
 * @param resolveLocalCredential - 执行端本地 credentials 解析面
 * @returns `{ targetId, ok, steps, error? }`
 */
export async function prepareTarget(
  executor: TargetExecutor,
  prep: TargetPrepConfig,
  resolveLocalCredential: LocalCredentialFace | undefined,
): Promise<PrepareTargetResult> {
  const targetId = '(target)'
  const steps: PrepStep[] = []
  const addStep = (name: string, ok: boolean, detail?: string): void => {
    steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  }

  // ── 步骤 1：写 provider profile ────────────────────
  const profileValue = {
    api: prep.provider.api,
    baseURL: prep.provider.baseURL,
    apiKeyEnv: prep.credentialRef,
    ...(prep.provider.displayName === undefined ? {} : { displayName: prep.provider.displayName }),
    models: prep.models.map(m => ({
      id: m.id,
      ...(m.name === undefined ? {} : { name: m.name }),
    })),
  }
  const profileResult = await executor.callRpc('settings', 'mutate', {
    ns: 'llm-pi-ai',
    ops: [{ op: 'set', path: ['providers', prep.provider.route], value: profileValue }],
  })
  if (!profileResult.ok) {
    addStep('写 provider profile', false, profileResult.error?.message ?? 'settings/mutate 失败')
    return {
      targetId,
      ok: false,
      steps,
      error: `写 provider profile 失败：${profileResult.error?.message ?? '未知'}（code: ${profileResult.error?.code ?? 'unknown'}）`,
    }
  }
  addStep('写 provider profile', true)

  // ── 步骤 2：从执行端解析 key 值，写到目标实例 ──────
  if (resolveLocalCredential === undefined) {
    addStep('解析执行端密钥', false, '执行端缺少 credentials 服务（dsh-credentials-local 未挂载）')
    return {
      targetId,
      ok: false,
      steps,
      error: '执行端缺少 credentials 服务，无法解析 API KEY',
    }
  }
  let keyValue: string | undefined
  try {
    const resolved = await resolveLocalCredential.resolve(prep.credentialRef)
    keyValue = resolved?.value
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    addStep('解析执行端密钥', false, msg)
    return {
      targetId,
      ok: false,
      steps,
      error: `解析执行端密钥失败：${msg}`,
    }
  }
  if (keyValue === undefined || keyValue === '') {
    addStep('解析执行端密钥', false, `credentialRef "${prep.credentialRef}" 在执行端未配置`)
    return {
      targetId,
      ok: false,
      steps,
      error: `执行端 credentialRef "${prep.credentialRef}" 未配置（请先在 CTS UI 里保存 API KEY）`,
    }
  }
  const credResult = await executor.callRpc('credentials', 'set', {
    ref: prep.credentialRef,
    value: keyValue,
  })
  if (!credResult.ok) {
    addStep('写目标密钥', false, credResult.error?.message ?? 'credentials/set 失败')
    return {
      targetId,
      ok: false,
      steps,
      error: `写目标密钥失败：${credResult.error?.message ?? '未知'}（code: ${credResult.error?.code ?? 'unknown'}）`,
    }
  }
  addStep('写目标密钥', true)

  // ── 步骤 3：设默认模型（agent-default-model）────────
  if (prep.setDefaultModel === true) {
    const firstModel = prep.models[0]
    if (firstModel === undefined) {
      addStep('设默认模型', false, 'models 为空，无法设默认模型')
      return { targetId, ok: false, steps, error: 'setDefaultModel=true 但 models 为空' }
    }
    /**
     * `agent-default-model` 的真实 schema（已核实 kkc-desktop 源码）：
     * `provider` / `model` / `reasoningEffort` 是**三个独立顶层键**。
     * provider 与 model 必须成对写入（两者都 `.required()`）。
     * reasoningEffort 可选（不写 = 跟随模型默认档）。
     */
    const defaultModelResult = await executor.callRpc('settings', 'mutate', {
      ns: 'agent-default-model',
      ops: [
        { op: 'set', path: ['provider'], value: prep.provider.route },
        { op: 'set', path: ['model'], value: firstModel.id },
      ],
    })
    if (!defaultModelResult.ok) {
      addStep('设默认模型', false, defaultModelResult.error?.message ?? 'settings/mutate(agent-default-model) 失败')
      return {
        targetId,
        ok: false,
        steps,
        error: `设默认模型失败：${defaultModelResult.error?.message ?? '未知'}（code: ${defaultModelResult.error?.code ?? 'unknown'}）`,
      }
    }
    addStep('设默认模型', true, `${prep.provider.route}/${firstModel.id}`)
  }

  // ── 步骤 4：连通验证（失败只告警不阻塞）─────────────
  if (prep.verifyConnectivity === true) {
    try {
      const discoverResult = await executor.callRpc('llm', 'discoverModels', {
        settingsNs: 'llm-pi-ai',
        request: {
          provider: prep.provider.route,
          baseURL: prep.provider.baseURL,
          apiKey: keyValue,
        },
      })
      if (discoverResult.ok) {
        addStep('连通验证', true, 'discoverModels 返回成功')
      } else {
        /**
         * catalog 路由短路返回 "no model discovery is registered" —— 非错误。
         * 只告警不阻塞（设计点 d）。
         */
        const msg = discoverResult.error?.message ?? '未知'
        const isShortCircuit = msg.includes('no model discovery') || msg.includes('is registered')
        addStep('连通验证', isShortCircuit, msg)
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      addStep('连通验证', false, msg)
    }
  }

  return { targetId, ok: true, steps }
}
