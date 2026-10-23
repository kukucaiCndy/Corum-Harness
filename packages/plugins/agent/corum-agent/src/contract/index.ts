/**
 * @corum/corum-agent/contract — corum-agent 跨域 RPC 契约子路径。
 *
 * 对照官方 api/session-controller 的 client 契约包模式：把「实际被 client 半
 * 消费的 @Remote 端点」的方法名常量 + args/result 类型抽成独立子路径，消费方
 * （corum-ui-conversation / corum-ide-sidebar-ui / corum-agent-ui-dev /
 * corum-team-ui-dev）type-only 引用，获得编译期保障。
 *
 * 纯类型 + 字符串常量（方法名常量），无任何运行时副作用——本包是 host 半插件，
 * 本子路径被 client 半消费方引用，不会把 host 运行时依赖拉进浏览器包。
 *
 * 维护约定：agent-service.ts 的 @Remote 方法名/参数/返回
 * 改动时，必须同步本目录（方法名常量的值 = 装饰器字符串，args/result = 实现签名
 * 的命名参数对象/返回体）。
 * @module @corum/corum-agent/contract
 */

export {
  CORUM_AGENT_METHODS,
  type CorumAgentMethod,
  type CorumAgentEndpointTable,
  // 复用的 wire 投影类型
  type ProfileSummary,
  type AgentStatus,
  type ProviderCatalog,
  type SessionEventDto,
  type RunPromptResult,
  type SaveProfileInput,
  type TaskAgentSummary,
  // 端点 args/result
  type CreateTaskAgentArgs,
  type CreateTaskAgentResult,
  type ListModelsResult,
  type PermissionPresetOption,
  type ListPermissionPresetsResult,
  type ListProfilesResult,
  type ListTaskAgentsArgs,
  type ListTaskAgentsResult,
  type ListAgentsResult,
  type SaveProfileArgs,
  type SaveProfileResult,
  type DeleteProfileArgs,
  type VerifyResult,
} from './agent.ts'

// 项目模式剥离（2026-09-26）：原 L51-91 的 `CORUM_PROJECT_METHODS` 区块
// （`CorumProjectMethod` / `CorumProjectEndpointTable` / CreateProjectArgs / …
// / DeleteProjectResult）已随项目模式迁到闭源仓 Corum-Harness-Project 的
// `@corum/corum-project/contract`。project-lane 的三个 corumAgent 端点
// （createAgentForType / runPromptForType / getSessionEventsForType）同理迁出，
// 由闭源插件在自己的契约子路径重新声明（RPC 面移动，非删除）。
