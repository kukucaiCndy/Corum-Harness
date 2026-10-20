/**
 * `@corum/corum-orchestration` 的**隔离写边界**单测（2026-09-22）。
 *
 * 由来：用户核对指挥模式 kimi 会话（`corum-task-ef3f751e`）时发现**硬隔离在
 * `danger-full-access` 下不成立**——隔离的第 2 层（fs 写沙箱）按档位开关，而档位是
 * 用户可覆盖的状态；实测同一个 brief 结构，`workspace-write` 派出的 worker 写主树
 * 报 EPERM（硬隔离生效），`danger-full-access` 派出的 worker 删掉 19 个 worktree 并对
 * 主树执行 `git -C <主树> merge --no-ff`。
 *
 * 修法 1+2（用户拍板）：
 *   ① 正交轴（`confinedSandbox`）——本文件不测（它在 corum-subagent 的 policy 捕获面）；
 *   ② 纵深防御门禁——**本文件测**：`confinementGuard` 的放行/拦截面。
 *
 * 本文件同时钉住那个**实测误报**：`echo '===a->b==='` 里的 `->` 曾被重定向正则当成
 * 重定向，导致一条纯只读命令被只读门禁拒绝（白烧一次往返）。
 */
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  absolutePathsIn,
  confinementGuard,
  confinementTempRoots,
  confinementViolation,
  detectBashWrite,
  isPathInside,
  stripQuoted,
} from '../src/index.ts'

/** 一个稳定的「worktree 根」缓存（只在词法层用，不需要真建目录）。 */
const WORKTREE = '/repo/.corum-worktrees/wt-abc123'
/** 同一仓的**主树**（= 越界目标）。 */
const MAIN = '/repo'

describe('stripQuoted — 引号字面量必须先剥（实测误报的根因）', () => {
  it('★ 单引号里的 `->` 不再被当成重定向（会话 corum-task-ef3f751e 的原始误报）', () => {
    // 原命令（真实来自该会话 turn 4 step 5，被 read-only 门禁误拒）
    const command = "cd /repo; echo '===saveProfileRemote->persist callsite==='; grep -n 'x' f.ts"
    expect(detectBashWrite(command)).toBeUndefined()
  })

  it('剥引号后引号内容被清空、引号本身保留', () => {
    expect(stripQuoted("echo 'a>b' \"c>d\"")).toBe("echo '' \"\"")
  })

  it('引号外的重定向仍然照旧被识别（不因剥引号而漏判）', () => {
    expect(detectBashWrite("echo 'a>b' > /tmp/out")).toBe('shell redirection writes to a file')
  })

  it('内联解释器的写盘特征长在引号里，故必须用未剥引号的原文判定', () => {
    // 若错误地对剥完引号的文本做 INLINE_WRITE_PATTERNS 判定，这条会漏判
    expect(detectBashWrite(`node -e "require('fs').writeFileSync('a','b')"`)).toBe('inline script writes to a file')
  })
})

