# 标准模式与指挥模式：会话首轮系统提示词审查

审查日期：2026-11-12  
范围：新建会话的 `standard`、`conductor` 基准 preset。  
不在范围：行业角色 persona、PM、子 Agent、运行中追加的 goal/plan 指令、用户自定义 MCP guidance。

## 结论

两种模式没有一份可以脱离运行时直接复制出来的固定 system prompt。首轮文本由模式、模型、工作目录、
home、locale、`AGENTS.md`、已安装技能和可见工具 schema 共同组装。以下内容是当前源码确定的首轮
拼装关系和差异；`{{model}}`、`{{output_language}}`、home、CDP port 和工具 schema 都是运行时值。

本次发现一个 P0：指挥模式明示“每一次写入都会被拒绝”，但实施它的 bash 门禁是启发式识别，无法
覆盖 `pnpm run build`、`make` 或任意会写盘的自定义脚本。若会话沙箱允许写入，提示词给出的安全承诺
不成立。

## 1. 两种模式共同进入首轮 system prompt 的内容

1. 基础 persona：

   ```text
   You are a coding agent powered by the {{model}} model.
   ```

2. `agent-instructions` 读取到的项目 `AGENTS.md`；它是模型可见系统指令的一部分。

3. Corum root scope 段：

   - host identity：实例角色、home、CDP port、工作目录和实例操作边界；
   - output language：最终回复与可见 reasoning 摘要的语言规则；
   - execution discipline：bash、验证、后台任务和沙箱升级纪律；
   - todo discipline：使用 todo 时的状态维护纪律。

4. 当前模式装配出的官方工具说明与 JSON schema（bash、filesystem、search、skills、goals、
   delegation、todo、web 等）。工具描述本身由 `@deepseek-ai/dsh-*` 包按当前平台生成。

5. 可见的 skills catalog；它随安装的技能和 profile 授权变化。

这些 root scope 段的注册入口是 [agent-service.ts](packages/plugins/agent/corum-agent/src/agent-service.ts:751)。

## 2. 标准模式

标准模式使用基础 persona 加上所有共同段，并保留文件工具策略。该策略的逐字正文在
[tool-policy.ts](packages/plugins/agent/corum-agent/src/tool-policy.ts:52)，要点是：

```text
File operations go through the dedicated tools, not the shell:
- Read files with `read`.
- Change an existing file with `edit`.
- Create or fully rewrite a file with `write`.
Reserve `bash` for real shell work: builds, tests, package managers, git,
processes, and pipelines over command output.
```

它继续要求：工具被“未读取文件”或“old_string 未找到”拒绝时，应重新读取并修正调用，
不得改用 shell 绕开；多次编辑同一文件前必须重新读取。

静态 preset 的 persona 与工具行见
[standard/agent.cordis.yml](packages/desktop/shipped-presets/official/standard/agent.cordis.yml:33)。

## 3. 指挥模式

指挥模式继承共同段，但在运行时作四个改变：

1. 清空 `corum:tool-policy`，避免要求不存在的 `write/edit` 工具；
2. 从工具面移除 `write`、`edit`、`str_replace_editor`、Windows 下的 `pwsh`；
3. 清空官方 `tool:write`、`tool:edit` 的残留提示段；
4. 紧随基础身份插入完整的 Conductor persona，并为主 Agent 安装 bash 写入门禁。

完整 persona 的唯一事实源是 [conductor.ts](packages/plugins/agent/corum-agent/src/conductor.ts:96)。
它的核心内容是：

```text
You are the Conductor in Conductor Mode — a technical lead, not a dispatcher.
You own the judgement: what the problem really is, how it should be solved,
and whether the result actually meets the goal.

No write tools: you cannot edit files.
The shell (`bash`) is read-only. Every write is refused: you can inspect,
never change the repository.
```

接着它要求主 Agent：先作有限的定向调查、明确决定实现方案、把具体方案写进 brief、委派生产工作，
并亲自读取 diff/关键文件验收；子 Agent 的完成报告不是证据。

运行时覆盖和门禁注册见
[conductor-runtime.ts](packages/plugins/agent/corum-agent/src/conductor-runtime.ts:93)。静态 preset 基础 persona
见 [conductor/agent.cordis.yml](packages/desktop/shipped-presets/official/conductor/agent.cordis.yml:43)。

## 4. 审查结果

### P0：指挥模式“所有写入均被拒绝”的保证为假

Conductor persona 说：`Every write is refused`。实际门禁只调用
`detectBashWrite(command)`，见 [permission-policy.ts](packages/plugins/agent/corum-agent/src/permission-policy.ts:164)。

`detectBashWrite` 是刻意不完备的启发式：它识别重定向、少数文件命令、git 写操作、包管理器的
`install/add/remove/...` 和部分内联解释器写入；代码自身也说明“宁可漏判也不误伤”。见
[confinement.ts](packages/plugins/agent/corum-orchestration/src/confinement.ts:395)。

因此以下命令不属于当前列举的写形态，但可能写入工作区：

```text
pnpm run build
make
./scripts/generate-assets.sh
```

当主会话获准 `workspace-write` 或 `danger-full-access` 时，这些命令不保证被 guard 拦住。
这既是权限漏洞，也是系统提示词对模型作出的虚假承诺。

建议：要么把 Conductor 的承诺降级为“不要写；已知写形态会被拒绝”，要么使用不可被用户档位
覆盖、并且由沙箱在文件系统层强制的只读边界。仅扩展命令名单不能构成“所有写入”的保证。

### P1：host identity 的 verify 重启规则互相冲突

verify 分支说：`you may restart it freely`；同一段随后又无条件说：
`Never restart or kill the instance hosting this session`。两句针对同一实例给出相反命令。

证据：[host-identity.ts](packages/plugins/agent/corum-agent/src/host-identity.ts:59)。

建议：明确区分“验证实例中的被测应用可重启”与“承载当前 agent session 的 host 不可重启”，
并只让其中一个规则适用于当前实例。

### P1：带 MCP 的指挥 profile 可绕过“无写工具”叙述

Conductor guard 只处理 `write`、`edit`、`str_replace_editor`、`pwsh` 与 `bash`。它不会识别
`mcp__<server>__<tool>` 是否有副作用。若用户为指挥 profile 授权了能够写入的 MCP server，提示词中
的 `No write tools` 与真实工具面不再一致。

建议：为 MCP 工具登记副作用能力；在 conductor mode 拒绝写能力 MCP，或把它们从工具面和 prompt
中一并移除。

### P2：输出语言规则中的“latest user message”没有机器可判定定义

规则要求按用户“latest message”的语言回答，但会话还会加入 skills catalog、内部通知等 synthetic
user messages。提示词未区分真人消息和这些系统注入消息，因此“latest”的语义可能漂移。

证据：[output-language.ts](packages/plugins/agent/corum-agent/src/output-language.ts:106)。

建议：实现并注入单一确定值：locale 优先；否则取最近一条真人用户消息的语言，而非由模型自行判断。

## 5. 运行时快照状态

为取得逐字渲染后的两份 prompt，曾只启动独立 verify 实例（`:9333`，未触碰主实例）。该实例在完成
系统组装前退出，原始原因是缺少：

```text
~/.corum-rc3/skills/corum-cdp-verify/router/dist/launcher.mjs
```

因此本文是依据实际注册与覆盖链路的源码审查，不把未取得的运行时快照伪称为实测结果。
