/**
 * @corum/corum-orchestration — 子 Agent 编排器独立包入口。
 *
 * 从 @corum/corum-tool-subagent 拆出的编排层（docs/plan/PLAN-refactor-
 * orchestration-package-and-settings-center.md 重构 1）：台账状态（红线 1 合规的
 * cordis 服务）+ worktree 编排纯函数 + 台账持久化 domain 的单一事实源。
 *
 * 挂载方式（用户选定「新包自己挂 cordis 行 provide」）：
 * - `cordis.patch.yml` 的 insert 段挂本包行（name `@corum/corum-orchestration`），
 *   行序**必须**在 corum-tool-subagent 的 preset 双实例 apply 之前；
 * - 本 apply 在根上下文幂等 provide `corumOrchestration`（get-or-create）；
 * - tool-subagent 的 apply 改为「只读不建」（`ctx.root.get('corumOrchestration')`，
 *   缺则抛装配错误——顺序由 patch.yml 行序承担）。
 *
 * 服务名 `corumOrchestration` 不变，消费方零感知。纯函数/类型/domain 全量
 * re-export，tool-subagent 的 `orchestration.ts` 改为从本包 re-export 保持
 * 内部 import 路径与单测 `from '../src/orchestration.ts'` 不变（零破坏）。
 *
 * @module @corum/corum-orchestration
 */

import type { Context } from '@deepseek-ai/cordis'
import { CorumOrchestration } from './orchestration.ts'

/** cordis 插件名（patch.yml insert 行的 name 即包名，本常量仅声明用途）。 */
export const name = 'corum-orchestration'

/**
 * 在根上下文幂等 provide 编排器 service（已 provide 则复用）。
 * 挂到根上下文：台账语义是会话级（key=父 session id），必须跨会话/跨 bundle 单例
 * 共享（红线 1）。新包独立挂载后，tool-subagent 只读消费，不再自建兜底。
 */
export function apply(ctx: Context): void {
  const orchestration = ctx.root.get('corumOrchestration', false) as CorumOrchestration | undefined
    ?? new CorumOrchestration(ctx.root)
  void orchestration
}

export {
  CORUM_DELEGATED_CHILD_ESCALATION_LINE,
  CORUM_EXECUTION_DISCIPLINE_SECTION,
  corumEfficiencyDisciplineLines,
  corumExecutionDisciplineText,
  corumMinimalDisciplineLines,
  corumSandboxEscalationLines,
  type SandboxEscalationOptions,
} from './execution-discipline.ts'

export {
  CorumOrchestration,
  // fork（corum）2026-09-16：集成被机制拒绝的**类型化**错误——调用方据 `kind` 区分
  // 「分支没进 HEAD」与「进了 HEAD 但声明式 verify 没过」（两者的通知与出路相反）。
  CorumIntegrateRejected,
  corumBranchIntegrated,
  corumBranchMerged,
  corumCleanupLedgerEntries,
  corumCleanupWorktree,
  corumDetectIntegrateChecks,
  corumEffectiveToolFilter,
  corumEntryDead,
  corumGit,
  corumGitHead,
  corumGitStatusPorcelain,
  corumDirtyOwnershipLines,
  corumIntegrationFailure,
  // fork（corum）2026-09-16：机制侧 verify 门禁——集成总判定 = git 实况 ∧ 声明式 verify
  // 退出码（根因：真值门禁只判 git，verify 失败被「合并提交进了 HEAD」盖过）。
  corumIntegrationVerdict,
  corumRunIntegrateVerify,
  // fork（corum）2026-11-05：verify 外壳候选表（win32 = pwsh → powershell → cmd，POSIX =
  // bash → sh）。抽成导出纯函数是为了让三平台口径在任意平台上都可单测。
  corumVerifyShellCandidates,
  corumVerifyFailureNotice,
  corumResolveRejectedIntegration,
  CORUM_INTEGRATE_VERIFY_TIMEOUT_MS,
  corumMutationToolsForPlatform,
  corumReapRestoredEntries,
  corumReapOrphanWorktrees,
  corumListIsolatedWorktrees,
  corumBranchAddsCommits,
  corumBranchTip,
  // fork（corum）2026-09-20：集成判定按条目 + 分支 tip 快照——修「集成实际成功却被
  // 误判未落地」（集成者 merge 后合规 `branch -D`，按分支名判定必然假阴）。
  corumEntryIntegrated,
  corumShaInHead,
  corumSnapshotBranchTips,
  corumReconcileIntegrated,
  corumMergedBranches,
  corumIntegrationTruth,
  corumPartialIntegrationNotice,
  corumPortBranchDiff,
  corumPortPendingBranches,
  corumMergeBase,
  corumIntegratorPersona,
  // fork（corum）2026-10：编排收尾节点（closer）——黑盒化后整次编排统一结算的那一个角色。
  corumCloserPersona,
  corumOrchestrateReportPath,
  corumWriteOrchestrateReport,
  // fork（corum）2026-10 修复②：closer 成功后按台账实况作废「待集成」类内部说明。
  corumDropResolvedIntegrationNotes,
  corumPendingBranchesOf,
  // fork（corum）2026-10 修复③（B 方案）：单个 research 子 Agent 的报告落盘。
  corumResearchReportPath,
  corumWriteReportFile,
  corumDirectWriteNotice,
  type CorumDirectWriteReason,
  corumIsGitRepo,
  corumIsolationBoundaryNotice,
  corumIsolationNotice,
  corumIsWriteTask,
  corumMarkSettled,
  corumNarrowDenyFilter,
  corumPendingIntegration,
  corumResearchToolFilter,
  corumShouldIsolate,
  corumCommitWorktreeOnSettle,
  CORUM_AUTO_COMMIT_SUBJECT,
  corumDirtyParentRefusal,
  corumVisibleToolNames,
  corumWorktreeHasUncommitted,
  corumWriteToolsForPlatform,
  corumOrchestrationDomainSpec,
} from './orchestration.ts'
// fork（corum）2026-09-22：隔离写边界（正交轴 + 纵深防御门禁）——`corum-agent` 与
// `corum-subagent` 都依赖本包，写形态判定与越界判定因此只能是这一份实现
// （docs/dev-conventions §4a 的「两处对账」纪律：单一事实源在本层）。
export {
  MUTATION_TOOL_PATH_ARGS,
  absolutePathsIn,
  confinementGuard,
  confinementTempRoots,
  confinementViolation,
  detectBashWrite,
  gitRepoSideEffects,
  isPathInside,
  stripQuoted,
} from './confinement.ts'
export type {
  ConfinementExecution,
  ConfinementScope,
  ConfinementViolation,
  ConfinementViolationKind,
} from './confinement.ts'
export type {
  // fork（corum）2026-10：收尾节点（closer）的入参形状与三态场景。
  CorumCloserScenario,
  CorumCloserTaskRef,
  CorumWorktreeChild,
  CorumChildSpawnFacts,
  CorumSettleCommitFailure,
  CorumWorktreeChildOptions,
  CorumCleanupOptions,
  CorumIntegrationTruth,
  CorumVerifyResult,
  CorumWorktreeEntry,
  CorumWorktreeLedgerFrame,
  CorumLedgerRecord,
} from './orchestration.ts'