describe('detectBashWrite — 承继既有语义（只读门禁与写边界门禁共用这一份）', () => {
  const reads: readonly string[] = [
    'ls -la',
    'git log --oneline -5',
    'git status --porcelain',
    'git diff HEAD~1',
    'grep -n "rm " f.ts',
    'cat f.ts | head -20',
    'echo done 2>&1',
    'grep -rn foo . > /dev/null',
  ]
  for (const command of reads) {
    it(`放行只读：${command}`, () => {
      expect(detectBashWrite(command)).toBeUndefined()
    })
  }

  const writes: readonly string[] = [
    'echo hi > /tmp/x',
    'rm -rf build',
    'git commit -m x',
    'git merge other',
    'sed -i s/a/b/ f.ts',
    'pnpm install',
    'mkdir -p out',
  ]
  for (const command of writes) {
    it(`拦下写形态：${command}`, () => {
      expect(detectBashWrite(command)).toBeDefined()
    })
  }

  describe('★ 选项带取值的形态（改动前就存在的漏判，2026-09-22 一并修掉）', () => {
    // 原实现取「第二个词」当子命令，于是 `git -C <dir> merge` 的第二个词是 `-C`，
    // 判不出写形态 ⇒ 这条越界命令在只读门禁下**从未被拦过**。实测会话
    // corum-task-ef3f751e 的 worker 正是用 `git -C <主树> merge --no-ff` 把分支并进主树。
    const withOptions: readonly [string, string][] = [
      ['git -C <主树> 的 merge（实测那条）', 'git -C /repo merge --no-ff rescue/x -m m'],
      ['git --git-dir=<主树>/.git 的 commit', 'git --git-dir=/repo/.git commit -m x'],
      ['git --git-dir <主树>/.git 的 commit（分列）', 'git --git-dir /repo/.git commit -m x'],
      ['git -c k=v 的 merge', 'git -c core.pager=cat merge other'],
    ]
    for (const [label, command] of withOptions) {
      it(`拦下：${label}`, () => {
        expect(detectBashWrite(command)).toBeDefined()
      })
    }

    it('带选项的**只读** git 命令仍然放行（不误伤）', () => {
      expect(detectBashWrite('git -C /repo log --oneline -5')).toBeUndefined()
      expect(detectBashWrite('git --git-dir=/repo/.git status --porcelain')).toBeUndefined()
    })
  })
})

describe('isPathInside / absolutePathsIn — 词法边界判定', () => {
  /**
   * ⚠️ 这两个函数都是**平台相关**的：`isPathInside` 用 `path.sep` 拼前缀、
   * `absolutePathsIn` 用 `path.resolve()` 归一。所以断言不能把 `/repo` 这类 POSIX
   * 常量直接当输入/期望——Windows 上 `path.sep` 是 `\`、`path.resolve('/repo')` 会
   * 补上当前盘符（实测返回 `D:\repo`），按原文比必挂（2026-10-21 三平台门禁首跑）。
   * 这里改成**按当前平台构造**输入与期望，POSIX 上的语义（等于/其下/兄弟前缀）不变。
   */
  it('等于是、其下是、兄弟前缀不是（`<root>/x` 不算在 `<root>` 内）', () => {
    // 用**POSIX 反例之外的平台无关 root**：`resolve('repo')` 在 POSIX 得到 `/cwd/repo`，
    // 但在 Windows 得到 `C:\cwd\repo`，而 `join(root,'a','b')` 也走 `\` ⇒ 两侧一致。
    const root = resolve('repo')
    expect(isPathInside(root, root)).toBe(true)
    expect(isPathInside(join(root, 'a', 'b'), root)).toBe(true)
    // 兄弟前缀：`<root>-x` 两种平台都不是 root 的后代（POSIX `sep='/'`，Windows `sep='\'`）。
    expect(isPathInside(`${root}-x`, root)).toBe(false)
  })

  it('提取独立参数、--opt=/abs、以及 `-C /abs` 形态的绝对路径', () => {
    // ⚠️ 命令文本里**保持 POSIX 字面量** `/repo`：`absolutePathsIn` 的正则只认 `/` 开头的
    // 路径（它在解析的是「一条 shell 命令的文本」），喂 `\repo` 会直接匹配不到 ⇒ 断言变成
    // 空跑。要按平台算的是**期望值**（实现内部会 `path.resolve` 它）。
    expect(absolutePathsIn('git -C /repo merge b')).toContain(resolve('/repo'))
    expect(absolutePathsIn('cp x --target=/repo/y')).toContain(resolve('/repo/y'))
    expect(absolutePathsIn('echo hi > /tmp/z')).toContain(resolve('/tmp/z'))
  })

  it('标记家目录简写（`~` 与 `$HOME`）', () => {
    expect(absolutePathsIn('cp x ~/f')).toContain('~')
    expect(absolutePathsIn('cp x $HOME/f')).toContain('~')
  })

  it('相对路径不参与判定（子会话 cwd 就是 worktree，相对路径天然在界内）', () => {
    expect(absolutePathsIn('echo hi > out.txt')).toEqual([])
  })
})

