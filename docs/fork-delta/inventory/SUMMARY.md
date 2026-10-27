# Stage 3 Fork Rebase Inventory — 50 Package Overview

> Generated: 2026-10-27T05:04:35.951Z（initialSnapshot — rebase 前的文件分类快照，不直接当最终 diff）
> Last updated: 2026-10-28（B 纠偏收口：六 ns 修复 + 守卫重写 + typecheck 51/51）
> Official tag: `dsh-v0.2.1-rc.3` (prev: `dsh-v0.1.5-rc.3`)
> DSH checkout: `/Users/kukucai/dsh`

> **重要**：本 inventory 是 rebase **前**的初始文件分类快照（`initialSnapshot`），
> gates 字段在各包 rebase 完成后手动更新。**不要把 initialSnapshot 当作最终 diff**——
> rebase 后文件分类可能已变（如 `continuation.ts` 已删但仍标 `corum-new`），
> 需要时重生成 inventory 并保留 gates。

## E 专项收口（2026-10-28）

四包 gates 均以实际日志为准（非初始快照推断）：

| Package | typecheck | build | test | drift (guard16) | 日志 |
|---|---|---|---|---|---|
| @corum/corum-subagent | ✅ pass | ✅ pass | ✅ 33 文件 614 测试 | ✅ 0 红 | `.corum-tmp/stage3-e-final-{typecheck,test}-subagent.log` |
| @corum/corum-tool-subagent | ✅ pass (含 spec) | ✅ pass | ✅ 18 文件 450 测试 | ✅ 0 红 | `.corum-tmp/stage3-e-final-{typecheck,test}-tool-subagent.log` |
| @corum/corum-orchestration | ✅ pass | ✅ pass | ✅ 4 文件 147 测试 | N/A (corum-only) | `.corum-tmp/stage3-e-final-{typecheck,test}-orchestration.log` |
| @corum/corum-goal-round-driver | ✅ pass | ✅ pass | ✅ 1 文件 9 测试 | N/A (corum-only) | `.corum-tmp/stage3-e-final-{typecheck,test}-goal-round-driver.log` |

## B 纠偏收口（2026-10-28）

**全仓 forced typecheck: 51/51 PASS, 0 FAIL, 0 semantic errors, 0 TS5033**（`.corum-tmp/stage3-b-typecheck-3.log`）。

B 纠偏修复了六处 settings ns 级功能缺口 + 守卫假绿（详见 `docs/UPGRADE-0.2.1-rc3.md` §阶段3B）：

- corum-agent ns → `@corum/corum-agent`（combo entry id）
- corum-review ns → boot 常驻 registrar 行（`@corum/corum-agent/review-settings`）
- corum-web-search → `export const Config`（volatile activeProvider）
- shell ns → `bash-sandbox`（官方 base patch 行 id）
- conversation/chat ns → `corum-conversation`/`corum-chat`（IDE overlay 插入行 id）
- subagent-model-selection ns → `subagent-model-selection-settings`（官方 web-app patch 行 id）
- `verify-stage3-b.mjs` 完全重写（Node 递归遍历 + JS RegExp，不用 BSD grep）

**sidebar exit1 根因**：研究报告称 sidebar exit1，实跑 sidebar-ui `vitest run` 7 passed exit 0。原 `.corum-tmp/stage3-b1-tests.log` 的 exit1 系沙箱内 vitest 加载 `vitest.config` 时写临时文件被拒（`EPERM open …/node_modules/.vite-temp/*.mjs`），非 sidebar 包自身测试失败。

**测试 gate 修正**：inventory 原标 pass 的 test gate 以实际日志为准（非只含 Start/Duration 的日志声称）。

### B 纠偏新增测试

| 包 | 测试文件 | 测试数 |
|---|---|---|
| corum-ui-conversation | `tests/corum-navigation.spec.ts` | 9 |
| corum-ui-questions | `tests/derived-pending-interactions.spec.ts` | 9 |
| corum-agent | `tests/settings-ns-alignment.spec.ts` | 16 |

