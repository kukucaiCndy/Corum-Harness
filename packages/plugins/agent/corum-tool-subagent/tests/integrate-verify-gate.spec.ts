/**
 * fork（corum）**声明式 verify 门禁**单测（2026-09-16 根因修复）。
 *
 * ## 事故（用户实测，本 spec 逐环设防）
 *
 * 会话 `corum-task-b7122dc0`（`/tmp/corum-bugb2`）声明：
 * `merge.verify = test -f u1.md && test -f u2.md && test -f zzz.md`（`zzz.md` 不存在）。
 * 集成者合并两个分支后**如实**跑了 verify、拿到 exit 1、也按 persona 纪律没再提交——
 * 但 `git merge --no-ff` 产生的**合并提交自己就是提交**：分支工作已经进了 HEAD，于是只判
 * git 实况的 `corumIntegrationTruth` 报 `integrated === true`，机制对外宣告
 * 「merged + committed into the main tree」——**verify 的失败被完全忽略**。
 *
 * 同一形态在会话 `corum-task-d0a24b08` 却被正确拦住，唯一差别是那次集成者用了
 * `git merge --no-commit`（分支 tip 没进 HEAD，真值门禁兜住了）——**成败取决于子 Agent
 * 偶然选了哪条 git 命令**。这正是红线「机制优先于提示词」禁止的形态：verify 是否执行、
 * 退出码是否被检查，此前只写在 persona 提示词里，机制侧零断言。
 *
 * ## 本 spec 的设防
 *   1. `corumRunIntegrateVerify` — 机制自己跑声明，**取退出码**（0 通过 / 非 0 不通过 /
 *      超时不通过）。
 *   2. `corumIntegrationVerdict` — 总判定 = git 实况 **∧** verify 退出码；并断言
 *      「真值 true 而 verdict false」这个**事故形态本身**（最关键的回归锚点）。
 *   3. `corumVerifyFailureNotice` — 失败报告必须说清「分支**已经**在 HEAD 里」，不能
 *      与 `corumIntegrationFailure`（分支没进 HEAD）混同——两者的出路相反。
 *   4. persona — 必须指示「用 `git merge --no-commit` 先合后验再提交」（把事故的**触发
 *      条件**也消掉，而不只是事后拦住）。
 * 全部用真实临时 git 仓库驱动（无 mock），与 execute 层同一 git 命令面。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * 声明式 verify 由机制在**平台 shell** 里执行（win32 = pwsh，POSIX = bash），
 * 所以断言里的命令文本必须按平台给：`test -f` / `>&2` 是 bash 形态，pwsh 不认
 * （2026-10-21 三平台门禁 Windows leg 实测）。
 */
const WIN = process.platform === 'win32'
import {
  CORUM_INTEGRATE_VERIFY_TIMEOUT_MS,
  corumGit,
  corumGitHead,
  corumGitStatusPorcelain,
  corumIntegrationFailure,
  corumIntegrationTruth,
  corumIntegrationVerdict,
  corumIntegratorPersona,
  corumResolveRejectedIntegration,
  corumRunIntegrateVerify,
  corumVerifyFailureNotice,
  type CorumWorktreeEntry,
} from '../src/index.ts'

const scratchDirs: string[] = []