describe('confinementGuard — 隔离子会话的写边界（修法 2）', () => {
  const guard = confinementGuard({ worktreeRoot: WORKTREE, parentTreeRoot: MAIN })
  const bash = (command: string) => ({ name: 'bash', arguments: { command } })

  describe('变异工具：路径参数越界即拒', () => {
    it('★ 写主树被拒（这就是实测里 worker 干成的那件事）', () => {
      expect(guard({ name: 'write', arguments: { file_path: `${MAIN}/packages/x.ts`, content: 'x' } })).toBeDefined()
    })

    it('★ edit / str_replace_editor 同样受约束（两个工具的参数名不同，都要覆盖）', () => {
      expect(guard({ name: 'edit', arguments: { file_path: `${MAIN}/a.ts`, old_string: 'a', new_string: 'b' } })).toBeDefined()
      expect(guard({ name: 'str_replace_editor', arguments: { command: 'str_replace', path: `${MAIN}/a.ts`, old_str: 'a', new_str: 'b' } })).toBeDefined()
    })

    it('worktree 内的相对路径与绝对路径都放行', () => {
      expect(guard({ name: 'write', arguments: { file_path: 'src/a.ts', content: 'x' } })).toBeUndefined()
      expect(guard({ name: 'write', arguments: { file_path: `${WORKTREE}/src/a.ts`, content: 'x' } })).toBeUndefined()
    })

    it('★ 兄弟 worktree 也算越界（隔离是「自己的壳」，不是「所有壳」）', () => {
      expect(guard({ name: 'write', arguments: { file_path: `${MAIN}/.corum-worktrees/wt-other/f.ts`, content: 'x' } })).toBeDefined()
    })
  })

  describe('shell：只读一律放行，写形态才审越界', () => {
    it('★ `git -C <主树> merge` 被拒（实测里 worker 干成的第二件事）', () => {
      expect(guard(bash(`git -C ${MAIN} merge --no-ff rescue/x -m m`))).toBeDefined()
    })

    it('★ `rm -rf <主树>/.corum-worktrees/wt-*` 被拒（实测里 worker 删掉 19 个 worktree 的命令）', () => {
      expect(guard(bash(`rm -rf ${MAIN}/.corum-worktrees/wt-16fd74`))).toBeDefined()
    })

    it('★ worktree 外的重定向被拒', () => {
      expect(guard(bash(`echo hi > ${MAIN}/f.txt`))).toBeDefined()
    })

    it('★ 越界的家目录简写被拒', () => {
      expect(guard(bash('cp a ~/.corum/settings.yaml'))).toBeDefined()
    })

    it('只读命令放行——隔离**不**限制读（通知里明说 reads are still allowed）', () => {
      expect(guard(bash('git log --oneline -5'))).toBeUndefined()
      expect(guard(bash(`git -C ${MAIN} log --oneline -3`))).toBeUndefined()
      expect(guard(bash(`grep -rn foo ${MAIN}/packages | head`))).toBeUndefined()
    })

    it('worktree 内的写与提交放行（子 Agent 必须能在自己分支提交）', () => {
      expect(guard(bash('echo hi > out.txt'))).toBeUndefined()
      expect(guard(bash('git add -A && git commit -m x'))).toBeUndefined()
      expect(guard(bash(`echo hi > ${WORKTREE}/out.txt`))).toBeUndefined()
    })

    it('★ 临时区放行（/tmp 造 fixture 是 build/test 的常见需要，与官方可写根口径一致）', () => {
      expect(guard(bash('echo hi > /tmp/fixture.txt'))).toBeUndefined()
    })
  })

  describe('其它工具：不表态（abstain），不干扰机制自身的收尾', () => {
    it('read / grep / glob / send_message 一律放行', () => {
      for (const name of ['read', 'grep', 'glob', 'send_message', 'todo_write']) {
        expect(guard({ name, arguments: { path: `${MAIN}/x` } })).toBeUndefined()
      }
    })

    it('参数缺失或形态不符时不误判（宁可漏判也不误伤）', () => {
      expect(guard({ name: 'bash', arguments: {} })).toBeUndefined()
      expect(guard({ name: 'write', arguments: {} })).toBeUndefined()
      expect(guard({ name: 'bash', arguments: { command: 42 } })).toBeUndefined()
    })
  })

  describe('临时区允许集', () => {
    it('至少含平台临时根，且已 resolve 去重', () => {
      const roots = confinementTempRoots()
      expect(roots.length).toBeGreaterThan(0)
      // 实现是 `path.resolve('/tmp')` + `path.resolve(tmpdir())`；Windows 上前者解析成
      // `<当前盘>:\tmp`，所以期望必须按同一口径算（硬编码 '/tmp' 必挂）。
      expect(roots).toContain(resolve('/tmp'))
      expect(new Set(roots).size).toBe(roots.length)
    })
  })

  describe('★ 工作区落在临时区之内时仍须保护（本轮自查发现的弱点）', () => {
    // 由来：允许集含 /tmp 与 tmpdir()（造 fixture 的合法需要），但**工作区本身**可能就建在
    // 临时区里（本仓测试环境、以及用户把 workspace 放在 /tmp 的场景）。彼时若只按
    // 「worktree 之外都拦」，主树会因落在临时区允许集里而被放行 ⇒ 门禁等于没装。
    // 修法：`parentTreeRoot` **拒绝优先于允许**。
    // 主树落在临时区之内。**注意 tempBase 必须保持 POSIX 字面量 `/tmp/...`**：
    // 这两条断言走 shell 判定，而 `absolutePathsIn` 的正则只认 `/` 开头的路径——
    // 若换成 Windows 的 `D:\tmp\...`，命令文本里就没有可识别的绝对路径 ⇒ 门禁不表态
    // （2026-10-21 实测：改坏过一次，等于把断言变成空跑）。`confinementViolation`
    // 内部会对 candidate 做 `path.resolve`，POSIX 输入在 Windows 上同样能落进临时区。
    const tempBase = '/tmp/corum-ws'
    const wt = `${tempBase}/.corum-worktrees/wt-x`
    const guard = confinementGuard({ worktreeRoot: wt, parentTreeRoot: tempBase })

    it('★ 主树在 /tmp 下也照样被拒（不被临时区允许集吞掉）', () => {
      expect(guard({ name: 'write', arguments: { file_path: `${tempBase}/main.ts`, content: 'x' } })).toBeDefined()
      expect(guard({ name: 'bash', arguments: { command: `rm -rf ${tempBase}/.corum-worktrees/wt-16fd74` } })).toBeDefined()
      expect(guard({ name: 'bash', arguments: { command: `git -C ${tempBase} merge x` } })).toBeDefined()
    })

    it('worktree 自身与 /tmp 其它位置仍放行（不因新规则误伤）', () => {
      expect(guard({ name: 'write', arguments: { file_path: join(wt, 'f.ts'), content: 'x' } })).toBeUndefined()
      // 这条钉的是「临时区允许集里**任意**位置放行」，走的是 write 工具的路径参数
      // （不是命令文本 ⇒ 不受 absolutePathsIn 的 `/` 正则限制），故用平台口径拼：
      // Windows 上 tmpdir 与 /tmp 的解析结果不同，写死一个都不对。
      expect(guard({ name: 'write', arguments: { file_path: join(resolve('/tmp'), 'other-fixture.txt'), content: 'x' } })).toBeUndefined()
      expect(guard({ name: 'write', arguments: { file_path: join(tmpdir(), 'other-fixture.txt'), content: 'x' } })).toBeUndefined()
    })
  })

  describe('真目录端到端（不是纯字符串）', () => {
    it('★ 真建 worktree 与主树两个目录：主树文件被拒、worktree 文件放行', () => {
      // ⚠️ 必须建在**临时区之外**：`/tmp` 与 `tmpdir()` 属于允许集（造 fixture 的合法
      // 需要），用 mkdtempSync 建的「主树」会落在允许集里 ⇒ 这条断言测不出东西
      // （首版就是这么写的，被自己抓到）。这里用仓库内的相对落点并只做纯词法判定，
      // 不依赖真实仓库结构。
      const base = join(process.cwd(), '.corum-confinement-spec-main')
      const wt = join(base, '.corum-worktrees', 'wt-real')
      const realGuard = confinementGuard({ worktreeRoot: wt, parentTreeRoot: base })
      // 主树路径（base，不是 wt）应被拒——注意 tmpdir 在允许集内，故这个 base 必须不在其中
      expect(realGuard({ name: 'write', arguments: { file_path: join(base, 'main-tree.ts'), content: 'x' } })).toBeDefined()
      // worktree 内应放行
      expect(realGuard({ name: 'write', arguments: { file_path: join(wt, 'f.ts'), content: 'x' } })).toBeUndefined()
      // 从 worktree 用**相对 cd** 走到主树再删（端到端复刻实测里那条越界动作）。
      // 这里刻意不用 `git -C <绝对路径>`：`absolutePathsIn` 的正则只认 `/` 开头，而本用例
      // 的 base 在 Windows 上必然是 `D:\…` 形态（含盘符）⇒ 命令里抓不到绝对路径。相对
      // `cd` 走的是 `cdTargetsOf`（它自己 `path.resolve`），三平台都能测到判定逻辑。
      expect(realGuard({ name: 'bash', arguments: { command: 'cd ../.. && rm -rf main-tree.ts' } })).toBeDefined()
    })
  })
})

