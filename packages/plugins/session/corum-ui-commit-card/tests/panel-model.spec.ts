/**
 * Git 面板纯逻辑的回归网（2026-11-26）。
 *
 * ## 为什么测这三块
 *
 * 面板里会**静默出错**的只有三处，其余都是渲染：
 *   ① 提交信息按路径规则拼 —— 拼错的结果是一个语义错误的 commit，用户手滑点提交就进去了；
 *   ② 「下轮注入预览」必须与 host 真正注入的文本同构 —— 预览骗人的话，用户以为告诉了
 *      Agent，实际没告诉（或告诉错了），而这个错误只在 Agent 后续行为里暴露；
 *   ③ 面板三态（加载 / 非仓库 / 可操作 / 工作中）—— 工作中写操作必须全禁，这是需求
 *      裁决里唯一的安全约束（`docs/HANDOFF-2026-11-26-git-panel.md:§4.2`）。
 *
 * 这里不碰 React / RPC / jsdom：被测的是纯函数，渲染正确性留给实机验证。
 */
import { describe, expect, it } from 'vitest'
import type { ChangeEntry } from '../src/client/contract.ts'
import {
  INJECT_HEADER,
  buildInjectPreview,
  canWrite,
  describeBranchSwitch,
  describeCommit,
  inferCommitMessage,
  panelMode,
  statusBadge,
  sumSelected,
} from '../src/client/panel-model.ts'

/** 造一条改动记录。 */
function change(path: string, added = 0, deleted = 0, status = 'M'): ChangeEntry {
  return { path, status, added, deleted }
}

describe('inferCommitMessage（规则拼，不调 LLM）', () => {
  it('packages/<group>/<name> 取包名而不是分组名', () => {
    const msg = inferCommitMessage([change('packages/plugins/agent/corum-git-core/src/index.ts')])
    expect(msg).toBe('feat(corum-git-core): 手动提交 packages/plugins/agent/corum-git-core/src/index.ts')
  })

  it('packages/<name> 也能取到包名', () => {
    expect(inferCommitMessage([change('packages/desktop/src/main.ts')]))
      .toBe('feat(desktop): 手动提交 packages/desktop/src/main.ts')
  })

  it('模块根目录下的散文件不会把文件名当 scope', () => {
    const msg = inferCommitMessage([change('packages/desktop/cordis.patch.yml')])
    expect(msg).not.toContain('(cordis.patch.yml)')
    expect(msg).toBe('feat(desktop): 手动提交 packages/desktop/cordis.patch.yml')
  })

  it('tests 路径走 test 类型', () => {
    expect(inferCommitMessage([change('packages/plugins/session/corum-ui-chat/tests/foo.spec.ts')]))
      .toContain('test(corum-ui-chat)')
  })

  it('docs / scripts / .github 各自的类型与 scope', () => {
    expect(inferCommitMessage([change('docs/LESSONS.md')])).toBe('docs: 手动提交 docs/LESSONS.md')
    expect(inferCommitMessage([change('scripts/build.sh')])).toBe('chore(scripts): 手动提交 scripts/build.sh')
    expect(inferCommitMessage([change('.github/workflows/pr-gate.yml')])).toBe('ci: 手动提交 .github/workflows/pr-gate.yml')
  })

  it('未知顶层目录按 fix + 目录名 scope', () => {
    expect(inferCommitMessage([change('native/src/a.c')])).toBe('fix(native): 手动提交 native/src/a.c')
  })

  it('多文件时只报数量', () => {
    const msg = inferCommitMessage([change('docs/a.md'), change('docs/b.md')])
    expect(msg).toBe('docs: 手动提交 2 个文件')
  })

  it('空选择给明确文案，不产出畸形信息', () => {
    expect(inferCommitMessage([])).toBe('chore: 未选择文件')
  })
})