/** 建一个真实 git 仓库 + 一个隔离 worktree/分支（复刻 spawnOne 的创建命令）。 */
function makeRepoWithWorktree(slug = 'wt-verify01'): {
  repo: string
  worktree: string
  branch: string
  entry: CorumWorktreeEntry
} {
  const scratch = mkdtempSync(join(tmpdir(), 'corum-verify-gate-'))
  scratchDirs.push(scratch)
  const repo = join(scratch, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@corum.local'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'corum-test'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })
  // 机制在 init 时写 `.corum-worktrees/` 的 ignore（git-core `ensureWorktreeGitignore`，
  // 2026-09-16 Bug A 的根治）。本 fixture 复刻它，否则建 worktree 后主树会带
  // `?? .corum-worktrees/`——那会污染「合并提交让树变干净」这一断言（事故形态的一环）。
  writeFileSync(join(repo, '.gitignore'), '.corum-worktrees/\n')
  execFileSync('git', ['-C', repo, 'add', '.gitignore'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'ignore corum worktrees'], { stdio: 'pipe' })
  const branch = `wt/${slug}`
  const worktree = join(repo, '.corum-worktrees', slug)
  corumGit(repo, ['worktree', 'add', '-q', worktree, '-b', branch])
  return { repo, worktree, branch, entry: { slug, branch, path: worktree, status: 'settled' } }
}

/** 在 worktree 里写文件并提交（子 Agent 的正常产出形态）；返回提交 sha。 */
function commitInWorktree(worktree: string, file: string): string {
  writeFileSync(join(worktree, file), 'child payload\n')
  execFileSync('git', ['-C', worktree, 'add', '-A'], { stdio: 'pipe' })
  execFileSync('git', ['-C', worktree, 'commit', '-q', '-m', `add ${file}`], { stdio: 'pipe' })
  return execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

/** 别名：语义与 {@link commitInWorktree} 相同，仅在测试里强调「要 tip sha」。 */
const commitInWorktree2 = commitInWorktree

/** 主树是否处于未结清的合并（MERGE_HEAD 存在）。 */
function mergeHead(repo: string): boolean {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** 分支是否还存在（解卡安全阀的判定面）。 */
function branchExists(repo: string, branch: string): boolean {
  return execFileSync('git', ['-C', repo, 'branch', '--list', branch], { encoding: 'utf8' }).trim() !== ''
}

/**
 * 复刻事故现场的**关键一步**：集成者用 `git merge --no-ff`——合并即提交，分支工作落进
 * HEAD，主树**干净**。这正是「真值门禁报 true 而 verify 失败」的成因。
 */
function mergeWithCommit(repo: string, branch: string): void {
  corumGit(repo, ['merge', '--no-ff', '-m', `merge(${branch})`, branch])
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('corumRunIntegrateVerify — 机制自己跑声明并取退出码', () => {
  it('退出码 0 → ok=true', () => {
    const { repo } = makeRepoWithWorktree()
    const result = corumRunIntegrateVerify(repo, 'exit 0')
    expect(result.ok).toBe(true)
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  it('退出码非 0 → ok=false（这是「verify 失败」的机器判据）', () => {
    const { repo } = makeRepoWithWorktree()
    const result = corumRunIntegrateVerify(repo, 'exit 1')
    expect(result.ok).toBe(false)
    expect(result.code).toBe(1)
    expect(result.timedOut).toBe(false)
  })

  it('shell 表达式按整体求值（`a && b` 不按 argv 拆词）', () => {
    const { repo } = makeRepoWithWorktree()
    writeFileSync(join(repo, 'u1.md'), '1')
    // 事故里那条声明的形态：前两项成立、第三项不成立 ⇒ 整体 exit 1。
    // ⚠️ 断言用**平台对应的 shell 语法**：`corumRunIntegrateVerify` 在 win32 走 pwsh、
    // POSIX 走 bash（实现按平台分派），而 `test -f` / `>&2` 都是 bash 形态，
    // 在 pwsh 上不成立（2026-10-21 Windows 门禁实测）。
    const exists = (file: string): string => WIN ? `if (-not (Test-Path '${file}')) { exit 1 }` : `test -f ${file}`
    const failing = corumRunIntegrateVerify(repo, `${exists('u1.md')} && ${exists('zzz.md')}`)
    expect(failing.ok).toBe(false)
    expect(failing.code).toBe(1)
    const passing = corumRunIntegrateVerify(repo, exists('u1.md'))
    expect(passing.ok).toBe(true)
  })

  it('把被跑命令的失败输出带回（报告要能给人看）', () => {
    const { repo } = makeRepoWithWorktree()
    const result = corumRunIntegrateVerify(repo, WIN
      ? '[Console]::Error.WriteLine("boom: zzz.md is missing"); exit 3'
      : 'echo "boom: zzz.md is missing" >&2; exit 3')
    expect(result.ok).toBe(false)
    expect(result.code).toBe(3)
    expect(result.output).toContain('boom: zzz.md is missing')
  })

  it('超时 → ok=false 且 timedOut=true（超时不等于成功；与「命令自己失败」可区分）', () => {
    const { repo } = makeRepoWithWorktree()
    const result = corumRunIntegrateVerify(repo, 'sleep 5', 300)
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.code).toBe(-1)
  })

  it('默认超时有界（不能把一次 orchestrate 挂成永远运行中）', () => {
    expect(CORUM_INTEGRATE_VERIFY_TIMEOUT_MS).toBeGreaterThan(0)
    expect(Number.isFinite(CORUM_INTEGRATE_VERIFY_TIMEOUT_MS)).toBe(true)
  })
})

describe('corumIntegrationVerdict — 集成总判定 = git 实况 ∧ 声明式 verify', () => {
  // ★ 本文件最重要的回归锚点：直接钉住事故形态本身。
  it('★ 事故形态：`git merge` 已让分支进 HEAD（真值 true）+ verify 失败 ⇒ verdict 必须 false', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'u1.md')
    mergeWithCommit(repo, branch)

    // 修复前：只判 git 实况 ⇒ integrated=true、主树干净 ⇒ 机制报「merged + committed」。
    const truthOnly = corumIntegrationTruth(repo, [entry])
    expect(truthOnly.integrated).toBe(true)
    expect(truthOnly.unmerged).toEqual([])
    expect(corumGitStatusPorcelain(repo).trim()).toBe('') // 合并提交自己让树变干净

    // 修复后：声明式 verify 参与判定 ⇒ 整体拒绝。
    const verdict = corumIntegrationVerdict(repo, [entry], '', 'test -f u1.md && test -f zzz.md')
    expect(verdict.truth.integrated).toBe(true) // 真值这一格**仍然**是 true（两个轴正交）
    expect(verdict.verify?.ok).toBe(false)
    expect(verdict.integrated).toBe(false) // ⇒ 机制不再宣告成功
  })

  it('声明式 verify 通过 → verdict true（不能把正常集成也拒了）', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'u1.md')
    mergeWithCommit(repo, branch)
    const verdict = corumIntegrationVerdict(repo, [entry], '', 'test -f u1.md')
    expect(verdict.verify?.ok).toBe(true)
    expect(verdict.integrated).toBe(true)
  })

  it('未声明 verify → 只按 git 实况判（探测式检查不进机制门禁）', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'u1.md')
    mergeWithCommit(repo, branch)
    for (const declared of [undefined, '', '   ']) {
      const verdict = corumIntegrationVerdict(repo, [entry], '', declared)
      expect(verdict.verify).toBeUndefined()
      expect(verdict.integrated).toBe(true)
    }
  })

  it('真值没过 → 不跑 verify（主树还没到该验收的状态，跑它是误导性成本）', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'u1.md') // 提交了但**没合并**
    // 命令若被执行会留下标记文件；断言它没被创建 ⇒ verify 确实没跑。
    const marker = join(repo, 'VERIFY-RAN')
    const verdict = corumIntegrationVerdict(repo, [entry], '', `touch ${JSON.stringify(marker)}`)
    expect(verdict.truth.integrated).toBe(false)
    expect(verdict.verify).toBeUndefined()
    expect(verdict.integrated).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })

  it('`--no-commit` 形态（d0a24b08）同样被拒——两条路都拦住，成败不再取决于集成者的 git 命令', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'u1.md')
    // 集成者先合不提交（旧机制唯一兜得住的形态）。
    corumGit(repo, ['merge', '--no-commit', '--no-ff', branch])
    const verdict = corumIntegrationVerdict(repo, [entry], '', 'test -f zzz.md')
    expect(verdict.integrated).toBe(false)
    // 这一形态下真值本就 false（分支 tip 没进 HEAD）——与上一例的 true 形成对照，
    // 正是「同一失败原因、两种真值」的证明。
    expect(verdict.truth.integrated).toBe(false)
  })
})

