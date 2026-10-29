/**
 * remote-rpc —— 在**目标实例的页面内**调用它的 host RPC。
 *
 * ## 这一层解决什么
 *
 * 目标实例的 host RPC 只能从**它的页面**里调（外部直接 POST 只会得到 401 ——
 * 缺 token）。所以本模块做的是：把「命名空间/方法/参数」翻译成一段页内 `fetch`，
 * 经 CDP 送到目标页面里执行，再把结果结构化返回。
 *
 * 实测（2026-10-29，rc3 :9350）：页内 `fetch('/api/agentPresets/list')` → HTTP 200，
 * 拿到真实数据；外部 `curl` 同一个端点 → `unauthorized`。
 *
 * ## wire 形状（这是本仓最容易踩的规则）
 *
 * `dsh-api-gateway` 的 `assertExactArguments()` 按 descriptor 的 `parameters[].wire`
 * 严格校验 args 的键集合：**多一个 `unexpected`、少一个 `missing`** 都回
 * `gateway/arguments-invalid`。而 `wire` 就是**方法的形参名**。所以同一个端点在
 * 不同方法上可能是 `{}` / `{ _request: {...} }` / `{ request: {...} }` / `{ input: {...} }`
 * —— 看着像三种形状，其实是一条规则：**包在形参名下**。
 *
 * 因此本模块**不猜**形状：调用方显式传 `args`，另提供 {@link RpcShape} 常量与
 * {@link wrapArgs} 帮助构造，把「猜错形状」这件事收敛到一处可测的地方。
 *
 * @module @corum/corum-cdp-router/remote-rpc
 */

import { type CdpSession, connectSession } from './cdp-client.ts'

/** 一次 RPC 调用的结果（成功/失败都返回，**不抛错**——让调用方记录而不炸）。 */
export interface RemoteRpcResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: {
    readonly code: string
    readonly message: string
  }
  /** 页内实际执行的 HTTP 状态（诊断用；0 = fetch 本身失败）。 */
  readonly httpStatus: number
}

/**
 * args 的包裹形态 —— 与目标方法的**形参名**一一对应。
 *
 * 用法对照（都是实测过的真实端点）：
 * ```
 * { kind: 'none' }                      → {}                        （如 settings/describe）
 * { kind: 'underscore', key: '_request' } → { _request: {...} }      （如 session/list）
 * { kind: 'named', key: 'request' }     → { request: {...} }         （如 session/updateQueue）
 * { kind: 'named', key: 'input' }       → { input: {...} }           （如 cdpTargets/upsert）
 * ```
 */
export type RpcShape =
  | { readonly kind: 'none' }
  | { readonly kind: 'named'; readonly key: string }

/**
 * 按形状把参数包成 wire 形式。
 *
 * @param shape - 形参名信息
 * @param payload - 实际参数（`kind: 'none'` 时忽略）
 * @returns 可直接作为 `payload.args` 的对象
 */
export function wrapArgs(shape: RpcShape, payload: Record<string, unknown> = {}): Record<string, unknown> {
  if (shape.kind === 'none') return {}
  return { [shape.key]: payload }
}

/**
 * 生成在目标页内执行 RPC 的表达式。
 *
 * 为什么用「拼字符串 + IIFE」而不是序列化一个函数：CDP 的 `Runtime.evaluate` 只接受
 * 表达式文本；把参数 `JSON.stringify` 进去是最可控的做法（避免闭包/作用域问题）。
 *
 * @param namespace - 服务名（如 `agentPresets`）
 * @param method - 方法名（如 `list`）
 * @param args - 已按 {@link wrapArgs} 包好的 args
 * @param timeoutMs - 页内 fetch 超时（**页内计时**，防止 CDP 侧超时先到导致结果丢失）
 * @returns 可交给 `Runtime.evaluate` ���表达式
 */
export function buildRpcExpression(
  namespace: string,
  method: string,
  args: Record<string, unknown>,
  timeoutMs = 20000,
): string {
  // 全部经 JSON.stringify 注入，杜绝字符串拼接被注入改写表达式结构。
  return `(async () => {
  const ns = ${JSON.stringify(namespace)};
  const m = ${JSON.stringify(method)};
  const args = ${JSON.stringify(args)};
  const budget = ${JSON.stringify(timeoutMs)};
  const rpcId = crypto.randomUUID();
  const message = { type: 'client-request', rpcId, method: ns + '/' + m, payload: { args } };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budget);
  try {
    const res = await fetch('/api/' + ns + '/' + m, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: ctrl.signal,
    });
    if (res.status !== 200) {
      return { ok: false, httpStatus: res.status, error: { code: 'http-' + res.status, message: 'HTTP ' + res.status } };
    }
    const env = await res.json();
    const result = env && env.result ? env.result : null;
    if (result === null) {
      return { ok: false, httpStatus: 200, error: { code: 'no-result', message: '响应缺少 result 字段' } };
    }
    if (result.ok === true) return { ok: true, httpStatus: 200, value: result.value };
    const err = result.error || {};
    return { ok: false, httpStatus: 200, error: { code: String(err.code || 'unknown'), message: String(err.message || '') } };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return {
      ok: false,
      httpStatus: 0,
      error: { code: aborted ? 'rpc/timeout' : 'rpc/fetch-failed', message: String(e && e.message ? e.message : e) },
    };
  } finally {
    clearTimeout(timer);
  }
})()`
}