**rc3 drift**: 25 项失败（全为既存 fork delta，与 B 纠偏无关；exit 0 with explicit tag `DSH_BASELINE_TAG=dsh-v0.1.5-rc.3`）。

**全仓状态（阶段 3 整体，非 E 本身）**：
- 全仓 forced typecheck: 37/51 PASS, 14 FAIL, 169 语义错（`.corum-tmp/stage3-e-after.log`）
  - E 四包全绿；corum-agent 9 错系 D/UI 既存（与 E 前一致，非 E 引入）
  - 其余 12 包失败为 UI/D 既存错
- rc3 drift: 1 项失败（`.corum-tmp/stage3-e-drift.log`）
  - guard16 0 红 ✅
  - 剩余: sandbox-local/src/index.ts 与官方差异（D 任务 A2C rebase 引入，非 E）
- 全仓 drift gate → **阶段 3 pending**（D 任务待修复 sandbox-local diff）

## Coverage

| Metric | Count |
|---|---|
| Total fork packages | 50 |
| Mapped to official | 15 |
| corum-only (no official counterpart) | 15 |
| Needs mapping | 20 |
| Inventory JSON files | 50 |

## Per-Package Summary

| Package | Group | Mapping | Official Path | Files | identical | import-rename | substantive | corum-new | official-deleted |
|---|---|---|---|---|---|---|---|---|---|
| @corum/corum-agent | agent | corum-only | — | 78 | 0 | 0 | 0 | 78 | 0 |
| @corum/corum-api-remotes | agent | explicit | packages/api/remotes | 12 | 2 | 0 | 6 | 3 | 1 |
| @corum/corum-artgen | agent | corum-only | — | 9 | 0 | 0 | 0 | 9 | 0 |
| @corum/corum-credentials-local | agent | explicit | packages/credentials/credentials-local | 11 | 0 | 0 | 3 | 2 | 6 |
| @corum/corum-extension-pack | agent | needs-mapping | — | 25 | 0 | 0 | 0 | 25 | 0 |
| @corum/corum-extension-registry | agent | needs-mapping | — | 8 | 0 | 0 | 0 | 8 | 0 |
| @corum/corum-fs-local | agent | explicit | packages/fs/fs-local | 13 | 2 | 0 | 6 | 4 | 1 |
| @corum/corum-git-core | agent | needs-mapping | — | 8 | 0 | 0 | 0 | 8 | 0 |
| @corum/corum-goal-round-driver | agent | corum-only | — | 6 | 0 | 0 | 0 | 6 | 0 |
| @corum/corum-mcp-manager | agent | needs-mapping | — | 23 | 0 | 0 | 0 | 23 | 0 |
| @corum/corum-memory | agent | corum-only | — | 23 | 0 | 0 | 0 | 23 | 0 |
| @corum/corum-ollama | agent | corum-only | — | 10 | 0 | 0 | 0 | 10 | 0 |
| @corum/corum-orchestration | agent | corum-only | — | 11 | 0 | 0 | 0 | 11 | 0 |
| @corum/corum-platform | agent | corum-only | — | 12 | 0 | 0 | 0 | 12 | 0 |
| @corum/corum-preset-modules | agent | needs-mapping | — | 19 | 0 | 0 | 0 | 19 | 0 |
| @corum/corum-sandbox-local | agent | explicit | packages/sandbox/sandbox-local | 16 | 0 | 0 | 4 | 4 | 8 |
| @corum/corum-skill-manager | agent | needs-mapping | — | 8 | 0 | 0 | 0 | 8 | 0 |
| @corum/corum-subagent | agent | explicit | packages/subagent/subagent | 90 | 2 | 0 | 29 | 28 | 31 |
| @corum/corum-todo-guard | agent | corum-only | — | 5 | 0 | 0 | 0 | 5 | 0 |
| @corum/corum-tool-subagent | agent | explicit | packages/subagent/tool-subagent | 43 | 2 | 0 | 6 | 25 | 10 |
| @corum/corum-tools | agent | explicit | packages/core/tools | 28 | 8 | 0 | 13 | 3 | 4 |
| @corum/corum-update-checker | agent | corum-only | — | 12 | 0 | 0 | 0 | 12 | 0 |
| @corum/corum-web-search | agent | needs-mapping | — | 13 | 0 | 0 | 0 | 13 | 0 |
| @corum/corum-session-archive | session | needs-mapping | — | 17 | 0 | 0 | 0 | 17 | 0 |
| @corum/corum-session-queue-revert | session | corum-only | — | 7 | 0 | 0 | 0 | 7 | 0 |
| @corum/corum-ui-approval | session | explicit | packages/client/ui-approval | 11 | 3 | 0 | 7 | 0 | 1 |
| @corum/corum-ui-chat | session | explicit | packages/client/ui-chat | 252 | 9 | 5 | 66 | 72 | 100 |
| @corum/corum-ui-commit-card | session | needs-mapping | — | 15 | 0 | 0 | 0 | 15 | 0 |
| @corum/corum-ui-conversation | session | explicit | packages/client/ui-conversation | 167 | 10 | 0 | 53 | 20 | 84 |
| @corum/corum-ui-model-ask | session | corum-only | — | 14 | 0 | 0 | 0 | 14 | 0 |
| @corum/corum-ui-model-selection | session | explicit | packages/client/ui-model-selection | 19 | 2 | 0 | 11 | 0 | 6 |
| @corum/corum-ui-questions | session | explicit | packages/client/ui-user-questions | 32 | 2 | 0 | 4 | 8 | 18 |
| @corum/corum-ui-settings-models | session | explicit | packages/client/ui-settings-models | 64 | 5 | 0 | 21 | 18 | 20 |
| @corum/corum-ui-settings-plugins | session | explicit | packages/client/ui-settings-plugins | 26 | 2 | 0 | 7 | 15 | 2 |
| @corum/corum-ui-trajectory | session | explicit | packages/client/ui-trajectory | 57 | 12 | 1 | 27 | 2 | 15 |
| @corum/corum-ide-explorer-ui | ui | needs-mapping | — | 8 | 0 | 0 | 0 | 8 | 0 |
| @corum/corum-ide-integrations-pages-ui | ui | needs-mapping | — | 25 | 0 | 0 | 0 | 25 | 0 |
| @corum/corum-ide-integrations-ui | ui | needs-mapping | — | 8 | 0 | 0 | 0 | 8 | 0 |
| @corum/corum-ide-panel-bottom-ui | ui | needs-mapping | — | 8 | 0 | 0 | 0 | 8 | 0 |
| @corum/corum-ide-plugin-manager-ui | ui | needs-mapping | — | 9 | 0 | 0 | 0 | 9 | 0 |
| @corum/corum-ide-sidebar-ui | ui | needs-mapping | — | 9 | 0 | 0 | 0 | 9 | 0 |
| @corum/corum-ide-statusbar-ui | ui | needs-mapping | — | 10 | 0 | 0 | 0 | 10 | 0 |
| @corum/corum-ide-test-conversation-ui | ui | corum-only | — | 8 | 0 | 0 | 0 | 8 | 0 |
| @corum/corum-ide-test-sidebar-ui | ui | corum-only | — | 8 | 0 | 0 | 0 | 8 | 0 |
| @corum/corum-ide-test-statusbar-ui | ui | corum-only | — | 9 | 0 | 0 | 0 | 9 | 0 |
| @corum/corum-ide-ui | ui | needs-mapping | — | 83 | 0 | 0 | 0 | 83 | 0 |
| @corum/corum-issue-reporter-ui | ui | corum-only | — | 14 | 0 | 0 | 0 | 14 | 0 |
| @corum/corum-rpc-client | ui | needs-mapping | — | 3 | 0 | 0 | 0 | 3 | 0 |
| @corum/corum-ui-base | ui | needs-mapping | — | 25 | 0 | 0 | 0 | 25 | 0 |
| @corum/corum-ui-titlebar | ui | needs-mapping | — | 11 | 0 | 0 | 0 | 11 | 0 |