describe('corumVerifyFailureNotice — 与「分支没进 HEAD」是两种形态，出路相反', () => {
  function accident(): { repo: string; entry: CorumWorktreeEntry; headBefore: string } {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'u1.md')
    const headBefore = corumGitHead(repo)
    mergeWithCommit(repo, branch)
    return { repo, entry, headBefore }
  }

  it('说清「分支已经进了主树」，并指出机制不替调用方回滚历史', () => {
    const { repo, entry, headBefore } = accident()
    const verify = corumRunIntegrateVerify(repo, 'test -f zzz.md')
    const truth = corumIntegrationTruth(repo, [entry])
    const notice = corumVerifyFailureNotice(verify, truth, headBefore, [entry])
    expect(notice).toContain('REJECTED by the declared verification')
    expect(notice).toContain('every pending branch IS in the main tree')
    expect(notice).toContain('does NOT rewrite main-tree history')
    expect(notice).toContain('test -f zzz.md')
    expect(notice).toContain('exit code: 1')
    // 工作没丢（合并提交在主树历史里）——这是本形态与真值失败最重要的区别。
    expect(notice).toContain('the WORK IS NOT LOST')
  })

  it('⚠️ **不得**承诺「现场已保留」（实机纠正：本形态下分支已并入 HEAD，会被正常回收）', () => {
    const { repo, entry, headBefore } = accident()
    const verify = corumRunIntegrateVerify(repo, 'test -f zzz.md')
    const truth = corumIntegrationTruth(repo, [entry])
    const notice = corumVerifyFailureNotice(verify, truth, headBefore, [entry])
    // 实测 corum-task-4e821e74：报告写 PRESERVED，而 `git branch` 已只剩 main——
    // 清理安全阀只保护「未并入 HEAD」的分支，而本形态的分支恰好已并入。
    expect(notice).not.toContain('PRESERVED')
    expect(notice).toContain('may already be RECLAIMED')
    // 出路必须指向「在主树里修 + 自己重跑验证」，而不是「重跑 integrate」
    //（后者会因无 pending 条目短路，实机已验证）。
    expect(notice).toContain('IN THE MAIN TREE')
  })

  it('**不得**复用真值失败的第一句（那会谎报「分支没进主树」，把主 Agent 引去重做合并）', () => {
    const { repo, entry, headBefore } = accident()
    const verify = corumRunIntegrateVerify(repo, 'test -f zzz.md')
    const truth = corumIntegrationTruth(repo, [entry])
    const verifyNotice = corumVerifyFailureNotice(verify, truth, headBefore, [entry])
    const unmergedNotice = corumIntegrationFailure(truth, headBefore, [entry])
    // 真值失败的首句（本形态下是假话）。
    expect(unmergedNotice).toContain('integrate did not persist into the main tree')
    expect(verifyNotice).not.toContain('integrate did not persist into the main tree')
    // 2026-09-20：真值失败的第二句改为「无并入证据」表述，否定断言同步跟上旧+新两种
    // 措辞，否则这条守卫会在文案改动后**静默失去意义**（永远为真）。
    expect(verifyNotice).not.toContain('NO evidence of being integrated into HEAD')
    expect(verifyNotice).not.toContain('branches NOT integrated into HEAD')
    // 两份报告必须**不同**（否则调用方无从分辨该修什么）。
    expect(verifyNotice).not.toBe(unmergedNotice)
  })

  it('超时形态在报告里点名（不是「命令失败了」这种含糊话）', () => {
    const { repo, entry, headBefore } = accident()
    const verify = corumRunIntegrateVerify(repo, 'sleep 5', 300)
    const truth = corumIntegrationTruth(repo, [entry])
    const notice = corumVerifyFailureNotice(verify, truth, headBefore, [entry])
    expect(notice).toContain('KILLED')
    expect(notice).toContain('timeout')
  })
})

