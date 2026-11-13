/**
 * fork（corum）：**提示词段的读者判定**（2026-11-12 必要性审计 §1.2「条件注入」）。
 *
 * ## 为什么需要它
 *
 * 有两类事实只对**开发类角色**（会话要 inspect / extend DSH 本身的那种）有意义：
 *   · `harness-source`（`packages/desktop/src/index.ts`）：DSH checkout 在哪；
 *   · `corum:host-identity` 的 CDP 端口 / attach / verify 实例规则。
 * 普通角色（standard / 各岗位）永远用不到它们，却每轮都付 ~630B 的入力。分流的前提是
 * **判据必须机器可判定**，不能靠 persona 文案或名字猜测。
 *
 * ## 判据（已实证，2026-11-12）
 *
 * `systemPrompt` 的段 provider 在组装时收到 `AssembleContext`，其中带 `agent`
 * （`@deepseek-ai/dsh-agent` 的 `runtime-types.d.ts` 模块扩充：
 * `interface AssembleContext { agent?: Agent }`；`assembleContextFor()` 在 agent-loop
 * 每一步把 `{ agent, scope: agent }` 交给 `systemPrompt.assemble()`）。
 *
 * `Agent.session.header.agentPreset` 是**持久事实**：`dsh-api-session-controller`
 * 建会话时写 `meta.agentPreset`（`createAgent()` → `session.header`），本机会话文件头实测
 * `{"agentPreset":"corum-dev", ...}`；corum 自己的子会话也由 `childSessionMeta()` 继承写入。
 * ⇒ 由它判定「这个会话是哪个 preset 组装出来的」，与会话创建路径无关、重启/恢复后仍成立。
 *
 * 不用 `agentPresets.composedPreset(agent.ctx)` 的原因：那需要注入一个**可选**服务
 * （preset 服务缺席的部署里段就永远注册不上，等于把事实丢了）；而 header 是纯数据。
 * header 的已知盲区只有一个——**空白会话改选 preset** 只追加 `agent-preset/selected`
 * 事件、不改 header。故 `resume` 的会话若改选过，判据会看到创建时的 preset；这条遗留
 * 风险记在审计文档里，不影响本次分流（两种取值下都不会比现状更差）。
 *
 * ## 失败方向：**未知 ⇒ 注入**（fail-open）
 *
 * 判不出 preset（无 agent 面 / rosterless 部署 / 诊断性组装）时**返回 true**，即维持
 * 2026-11-12 之前「全局注入」的老行为。理由：漏注入会让开发类会话丢掉它真正需要的
 * 事实（2026-09-12 的实例误判事故就是事实缺失造成的），多注入只是没省下那几百字节。
 *
 * ## `DEVELOPMENT_AGENT_PRESETS` 的孪生副本
 *
 * `packages/desktop/src/index.ts` 为了不把 `@corum/*` 拉进 shell 插件的 bundle，保留了
 * 一份**同口径常量**（该文件刻意零 @corum 依赖）。两份必须同步：`corum-agent/tests/
 * prompt-audience.spec.ts` 逐字对账两个文件的清单，改一处不改另一处立刻红。
 *
 * @module @corum/corum-agent/prompt-audience
 */

/**
 * 开发类 Agent preset id（会话可能 inspect / extend DSH 本身）。
 *
 * 新增开发类角色时**同时**改 `packages/desktop/src/index.ts` 的同名常量
 * （对账见 {@link isDevelopmentAgentPreset} 的模块注释）。
 */
export const DEVELOPMENT_AGENT_PRESETS: readonly string[] = ['corum-dev']

/**
 * 该 preset 是否属于开发类。
 * @param preset - 会话的 `agentPreset`（未知时为 undefined）。
 * @returns 已知非开发类 ⇒ false；开发类 ⇒ true。
 */
export function isDevelopmentAgentPreset(preset: string | undefined): boolean {
  return preset !== undefined && DEVELOPMENT_AGENT_PRESETS.includes(preset)
}

/** 组装上下文里模型看得到的 agent 面（窄接口，不耦合 `@deepseek-ai/dsh-agent` 的实现包）。 */
interface AssembledAgentFace {
  readonly session?: { readonly header?: { readonly agentPreset?: string } } | undefined
}

/** {@link AssembleContext} 的窄接口：本判定只读 `agent.session.header.agentPreset`。 */
interface AssemblyContextFace {
  readonly agent?: AssembledAgentFace | undefined
}

/**
 * 从组装上下文读会话的 preset id。
 * @param context - `systemPrompt.section()/context()` 的 `text(context)` 实参。
 * @returns preset id；上下文没有 agent 面时为 undefined。
 */
export function agentPresetOfAssembly(context: unknown): string | undefined {
  const agent = (context as AssemblyContextFace | undefined)?.agent
  const preset = agent?.session?.header?.agentPreset
  return typeof preset === 'string' ? preset : undefined
}

/**
 * 本次组装的目标读者是不是开发类角色（fail-open：判不出来 ⇒ true）。
 * @param context - `systemPrompt.section()/context()` 的 `text(context)` 实参。
 * @returns 是否把「只对开发类角色有意义」的事实注入本次组装。
 */
export function isDevelopmentAssembly(context: unknown): boolean {
  const preset = agentPresetOfAssembly(context)
  // 判不出来：维持全局注入的老行为（见模块头的「失败方向」）。
  if (preset === undefined) return true
  return isDevelopmentAgentPreset(preset)
}