## Needs-Mapping Packages

| Package | Path | Group | Reason |
|---|---|---|---|
| @corum/corum-extension-pack | packages/plugins/agent/corum-extension-pack | agent | 可能对应官方 extension 相关包，待确认 |
| @corum/corum-extension-registry | packages/plugins/agent/corum-extension-registry | agent | 可能对应官方 extension 相关包，待确认 |
| @corum/corum-git-core | packages/plugins/agent/corum-git-core | agent | 可能对应官方 git 相关包，待确认 |
| @corum/corum-mcp-manager | packages/plugins/agent/corum-mcp-manager | agent | 可能对应官方 mcp 相关包，待确认 |
| @corum/corum-preset-modules | packages/plugins/agent/corum-preset-modules | agent | 可能对应官方 preset 相关包，待确认 |
| @corum/corum-skill-manager | packages/plugins/agent/corum-skill-manager | agent | 可能对应官方 skill 相关包，待确认 |
| @corum/corum-web-search | packages/plugins/agent/corum-web-search | agent | 可能对应官方 web-search 相关包，待确认 |
| @corum/corum-session-archive | packages/plugins/session/corum-session-archive | session | 待确认官方对应 |
| @corum/corum-ui-commit-card | packages/plugins/session/corum-ui-commit-card | session | 待确认官方对应 |
| @corum/corum-ide-explorer-ui | packages/plugins/ui/corum-ide-explorer-ui | ui | 可能对应官方 IDE UI 包，待确认 |
| @corum/corum-ide-integrations-pages-ui | packages/plugins/ui/corum-ide-integrations-pages-ui | ui | 待确认官方对应 |
| @corum/corum-ide-integrations-ui | packages/plugins/ui/corum-ide-integrations-ui | ui | 待确认官方对应 |
| @corum/corum-ide-panel-bottom-ui | packages/plugins/ui/corum-ide-panel-bottom-ui | ui | 待确认官方对应 |
| @corum/corum-ide-plugin-manager-ui | packages/plugins/ui/corum-ide-plugin-manager-ui | ui | 可能对应 packages/client/ui-plugin-manager，待确认 |
| @corum/corum-ide-sidebar-ui | packages/plugins/ui/corum-ide-sidebar-ui | ui | 待确认官方对应 |
| @corum/corum-ide-statusbar-ui | packages/plugins/ui/corum-ide-statusbar-ui | ui | 待确认官方对应 |
| @corum/corum-ide-ui | packages/plugins/ui/corum-ide-ui | ui | 可能对应 packages/client/ui-settings-shell 或复合包，待确认 |
| @corum/corum-rpc-client | packages/plugins/ui/corum-rpc-client | ui | 待确认官方对应（可能 dsh-client/connection） |
| @corum/corum-ui-base | packages/plugins/ui/corum-ui-base | ui | 可能对应 dsh-client-ui-slots / dsh-client-ui-theme，待确认 |
| @corum/corum-ui-titlebar | packages/plugins/ui/corum-ui-titlebar | ui | 待确认官方对应 |

## Usage

- Each `docs/fork-delta/inventory/<pkg>.json` contains the per-file machine classification.
- `needs-mapping.json` lists packages where the official counterpart could not be determined automatically.
- These packages require manual mapping verification before rebase (see 05-fork-rebase.md §4.0 步骤 0d).
- Gates (`typecheck/build/test/drift`) and `stage3Status` are updated per-package as rebase proceeds (initial snapshot = all pending; E 四包已收口为 pass).
- The `drift` gate refers to **guard 16 (SUBAGENT_DELTA partition)** for subagent packages — it is not the full-repo drift. Full-repo drift has its own phase-3 gate (currently 1 fail: sandbox-local, D task).
- File classification rules:
  - `identical`: byte-for-byte same (cmp -s)
  - `import-rename`: only differences are @deepseek-ai/dsh-* → @corum/corum-* package name changes
  - `substantive`: has real logic/CSS/locale differences
  - `corum-new`: official has no corresponding file
  - `official-deleted`: file exists in official but not in corum