describe('persona — 与机制门禁一致，且不制造新的卡死形态', () => {
  it('指示「未结清合并必须收尾」——`--no-commit` 会留下 MERGE_HEAD，让后续 merge/commit 全失败', () => {
    const persona = corumIntegratorPersona([], [], 'parent', 'test -f u1.md')
    // 曾一度写成「必须用 `--no-commit`」。实测（corum-task-78da6133）那样会在 verify 失败被拒时
    // 留下未结清的合并现场，毒化后续每一轮集成——故改回「失败就别提交」，同时把「用了
    // --no-commit 就必须收尾」写成显式纪律（机制另有 corumResolveRejectedIntegration 兜底）。
    expect(persona).toContain('UNCONCLUDED merge')
    expect(persona).toContain('git merge --abort')
    expect(persona).toContain('do NOT commit')
    expect(persona).not.toContain('ORDER MATTERS')
  })

  it('声明机制会**重新跑**声明式 verify（不只是复核分支是否进 HEAD）', () => {
    const persona = corumIntegratorPersona([], [], 'parent', 'test -f u1.md')
    expect(persona).toContain('re-runs the declared verification itself')
    expect(persona).toContain('independently verifies')
  })

  it('破坏性 git 禁令与声明的 verify 原样注入均未回退', () => {
    const persona = corumIntegratorPersona([], [], 'parent', 'npm run verify-all')
    expect(persona).toContain('git reset --hard')
    expect(persona).toContain('git clean -fd')
    expect(persona).toContain('npm run verify-all')
  })
})