/**
 * 2026-09-27 用户裁定的两轴口径：**隔离 = 工作区隔离**（防并发改写互相踩），与「能不能碰
 * 仓外的东西」是两条正交的轴。因此：
 *   · 主仓（含共享 `.git` / 其它分支 / 其它 worktree）⇒ 硬拒，**不可提权获得**；
 *   · 主仓**之外**（另一个仓、系统路径……）⇒ 门禁**弃权**，交沙箱 + 审批（**可提权**）。
 * 本组用例同时钉住两处实测漏判：`cd <主仓>` 开头（会话 corum-task-56b7d485 三条越界命令
 * 全都这么写）与「无绝对路径的仓库级写」（01:11:30 那条 `git worktree remove` + `git branch -D`）。
 */
describe('★ 两轴口径（2026-09-27 用户裁定）：主仓硬线 vs 仓外交权限层', () => {
  const guard = confinementGuard({ worktreeRoot: WORKTREE, parentTreeRoot: MAIN })
  const bash = (command: string) => ({ name: 'bash', arguments: { command } })

  describe('T1：主仓**之外**的目标弃权（门禁不管，交权限层 ⇒ 可提权）', () => {
    // 由来：本场任务要把产物落到**另一个仓** `/Users/kukucai/work/Corum-Harness-Project`。
    // 旧口径把「worktree 之外」一律硬拒 ⇒ 子 Agent 带 danger-full-access 重试两次仍被
    // 同一句驳回，机制只能把搬运外包给用户。这类目标属于权限轴，门禁必须放手。
    const outside = [
      'mkdir -p /Users/kukucai/work/Corum-Harness-Project/packages/corum-project',
      'mv /repo/.corum-worktrees/wt-abc123/Corum-Harness-Project /Users/kukucai/work/Corum-Harness-Project',
      'rsync -a --delete /repo/.corum-worktrees/wt-abc123/Corum-Harness-Project/ /Users/kukucai/work/Corum-Harness-Project/',
    ]
    for (const command of outside) {
      it(`弃权（不再硬拒）：${command.slice(0, 52)}…`, () => {
        expect(guard(bash(command))).toBeUndefined()
        expect(confinementViolation({ worktreeRoot: WORKTREE, parentTreeRoot: MAIN }, bash(command))?.kind).toBe('outside')
      })
    }

    it('变异工具写仓外路径同样弃权（交沙箱判定）', () => {
      const call = { name: 'write', arguments: { file_path: '/Users/kukucai/work/Corum-Harness-Project/package.json', content: '{}' } }
      expect(guard(call)).toBeUndefined()
      expect(confinementViolation({ worktreeRoot: WORKTREE, parentTreeRoot: MAIN }, call)?.kind).toBe('outside')
    })

    it('仓外的只读命令与临时区照旧不表态', () => {
      expect(guard(bash('cd /tmp/scratch && echo hi > f.txt'))).toBeUndefined()
      expect(guard(bash('git -C /Users/kukucai/work/Corum-Harness-Project log --oneline -3'))).toBeUndefined()
    })
  })

  describe('T2a：`cd <主仓>` 本身即越界（它让后续相对路径写全落在主仓里）', () => {
    it('★ 实测那三条命令的开头（cd 主仓 + 相对路径 git worktree remove）', () => {
      expect(guard(bash(`cd ${MAIN} && git worktree remove --force .corum-worktrees/wt-471e5f`))).toBeDefined()
      expect(guard(bash(`cwd=$(pwd); cd ${MAIN} && git worktree remove --force .corum-worktrees/wt-471e5f`))).toBeDefined()
    })

    it('★ `cd ../..` 穿越到主仓同样被拒（不含任何绝对路径）', () => {
      expect(guard(bash('cd ../.. && rm -rf packages/plugins/agent/corum-agent/src/project.ts'))).toBeDefined()
      expect(guard(bash('cd .. && echo hi > main-tree-file.txt'))).toBeDefined()
    })

    it('子 shell 形态 `(cd <主仓> && …)` 也认得出', () => {
      expect(guard(bash(`(cd ${MAIN} && git commit -m x)`))).toBeDefined()
    })
  })

  describe('T2a：无绝对路径的**仓库级写**（共享 .git）硬拒', () => {
    const repoGlobal = [
      'git worktree remove --force .corum-worktrees/wt-471e5f',
      'git branch -D wt/wt-471e5f',
      'git branch new-branch',
      'git push origin main',
      'git fetch origin',
      'git tag v1.0.0',
      'git config user.name kukucaiCndy',
      'git remote add origin https://example.com/x.git',
      'git update-ref refs/heads/main HEAD~1',
      'git symbolic-ref HEAD refs/heads/other',
      'git submodule add https://example.com/x.git vendor/x',
      'git notes add -m x',
      'git reflog expire --expire=now --all',
      'git gc --prune=now',
      'git config --global user.name x',
      'git replace -d abc123',
      // 合并短开关里**含写**的组合仍然是写（别把 `-avv` 的豁免搞成对所有 `-xxx` 放行）。
      'git branch -dav',
      'git branch -Davv',
    ]
    for (const command of repoGlobal) {
      it(`拒：${command}`, () => {
        expect(guard(bash(command))).toBeDefined()
        expect(confinementViolation({ worktreeRoot: WORKTREE, parentTreeRoot: MAIN }, bash(command))?.kind).toBe('parent-tree')
      })
    }

    // 裁定的另一半是「**可读**」——只读形态必须继续放行，否则子 Agent 连自己所在仓库的
    // 分支列表、配置都读不到（本仓自己的 brief 纪律就要它们读这些）。
    const reads = [
      'git worktree list',
      `git -C ${MAIN} worktree list`,
      'git branch --list',
      `git -C ${MAIN} branch -a`,
      'git branch',
      'git config --get user.name',
      'git config -l',
      `git -C ${MAIN} remote -v`,
      'git tag -l',
      'git submodule status',
      'git notes show',
      'git reflog show',
      'git symbolic-ref HEAD',
      `git -C ${MAIN} symbolic-ref HEAD`,
      'git bisect log',
      // 自查到的**误伤面**（2026-09-27）：这些无 flag 的读法在只读门禁下极常用
      // （指挥模式主 Agent 的只读 shell / 研究子会话），把它们当写会白烧往返。
      'git config user.email',
      'git config --global user.email',
      `git -C ${MAIN} config user.email`,
      'git worktree',
      'git submodule',
      'git replace -l',
      'git bisect',
      'git branch --show-current',
      `git -C ${MAIN} remote show origin`,
      // 2026-09-27 实机误伤：隔离子会话按 brief 跑 `git branch -avv` 被硬拒——只读正则按整
      // token 匹配 `-a`/`-vv`，而 git 的短开关**可以合并**。凡「读+读」组合都该放行。
      'git branch -avv',
      `git -C ${MAIN} branch -avv`,
      'git branch -rv',
      'git branch -vvv',
      'git tag -l -n5',
    ]
    for (const command of reads) {
      it(`放行只读：${command}`, () => {
        expect(guard(bash(command))).toBeUndefined()
      })
    }

    it('detectBashWrite 同步认这些仓库级写（只读门禁也共用同一份判定）', () => {
      expect(detectBashWrite('git worktree remove --force x')).toBeDefined()
      expect(detectBashWrite('git branch -D x')).toBeDefined()
      expect(detectBashWrite('git -C /repo branch --list')).toBeUndefined()
      expect(detectBashWrite('git config --get user.name')).toBeUndefined()
    })
  })

  describe('T5 配套：worktree 内的**独立仓**不被当主仓写（用户裁定它是独立产物）', () => {
    it('在原位建嵌套仓放行（相对路径落在自己 worktree 内）', () => {
      expect(guard(bash('git init Corum-Harness-Project'))).toBeUndefined()
      expect(guard(bash('git init && git add -A && git commit -m skeleton'))).toBeUndefined()
    })

    it('★ `cd` 进 worktree 的子孙目录后操作那个仓的 config 不判主仓', () => {
      // 实测形态：子会话在自己的 worktree 里建闭源仓并设 git 身份。
      expect(guard(bash('cd Corum-Harness-Project && git config user.name "kukucaiCndy" && git add -A && git commit -m x'))).toBeUndefined()
    })

    it('但 `git config` 不 cd 就仍按主仓硬线处理（它打的是共享 .git/config）', () => {
      expect(guard(bash('git config user.name x'))).toBeDefined()
    })
  })

  describe('多目标命令按**最严**判定（否则 `cp 仓外 主仓` 会变成可提权）', () => {
    it('★ 同时含仓外与主仓目标 ⇒ parent-tree', () => {
      const command = `cp /Users/kukucai/elsewhere/x.ts ${MAIN}/packages/x.ts`
      expect(guard(bash(command))).toBeDefined()
      expect(confinementViolation({ worktreeRoot: WORKTREE, parentTreeRoot: MAIN }, bash(command))?.kind).toBe('parent-tree')
    })

    it('全部是仓外目标 ⇒ outside（不被最严规则误伤）', () => {
      const command = 'cp /Users/kukucai/a/x.ts /Users/kukucai/b/x.ts'
      expect(guard(bash(command))).toBeUndefined()
      expect(confinementViolation({ worktreeRoot: WORKTREE, parentTreeRoot: MAIN }, bash(command))?.kind).toBe('outside')
    })
  })
})
