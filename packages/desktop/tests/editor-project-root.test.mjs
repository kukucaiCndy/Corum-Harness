/**
 * 编辑器/资源管理器的项目根跟随判据（回归网）。
 *
 * 用户报障（2026-11）：「右侧编辑器和资源管理器无法跟随工作区的选中来更换，而是默认
 * 为最新创建的工作区目录」——在 kkc-desktop 对话，右侧却显示 pendiji 那个工作区。
 *
 * 根因：判据读 `sessions.list.getSnapshot().current`，而 rc3 的 `SessionListState`
 * **没有 `current` 字段** ⇒ 恒 undefined ⇒ 每次回落 `workspaces.items[0]`，该数组
 * 按 `createdAt` 倒序 ⇒ 永远停在最新创建的工作区。
 *
 * 本测试钉住「当前会话决定根、items 顺序不影响结果」这条不变式，并给出负向对照：
 * 若把关选项改回「取第一项」，第一条用例立刻变红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const impl = await import('../lib/types/shared/project-root.js').catch(() => ({}))

/** 工作区注册表：**最新创建的排最前**（dsh-workspace 的 createdAt 倒序语义）。 */
const workspacesNewestFirst = [
  { path: '/work/newest-pendiji', sessionIds: ['s-pendiji'] },
  { path: '/work/kkc-desktop', sessionIds: ['s-kkc'] },
  { path: '/work/oldest-corum', sessionIds: ['s-corum'] },
]

test('当前会话所属工作区优先——与「最新创建」顺序无关', () => {
  assert.equal(typeof impl.resolveProjectRoot, 'function')
  const root = impl.resolveProjectRoot({
    sessionId: 's-kkc',
    sessionsById: { 's-kkc': { cwd: '/work/kkc-desktop' } },
    workspaces: workspacesNewestFirst,
  })
  assert.equal(root, '/work/kkc-desktop')
  // 负向对照的期望形态：绝不等于「最新创建的那个」。
  assert.notEqual(root, '/work/newest-pendiji')
})

test('会话行不带 cwd 时按 sessionIds 反查归属工作区，不取第一项', () => {
  assert.equal(typeof impl.resolveProjectRoot, 'function')
  const root = impl.resolveProjectRoot({
    sessionId: 's-corum',
    sessionsById: { 's-corum': {} },
    workspaces: workspacesNewestFirst,
  })
  assert.equal(root, '/work/oldest-corum')
})

test('没有当前会话 → 空态（null），不回落任何工作区', () => {
  assert.equal(typeof impl.resolveProjectRoot, 'function')
  assert.equal(impl.resolveProjectRoot({
    sessionId: undefined,
    sessionsById: { 's-kkc': { cwd: '/work/kkc-desktop' } },
    workspaces: workspacesNewestFirst,
  }), null)
  assert.equal(impl.resolveProjectRoot({
    sessionId: '',
    sessionsById: {},
    workspaces: workspacesNewestFirst,
  }), null)
})

test('会话既无 cwd 也不在任何工作区 → 空态，不乱猜', () => {
  assert.equal(typeof impl.resolveProjectRoot, 'function')
  assert.equal(impl.resolveProjectRoot({
    sessionId: 's-orphan',
    sessionsById: { 's-orphan': {} },
    workspaces: workspacesNewestFirst,
  }), null)
})

test('空 cwd 空路径都不当作有效根', () => {
  assert.equal(typeof impl.resolveProjectRoot, 'function')
  assert.equal(impl.resolveProjectRoot({
    sessionId: 's-empty',
    sessionsById: { 's-empty': { cwd: '' } },
    workspaces: [{ path: '', sessionIds: ['s-empty'] }],
  }), null)
})