/**
 * 输出 schema ↔ 返回值对账（2026-09-16 实机复现抓到的**自身**缺陷）。
 *
 * 教训形态：本次修复给 `integration` 加了 `rejected` 字段（返回值 + render 投影都加了），
 * 却漏了工具声明的输出 schema——而那是 `additionalProperties: false`。后果不是「字段丢失」，
 * 而是 harness 用 `INVALID_TOOL_OUTPUT` **顶替整个 payload**：`results` 与 `integration`
 * 一起被吞（实机原文：`"value.integration.rejected" is not a declared property`）。
 * 这正是同文件注释里声称已修掉的 Bug B 的**反向形态**，且更隐蔽（错误信息里连任务成败都不提）。
 *
 * 本 spec 用源码扫描把「每次给 integration/结果加字段都要同步 schema」变成断言——
 * 这类漂移编译期不报、单测不覆盖，只有真机跑到那条分支才炸（就是这次的路径）。
 */
describe('输出 schema 与返回值/投影字段对齐（防 INVALID_TOOL_OUTPUT 整块吞结果）', () => {
  const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')

  /** 取出 orchestrate `output:` schema 里 `integration:` 那一段。 */
  function integrationSchemaBlock(): string {
    const anchor = 'integration: {\n                    type: \'object\''
    const start = SRC.indexOf(anchor)
    expect(start, `orchestrate output schema 的 integration 段未找到（锚点：${anchor}）`).toBeGreaterThanOrEqual(0)
    const end = SRC.indexOf('parentTreeTasks', start)
    expect(end).toBeGreaterThan(start)
    return SRC.slice(start, end)
  }

  it('integration schema 段确实是 additionalProperties: false（漂移的成因）', () => {
    expect(integrationSchemaBlock()).toContain('additionalProperties: false')
  })

  it('`rejected` 必须声明在 integration schema 里（本次实机踩的正是这一格）', () => {
    expect(integrationSchemaBlock()).toContain('rejected: { type: \'string\', enum: [\'unmerged\', \'verify\'] }')
  })

  /**
   * fork（corum）2026-10：**对齐对象改成 `closer`**（`merge` 字段取消后新增的收尾节点结果）。
   *
   * 旧断言钉的是 `integration` 的「schema ↔ catch 构造 ↔ render 投影」三处对齐。`integration`
   * 现在只为历史会话回放保留（新结果不再产生，见 render 里的 `@deprecated`），真正有漂移风险的
   * 对象换成了 `closer`——它同样是 `additionalProperties: false`，少声明一个字段就是
   * `INVALID_TOOL_OUTPUT` 整块吞结果（本仓已因同一形态栽过两次）。
   */
  it('schema 声明的每个 closer 字段，都在 runCloser 的构造与 render 投影里出现（三处对齐）', () => {
    const start = SRC.indexOf("closer: {\n                    type: 'object'")
    expect(start, 'orchestrate output schema 的 closer 段未找到').toBeGreaterThanOrEqual(0)
    // 取样终点必须是 **schema 里紧跟其后的 `script:` 段**——不能取 `parentTreeTasks`（太远，
    // 会把 script/integration 两个别的对象的字段一起算进来），也不能取 `integration: {`
    // （它前面还隔着 script 段）。第一次写这条断言时两种错锚都踩过。
    const end = SRC.indexOf("script: {\n                    type: 'object'", start)
    expect(end).toBeGreaterThan(start)
    const schema = SRC.slice(start, end)
    expect(schema).toContain('additionalProperties: false')
    // 字段名恒在**恰好 22 空格**缩进上（`closer:` 是 18、其 properties 是 20、字段是 22）。
    // ⚠️ 用 `[ ]` 而不是 `\s`：`\s` 会跨行吃掉换行，把字段名切错（第一次写这条断言就踩了）。
    const declared = [...schema.matchAll(/^ {22}(\w+):/gmu)].map(m => m[1])
    expect(declared.length).toBeGreaterThanOrEqual(6)
    // runCloser 的返回构造（成功路径 + 失败路径各一处）。
    const closerFnStart = SRC.indexOf('const runCloser = async (')
    expect(closerFnStart).toBeGreaterThanOrEqual(0)
    const closerFn = SRC.slice(closerFnStart, closerFnStart + 5200)
    const renderStart = SRC.indexOf('structured.closer = {')
    expect(renderStart).toBeGreaterThanOrEqual(0)
    const renderBlock = SRC.slice(renderStart, renderStart + 1200)
    for (const field of declared) {
      expect(closerFn, `schema 声明了 closer.${field}，但 runCloser 从不产出它`).toContain(field)
      expect(renderBlock, `schema 声明了 closer.${field}，但 render 投影没有透出它（模型/卡片读不到）`).toContain(`out.closer.${field}`)
    }
  })

  it('integration schema 仍与 render 投影对齐（历史会话回放路径）', () => {
    const schema = integrationSchemaBlock()
    const declared = [...schema.matchAll(/^\s{22}(\w+):/gmu)].map(m => m[1])
    expect(declared.length).toBeGreaterThanOrEqual(5)
    const renderStart = SRC.indexOf('structured.integration = {')
    expect(renderStart).toBeGreaterThanOrEqual(0)
    const renderBlock = SRC.slice(renderStart, renderStart + 900)
    for (const field of declared) {
      expect(renderBlock, `schema 声明了 integration.${field}，但 render 投影没有透出它`).toContain(`out.integration.${field}`)
    }
  })
})

