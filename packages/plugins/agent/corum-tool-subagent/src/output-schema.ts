/**
 * fork（corum）：`subagent` 工具的 **output schema** 单一出处。
 *
 * 为什么把它抽成独立模块（2026-11-07）：这份声明必须与 `spawnOne` 的真实返回
 * 对象**逐字段对齐**，而对齐是硬约束不是风格——
 *
 * 1. `defineTool` 会把本 spec 用 `valueSchemaSpecToJsonSchema` 编译成 JSON Schema；
 * 2. registry 在成功路径上用 `validateJsonSchemaValue(tool.output.schema, 返回值)`
 *    校验（见 `@corum/corum-tools` 的 `createSuccessResult`）；
 * 3. 三支都声明了 `additionalProperties: false` ⇒ **返回对象多一个没声明的字段，
 *    三支就全部不匹配**，harness 报
 *    `tool "subagent" returned invalid output: "value" must match exactly one oneOf
 *    branch (matched 0)` 并用 `INVALID_TOOL_OUTPUT` **顶替整个结果**（父 Agent 只
 *    看到一条"输出非法"，子 Agent 的正文全丢）。
 *
 * 本仓已第三次栽在同一形态：`rejected`（2026-09-16）、`integration.report`
 * （2026-09-27），以及本次 `spawnModel`（2026-10-28 的 issue #157 只改了返回值、
 * 漏了这里的声明 ⇒ 模型路由解析成功时 100% 触发，用户 2026-11-07 实机报障）。
 *
 * 约定：**返回对象新增字段必须与声明在同一个提交里**。
 * `tests/output-schema.spec.ts` 用真实校验器把代表性 payload 跑一遍——漂移在那里变红，
 * 而不是等到用户请求失败。
 */
import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

// ⚠️ 必须用 `satisfies`（不是 `: ValueSchemaSpec` 注解）：注解会把字面量类型拓宽，
// `defineTool` 的 `const O extends ValueSchemaSpec` 泛型推不出分支联合类型 ⇒
// `output.render` 的 `value` 会退化成 `never`，`execute` 返回 `ForegroundToolResult`
// 也就对不上（实测报 TS2339 `Property 'kind' does not exist on type 'never'`）。
export const CORUM_SUBAGENT_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'background' },
        jobId: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'continuable' },
        subagentId: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'foreground' },
        runId: { type: 'string', required: true },
        output: { type: 'array', required: true, items: { type: 'json' } },
        /**
         * fork（corum）：本次委派的隔离落点（**两档都出现**，见
         * `corumIsolationBoundaryNotice`）：`worktree` = 改动在隔离分支上、
         * 必须 `integrate: true` 才进主树；`skipped-non-git` = 没隔离，改动已在
         * 父树里。⚠️ 本 schema 声明了 `additionalProperties: false`，故新增字段
         * **必须**同步在这里，否则整个结果会被 INVALID_TOOL_OUTPUT 吞掉
         * （本仓已付过这个学费，见 HANDOFF-2026-09-16 §教训）。
         */
        isolationBoundary: { type: 'string', enum: ['worktree', 'skipped-non-git', 'main-requested'] },
        /**
         * fork（corum）2026-10 修复③（B 方案）：research 报告的落盘路径。
         *
         * ⚠️ 与 `isolationBoundary` 同一条纪律：本 schema 是
         * `additionalProperties: false`，新增字段**必须**同步声明，否则整个结果会被
         * INVALID_TOOL_OUTPUT 吞掉（本仓已付过这个学费）。
         */
        reportPath: { type: 'string' },
        /**
         * fork（corum）2026-10-28（issue #157）：本次 spawn **真实生效**的模型路由，
         * 与 `corumEmitChildStarted` 广播的 `model` 字段同源。
         *
         * ⚠️ 2026-11-07 补声明：这个字段当初只加进了返回值（`withModel`），漏了这里的
         * 声明 ⇒ 前台委派在路由解析成功时 100% 报
         * `"value" must match exactly one oneOf branch (matched 0)`。这就是本文件
         * 头注释说的那种漂移，别再犯第四次。
         */
        spawnModel: {
          type: 'object',
          additionalProperties: false,
          properties: {
            provider: { type: 'string', required: true },
            model: { type: 'string', required: true },
            reasoningEffort: { type: 'string' },
          },
        },
      },
    },
  ],
} as const satisfies ValueSchemaSpec