describe('注入预览必须与 host 真实注入同构', () => {
  it('无操作 ⇒ 空串（「看过不注入」）', () => {
    expect(buildInjectPreview([])).toBe('')
  })

  it('多条操作逐行列出，顺序即发生顺序', () => {
    const ops = [describeBranchSwitch('main', 'feat/x'), describeCommit('abc1234', 'feat(git-core): x', 2, 10, 3)]
    expect(buildInjectPreview(ops)).toBe([
      INJECT_HEADER,
      '  · 切换：main → feat/x（成功）',
      '  · 提交：abc1234 feat(git-core): x（2 个文件 +10 −3）',
      '；请勿重复这些操作',
    ].join('\n'))
  })

  it('开头与本仓 host 注入文案逐字一致', () => {
    expect(INJECT_HEADER).toBe('[git] 用户在对话外操作了 git，请据此更新认知：')
  })

  it('切换描述在没有原分支信息时不编造 from', () => {
    expect(describeBranchSwitch('', 'main')).toBe('切换：→ main（成功）')
  })
})

describe('sumSelected', () => {
  it('只统计选中路径', () => {
    const changes = [change('a.ts', 5, 1), change('b.ts', 2, 7), change('c.ts', 100, 100)]
    expect(sumSelected(changes, new Set(['a.ts', 'b.ts']))).toEqual({ added: 7, deleted: 8 })
  })

  it('空选择为 0（不是 NaN）', () => {
    expect(sumSelected([change('a.ts', 1, 1)], new Set())).toEqual({ added: 0, deleted: 0 })
  })
})

describe('panelMode / canWrite（工作中必须全禁）', () => {
  it('加载中优先', () => {
    expect(panelMode(true, false, false)).toBe('loading')
    expect(panelMode(true, true, true)).toBe('loading')
  })

  it('非 git 仓库 ⇒ setup，即使 Agent 空闲也不可写', () => {
    expect(panelMode(false, false, false)).toBe('setup')
    expect(canWrite('setup')).toBe(false)
  })

  it('有仓库且 Agent 空闲 ⇒ idle 可写', () => {
    expect(panelMode(false, true, false)).toBe('idle')
    expect(canWrite('idle')).toBe(true)
  })

  it('Agent 工作中 ⇒ busy，一律不可写', () => {
    expect(panelMode(false, true, true)).toBe('busy')
    expect(canWrite('busy')).toBe(false)
  })
})

describe('statusBadge（porcelain 码 → 面板标记）', () => {
  it('未跟踪显示 U 而不是原始的 ??（用户报障过）', () => {
    const badge = statusBadge('??')
    expect(badge.text).toBe('U')
    expect(badge.tone).toBe('untracked')
    expect(badge.title).toContain('未跟踪')
  })

  it('标记恒为单字符（固定宽度标记位装不下两个）', () => {
    for (const code of ['M ', ' M', 'MM', 'A ', 'D ', 'R ', 'C ', '??', 'UU', 'AA', 'DD', 'AM', 'MD']) {
      expect(statusBadge(code).text.length, code).toBe(1)
    }
  })

  it('语义映射：新增/删除/重命名/冲突', () => {
    expect(statusBadge('A ').text).toBe('A')
    expect(statusBadge('D ').tone).toBe('deleted')
    expect(statusBadge('R ').text).toBe('R')
    expect(statusBadge('UU').tone).toBe('conflict')
    expect(statusBadge('AA').tone).toBe('conflict')
  })

  it('暂存+工作区混合码归到主语义（不出现两个字符）', () => {
    expect(statusBadge('MM').text).toBe('M')
    expect(statusBadge('AM').text).toBe('A')
    expect(statusBadge('MD').tone).toBe('deleted')
  })

  it('每个 tone 都有非空标题（tooltip/无障碍用）', () => {
    for (const code of ['??', 'A ', 'M ', 'D ', 'UU', 'R ']) {
      expect(statusBadge(code).title.trim()).not.toBe('')
    }
  })
})