/**
 * 被拒集成的**现场解卡**（2026-09-16 实机补）。
 *
 * 事故形态（`corum-task-78da6133`）：集成者按「先 `--no-commit` 合、验完再提交」办，
 * verify 失败被拒后主树**停在未结清的合并**（`MERGE_HEAD` 存在）——此后该树上**每一次**
 * merge/commit 都失败（`fatal: You have not concluded your merge`），包括下一轮 orchestrate
 * 的集成者与 turn-end 收口。那一轮的 `integration.error` 里因此同时出现「分支未进 HEAD」
 * 与「A u1.md」两条证据（半合的暂存态污染了判定）。
 *
 * 解卡必须**不丢工作**：被拒分支从未删除（提交仍在分支上，是工作的唯一副本），
 * `git merge --abort` 只回退本次合并引入的暂存/工作区改动。
 */
describe('corumResolveRejectedIntegration — 被拒后解卡，且不丢工作', () => {
  it('未结清的合并 → 解卡后 MERGE_HEAD 消失，后续 merge 可用', () => {
    const { repo, worktree, branch } = makeRepoWithWorktree('wt-unblock1')
    commitInWorktree(worktree, 'u1.md')
    corumGit(repo, ['merge', '--no-commit', '--no-ff', branch])
    // 未结清现场：MERGE_HEAD 在，git 明确拒绝后续操作。
    expect(corumGitHead(repo)).not.toBe('')
    expect(mergeHead(repo)).toBe(true)
    const failure = corumResolveRejectedIntegration(repo)
    expect(failure).toBeUndefined()
    expect(mergeHead(repo)).toBe(false)
    expect(corumGitStatusPorcelain(repo).trim()).toBe('')
  })

  it('**不丢工作**：分支（唯一副本）仍在，其提交仍可达', () => {
    const { repo, worktree, branch } = makeRepoWithWorktree('wt-unblock2')
    const tip = commitInWorktree2(worktree, 'u2.md')
    corumGit(repo, ['merge', '--no-commit', '--no-ff', branch])
    corumResolveRejectedIntegration(repo)
    // 分支还在，提交还在（解卡只回退「本次合并的暂存态」，不删分支）。
    expect(branchExists(repo, branch)).toBe(true)
    expect(execFileSync('git', ['-C', repo, 'cat-file', '-t', tip], { encoding: 'utf8' }).trim()).toBe('commit')
  })

  it('**不碰**合并前的在制品（与 persona 禁的 reset/checkout/clean/stash 语义不同）', () => {
    const { repo, worktree, branch } = makeRepoWithWorktree('wt-unblock3')
    commitInWorktree(worktree, 'u3.md')
    writeFileSync(join(repo, 'WIP-unrelated.txt'), 'mine, do not touch')
    corumGit(repo, ['merge', '--no-commit', '--no-ff', branch])
    corumResolveRejectedIntegration(repo)
    expect(readFileSync(join(repo, 'WIP-unrelated.txt'), 'utf8')).toBe('mine, do not touch')
  })

  it('无合并在进行 → no-op（返回 undefined，不误动工作区）', () => {
    const { repo } = makeRepoWithWorktree('wt-unblock4')
    const before = corumGitHead(repo)
    expect(corumResolveRejectedIntegration(repo)).toBeUndefined()
    expect(corumGitHead(repo)).toBe(before)
  })
})