/**
 * 在一个已建立的会话上调用 RPC。
 *
 * @param session - 已连上目标页的会话
 * @param namespace - 服务名
 * @param method - 方法名
 * @param args - 已包好的 args
 * @param timeoutMs - 页内超时
 * @returns RPC 结果（不抛错）
 */
export async function callRpcOnSession(
  session: CdpSession,
  namespace: string,
  method: string,
  args: Record<string, unknown> = {},
  timeoutMs = 20000,
): Promise<RemoteRpcResult> {
  const expression = buildRpcExpression(namespace, method, args, timeoutMs)
  try {
    // CDP 侧超时给页内预算留出余量（页内 AbortController 先触发，错误信息更准）
    const raw = await session.evaluate(expression, timeoutMs + 5000)
    return normalizeResult(raw)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, httpStatus: 0, error: { code: 'cdp/evaluate-failed', message } }
  }
}

/**
 * 便捷封装：连上某个端口 → 调 RPC → 关闭。
 *
 * 适合一次性查询；要连续调多个 RPC 时请复用 `connectSession` 的会话（建连开销 ~10ms）。
 *
 * @param port - CDP 端口
 * @param namespace - 服务名
 * @param method - 方法名
 * @param shape - args 形状
 * @param payload - args 内容
 * @param timeoutMs - 页内超时
 * @returns RPC 结果
 */
export async function callRpc(
  port: number,
  namespace: string,
  method: string,
  shape: RpcShape = { kind: 'none' },
  payload: Record<string, unknown> = {},
  timeoutMs = 20000,
): Promise<RemoteRpcResult> {
  let session: CdpSession
  try {
    session = await connectSession(port)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, httpStatus: 0, error: { code: 'cdp/connect-failed', message } }
  }
  try {
    return await callRpcOnSession(session, namespace, method, wrapArgs(shape, payload), timeoutMs)
  } finally {
    session.close()
  }
}

/**
 * 把页内返回值规整成 {@link RemoteRpcResult}。
 *
 * 页内表达式已保证返回同形对象，这里只做类型收窄与兜底（防止目标版本不同导致
 * 字段缺失时把 `undefined` 当成功）。
 *
 * @param raw - 页内返回的原始值
 * @returns 规整后的结果
 */
export function normalizeResult(raw: unknown): RemoteRpcResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, httpStatus: 0, error: { code: 'rpc/bad-shape', message: `页内返回不是对象：${String(raw).slice(0, 120)}` } }
  }
  const r = raw as Record<string, unknown>
  const httpStatus = typeof r.httpStatus === 'number' ? r.httpStatus : 0
  if (r.ok === true) {
    return { ok: true, httpStatus, ...(r.value === undefined ? {} : { value: r.value }) }
  }
  const err = (r.error ?? {}) as Record<string, unknown>
  return {
    ok: false,
    httpStatus,
    error: {
      code: typeof err.code === 'string' ? err.code : 'unknown',
      message: typeof err.message === 'string' ? err.message : '',
    },
  }
}

/**
 * 读目标实例的运行期身份（基座版本、启动条目数、origin）。
 *
 * 为什么单独一个函数：几乎所有跨实例测试都要先确认「我测的是哪个基座」。
 * `release` 字段是 0.2.1-rc.3 才有的；0.1.5 返回 `null` —— **那是判据**（说明是旧基座），
 * 不是读取失败。
 *
 * @param session - 已连上的会话
 * @returns 身份快照
 */
export async function readRemoteIdentity(session: CdpSession): Promise<{
  releaseVersion: string | null
  releaseCommit: string | null
  rev: string | null
  bootEntries: number
  origin: string | null
}> {
  const expression = `(function(){
    var boot = window.__DSH_BOOT__ || {};
    var rel = boot.release || null;
    return {
      releaseVersion: rel && typeof rel.version === 'string' ? rel.version : null,
      releaseCommit: rel && typeof rel.commit === 'string' ? rel.commit : null,
      rev: typeof boot.rev === 'string' ? boot.rev : null,
      bootEntries: Object.keys(boot.entries || {}).length,
      origin: typeof location !== 'undefined' ? location.origin : null,
    };
  })()`
  const raw = await session.evaluate(expression, 5000)
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    releaseVersion: typeof r.releaseVersion === 'string' ? r.releaseVersion : null,
    releaseCommit: typeof r.releaseCommit === 'string' ? r.releaseCommit : null,
    rev: typeof r.rev === 'string' ? r.rev : null,
    bootEntries: typeof r.bootEntries === 'number' ? r.bootEntries : 0,
    origin: typeof r.origin === 'string' ? r.origin : null,
  }
}
