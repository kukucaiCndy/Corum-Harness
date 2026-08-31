# 主 Agent 横切检查已确认事实（供最终汇总合并，避免与子 Agent 冲突）

> 以下为可复核的客观事实，已逐项验证。子 Agent 的深度定性结论以各自报告为准。

## A. 质量工具链（高优先）
- 根目录**无任何** lint / format / test / git-hook 配置：无 eslint.config.*、.eslintrc*、.prettierrc*、biome、lefthook/husky、vitest/jest 配置、.editorconfig。
- 全部 26 个 plugin 包 + desktop 包，package.json 中 **0 个** 有 `"test"` 脚本。
- 全仓 **0 个** *.test.ts / *.spec.ts / *.test.tsx 文件。
- 对照：/Users/kukucai/dsh 根目录有 lefthook.yml + 多个 vitest.*.config.ts + tsdown.config.ts。本发行版完全缺失质量门禁。

## B. Typecheck 现状（高优先 —— 2 个包失败）
- 逐包执行 `pnpm run typecheck`：27 个包中 25 PASS，2 FAIL。
- FAIL 1：`packages/plugins/ui/corum-ide-statusbar-ui` —
  - src/client/index.ts(31,28): TS2345 `"corum.statusBar"` 不在 SlotName 联合类型内
  - src/client/index.ts(33,9): TS2769 No overload matches
  - src/client/StatusBar.tsx(20,43): TS2344 `"corum.statusBar"` 不满足约束
- FAIL 2：`packages/plugins/ui/corum-ide-test-statusbar-ui` —
  - src/client/index.ts(28,28): TS2345 `"corum.statusBar"` 同上
  - src/client/index.ts(28,74): TS2769
- 根因方向：`corum.statusBar` 槽位的类型注册缺失（状态栏功能已移除但插件代码保留，类型未同步）。
- 附注：根 `pnpm -r typecheck` 会在首个失败包处中断（recursive run first-fail），掩盖后续包状态。

## C. 巨型文件（可读性/可维护性）
按行数降序（TS/TSX 源码，不含产物）：
- agent/corum-agent-dev/src/agent-service.ts — 1577 行
- ui/corum-agent-ui-dev/src/client/AgentTestPanel.tsx — 1444 行
- agent/corum-agent-dev/src/runtime.ts — 1222 行
- ui/corum-agent-ui-dev/src/client/McpManagerPanel.tsx — 1110 行
- session/corum-ui-conversation/src/client/input/facade.ts — 923 行
- agent/corum-agent-dev/src/project-data-service.ts — 899 行
- ui/corum-ide-ui/src/client/AppFrame.tsx — 896 行
- ui/corum-ide-sidebar-ui/src/client/SessionsPane.tsx — 862 行
- session/corum-ui-conversation/src/client/conversation/assembler.ts — 847 行
- session/corum-ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts — 734 行
- session/corum-ui-chat/src/client/chat/ChatView.tsx — 733 行
- ui/corum-ide-project-ui/src/client/ProjectPane.tsx — 699 行
（建议 >700 行考虑拆分）

## D. 构建配置复制粘贴漂移
- 21 个 `scripts/inline-css.mjs`，md5 全不同，行数 31~73 不等；但 diff 抽查显示实质逻辑相同，差异仅注释措辞 + 包名（`data-plugin="@corum/xxx"`）。属「模板复制后各自漂移」，应收敛为共享脚本。
- 26 个 `tsdown.config.ts` md5 全不同（含合理差异+漂移混合，需逐个甄别）。
- `tsconfig.json` 有 3 组聚类：14 个相同 / 6 个相同 / 4 个相同 + 3 个独立（基本正常，但提示可抽公共 base）。

## E. 依赖与 import 卫生（实际干净 —— 纠正可能的误判）
- 跨组静态 import 为 0（session 不 import ui、ui 不 import session）。
- 全部静态 `@corum/*` import 均已在各自 package.json 声明（**无幽灵依赖**，之前正则截断的「未声明」全是误报）。
- `corum-ide-ui` 通过运行时字符串名装配其他插件（`boot.entries` + EXCLUDE 集合），非静态依赖——符合 dsh 延迟加载模型。
- 静态 import 集中度：corum-ui-conversation 被 33 处、corum-ui-base 18 处、corum-rpc-client 15 处、corum-ide-ui 14 处。

## F. 代码气味基线（良好）
- 显式 `any`（: any / as any / <any>）：仅 1 处
- TODO/FIXME/HACK/XXX：仅 1 处
- console.log：仅 2 处
- dangerouslySetInnerHTML：0 处
- 产物 lib/dist/build 被 git 追踪：0 个

## G. 仓库卫生 —— gitignore 遗漏（需修）
- `.corum-ide-home/` 被追踪 6 个文件（含运行时状态 settings.yaml、storages/workspace.json），但 .gitignore 只 ignore 了 `.corum-dev-home/`，漏了它。
- `.corum-dev-home-ide/` 被追踪 6 个文件，且 git check-ignore 确认**未 ignore**。
- `profile/` 被追踪 2 个文件（profile/corum/*）——需确认是「发行版 profile 清单（应入库）」还是「运行时产物（不应入库）」。README 目录契约写明 `profile/corum` 是发行版 profile 清单，倾向应入库。
- 根目录存在 `.corum-dev-home/`、`.corum-dev-home-ide/`、`.corum-ide-home/` 三个相似 dev-home，命名混乱。

## H. 文档契约漂移
- README「目录契约」宣称 `packages/shell`，实际目录是 `packages/desktop/`。
- README 只列 `packages/plugins/ui`，实际还有 `plugins/agent/`、`plugins/session/`。
- `doc/`（仅 UXDesign）与 `docs/`（10+ 项）两目录并存，文档归口混乱。

## I. 架构红线（合规，值得肯定）
- `corum-agent-dev` 通过编译 AgentProfile→preset，再经官方 `ctx.agentPresets.mount` 组装（路径 A），是 wrap 而非重写官方 dsh-agent——守住「不改内核」红线。
- 官方包全部来自 npm registry，无 fork/vendored。
