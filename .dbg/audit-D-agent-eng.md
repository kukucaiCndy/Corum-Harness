# 子 Agent D 报告：agent 插件群 + monorepo 工程规范（已收）

评级 B+。无 P0 架构错误。corum-agent-dev 是核心资产：wrap 而非 rewrite（编译 profile→落盘 .agent-presets→官方 mount），精确对齐官方 USER_PRESET_DIR。版本 100% 对齐（315×^0.1.2-alpha.1、26×^4.0.1）、无产物入库、tsconfig 统一继承。短板：仓库卫生、质量工具链全缺失、文档契约漂移。

## A 部分（agent 插件）—— 全 P2，无 P0/P1
- A-1 agent-service.ts:320,1140 诊断用裸 process.stderr.write 留在主路径（应走 ctx.logger）。
- A-2 event-log.ts:116,299 三元两分支完全相同死代码（`endsWith('\n') ? slice(0,-1) : slice(0,-1)`），注释意图与代码不符。
- A-3 compile.ts:183 MCP env（含 API key）明文落盘 preset 目录 + registry-store 存 mcp-servers.json 明文。建议引用化 $占位 或对齐官方 dsh-credentials。
- A-4 runtime.ts:415-432 lastEventId 实例级共享可变状态，reassignTask 因果边不可靠（并发 record 会读错）。应让 cancelTask 透传 record 返回值。
- A-5 task 会话索引寄生伪项目目录 'task'（TASK_PROJECT_ID='task'），与项目 id 命名空间碰撞，createProject 无保留字校验。
- A-6 corum-project-core/src/runtime.ts 是被 agent-dev 取代的早期双运行时（同名 AgentRuntime 类，dev/test/pm 三角色模型已废弃），仍在 workspace 会被 build。应移除/归档或标注废弃。
- A-7【肯定】重复造轮子审计未越线：agent/MCP/skill 全 wrap 官方；mcp test-connection 仅管理面探测；skill-manager 是差异化（官方只管发现加载不管导入版本）；team 自建合理（官方 experimental/agent-team private 未发布，但建议 docs 记一笔已知官方方向）。

## B 部分（工程规范）
- B-1【P1】运行时目录与 preset 资产混入 git：.corum-dev-home-ide/(6)+.corum-ide-home/(6) 运行时状态、根 .agent-presets/(67 文件 preset+CSV)。.gitignore 漏 .corum-dev-home-ide/、.agent-presets/。→ git rm --cached + 补 ignore。
- B-2【P1】project.config.json/project.private.config.json 是微信小程序残留（compileType:miniprogram、appid wx181c...）与项目无关，被 git 追踪。→ 删除。
- B-3【P1】质量工具链整体缺失：无 eslint/oxlint/prettier/vitest/lefthook/husky，0 测试文件，无 AGENTS.md。对照 dsh（lefthook 6 job+vitest 多 config+.oxlintrc+100 verify 脚本+jscpd）差距最大。建议最小起步：lefthook+oxlint pre-commit typecheck；给 event-log fold/runtime 阻塞唤醒/project-data-service 状态机补 vitest；补 AGENTS.md。
- B-4【P2】README 目录契约（packages/shell、plugins/ui、corum-shell）与实际（packages/desktop、plugins/{agent,session,ui}、corum-desktop）全面脱节；docs/TODO.md:22,32,40,50,55 残留 packages/shell。
- B-5【P2】docs/ 与 doc/ 双目录并存，doc/ 仅 UXDesign 设计稿图片堆（99 文件入库）。→ 并入 docs/ux-design，删 doc/。
- B-6【P2】workspace:* 与 workspace:^ 混用无约定（pnpm-workspace.yaml:14 注释说 ^ 但实际以 * 为主，自相矛盾）。
- B-7【P2】.npmrc 把 @deepseek-ai 指向 localhost:4873 私服，README 快速开始未提前置依赖；pnpm-lock.yaml 无 localhost 引用（lock 在公网生成，与 .npmrc 来源不一致）。
- B-8【P2】exports["./client"].types 指向 src 而非 lib（corum-agent-ui-dev:13、corum-rpc-client:9、corum-skill-manager-ui-dev、corum-team-ui-dev）；corum-ui-base ./client.default 直指 ./src/client/index.ts（运行时吃源码 TS）。应统一指 lib/types/*.d.ts。
- B-9【P2】21 个包 tsconfig 冗余 noImplicitAny（base 已有），复制粘贴漂移。
- B-10【肯定】版本/依赖健康：dsh 版本全对齐、无 phantom dep、无产物入库、react 统一。@types/react-dom ^18.3.7 与 ~18.3.0 两段并存（P2）。

## 值得肯定
preset 编译落盘+官方 mount 的 wrap 架构（renderScalar 对 !!js YAML 标记处理说明真读过官方语义）；event-log「事件唯一事实源」事件溯源扎实落地；pendingPermissions 延迟落盘对齐官方 lazy materialization（考据式对齐）；权限网关「角色由 exec.agent 反查、模型不可自报」焊死伪造 role 越权；cdp.sh 精确清理纪律（不误杀微信开发者工具双保险）；minimumReleaseAgeExclude 380 行完整维护（供应链安全意识）。
