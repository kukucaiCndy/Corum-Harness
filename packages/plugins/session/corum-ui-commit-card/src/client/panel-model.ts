/**
 * Git 面板的纯逻辑（不碰 React、不碰 RPC）。
 *
 * 抽出来的原因：面板里真正会**出错而用户看不出来**的判断只有两类 ——
 *   ① 提交信息按路径规则拼（规则拼错 ⇒ 用户得到一个语义错误的提交）；
 *   ② 「哪些文件会进这次提交」与「注入给 Agent 的那句话」是否与实际操作一致
 *      （注入文案与真实 git 操作不一致 ⇒ Agent 的认知被误导，且这个错误**只**表现在
 *      Agent 后续行为里，界面上看不出来）。
 *
 * 两个函数都是纯函数，故可以脱离 jsdom / RPC 直接单测。
 */
import type { ChangeEntry } from './contract.ts'

/** 注入给 Agent 的那句话的开头（与 host 侧 `buildInjectMessage` 必须一致）。 */
export const INJECT_HEADER = '[git] 用户在对话外操作了 git，请据此更新认知：'

/**
 * 包名的目录层数（`packages/` 之后再查几层才是包名）。
 *
 * 已知两种布局：`packages/plugins/<group>/<name>`（group ∈ agent/session/ui）
 * 与 `packages/<group>/<name>`（sdk/tooling）；其余是 `packages/<name>`
 * （desktop 就是一个直接挂在 `packages/` 下的包，不能再当分组跳过）。
 */
const PACKAGE_DEPTH: Readonly<Record<string, number>> = { plugins: 3, sdk: 2, tooling: 2 }

/**
 * 从改动文件路径推断 conventional commit type + scope（规则拼，不调 LLM）。
 *
 * scope 取「包名 / 顶层目录」而不是文件名：`packages/plugins/...` 下面一层是分组
 * （agent/session/ui），再下一层才是真正的包名，更下一层是文件名。
 * @param files - 选中的改动文件（非空）。
 * @returns 形如 `feat(git-core): 手动提交 src/index.ts`。
 */
export function inferCommitMessage(files: ChangeEntry[]): string {
  if (files.length === 0) return 'chore: 未选择文件'
  const first = files[0]
  const firstPath = first === undefined ? '' : first.path
  const parts = firstPath.split('/')
  const topDir = parts[0] ?? ''
  let type = 'fix'
  let scope: string = topDir
  if (topDir === 'docs') {
    type = 'docs'
    scope = ''
  } else if (topDir === 'packages') {
    // packages/ 下有两种布局：`packages/<name>/…`（desktop / sdk 直挂）与
    // `packages/plugins/<group>/<name>/…`（agent / session / ui 三组）。
    // 分组层不是包名，必须逐层跳过，否则 scope 会是 `session` / `agent` 这种分组名。
    const depth = PACKAGE_DEPTH[parts[1] ?? ''] ?? 1
    scope = parts[depth] ?? (parts[1] ?? topDir)
    if (parts.includes('tests') || parts.includes('test')) type = 'test'
    else type = 'feat'
  } else if (topDir === 'scripts') {
    type = 'chore'
    scope = 'scripts'
  } else if (topDir === '.github') {
    type = 'ci'
    scope = ''
  }
  const scopePart = scope !== '' ? `(${scope})` : ''
  const fileDesc = files.length === 1 ? firstPath : `${files.length} 个文件`
  return `${type}${scopePart}: 手动提交 ${fileDesc}`
}

/**
 * 拼「下轮注入给 Agent 的内容」预览。
 *
 * 必须与 host 侧真实注入同构：host 把每条操作作为 `· <operation>` 一行列出，
 * 故这里的预览就是用户即将看到并（在下一轮）真正被注入的文本。
 * @param operations - 已记录的操作描述（顺序 = 实际发生顺序）。
 * @returns 预览文本；无操作时为空串（无操作不注入）。
 */
export function buildInjectPreview(operations: readonly string[]): string {
  if (operations.length === 0) return ''
  return [INJECT_HEADER, ...operations.map(op => `  · ${op}`), '；请勿重复这些操作'].join('\n')
}

/**
 * 提交成功后的操作描述（写入 host 待注入列表 + 用于预览）。
 * @param hash - 短提交 hash。
 * @param message - 提交信息。
 * @param fileCount - 文件数。
 * @param added - 新增行数合计。
 * @param deleted - 删除行数合计。
 */
export function describeCommit(
  hash: string,
  message: string,
  fileCount: number,
  added: number,
  deleted: number,
): string {
  return `提交：${hash} ${message}（${fileCount} 个文件 +${added} −${deleted}）`
}

/**
 * 切换分支后的操作描述。
 * @param from - 原分支（未知时传空串）。
 * @param to - 目标分支。
 */
export function describeBranchSwitch(from: string, to: string): string {
  return from === '' ? `切换：→ ${to}（成功）` : `切换：${from} → ${to}（成功）`
}

/**
 * 汇总选中文件的增删行数（结果条展示用）。
 * @param changes - 面板全部改动。
 * @param selected - 选中路径集合。
 */
export function sumSelected(
  changes: readonly ChangeEntry[],
  selected: ReadonlySet<string>,
): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const change of changes) {
    if (!selected.has(change.path)) continue
    added += change.added
    deleted += change.deleted
  }
  return { added, deleted }
}

/**
 * 面板三态（照设计稿 J17）。
 * `busy` 优先于 `setup`：Agent 在跑时，是否 git 仓库都不改变「全置灰」这个结论。
 */
export type PanelMode = 'loading' | 'setup' | 'idle' | 'busy'

/**
 * 由「是否在拉数据 / 是否 git 仓库 / Agent 是否在跑」判定面板模式。
 * @param loading - 是否正在拉数据。
 * @param hasRepo - 是否取到了仓库数据（非仓库时为 false）。
 * @param running - 会话 agent 是否 running。
 */
export function panelMode(loading: boolean, hasRepo: boolean, running: boolean): PanelMode {
  if (loading) return 'loading'
  if (!hasRepo) return 'setup'
  return running ? 'busy' : 'idle'
}

/**
 * 面板是否允许写操作（切分支 / 勾选 / 提交）。
 * @param mode - `panelMode` 的结果。
 */
export function canWrite(mode: PanelMode): boolean {
  return mode === 'idle'
}

/** 状态标记的展示语义（git porcelain 码 → 面板上给用户看的短标记）。 */
export interface StatusBadge {
  /** 展示文本（1 个字符或一个明确符号）。 */
  text: string
  /** 语义通道（决定配色）：新增 / 修改 / 删除 / 未跟踪 / 冲突。 */
  tone: 'added' | 'modified' | 'deleted' | 'untracked' | 'conflict'
  /** 无障碍标题（屏幕阅读器与 tooltip 用）。 */
  title: string
}

/**
 * 把 git 的 porcelain 状态码翻成面板展示用的标记。
 *
 * 为什么不直接显示原始码：`git status --porcelain` 的两字符码是**面向机器**的，
 * 未跟踪是 `??`、重命名是 `R`、暂存+工作区混合是 `MM`。直接把两字符塞进固定宽度
 * 的标记位会溢出到路径上，而且 `??` 这种符号对用户没有语义（用户原话：
 * 「每个未提交的项目前面都有两个问号，这个应该是显示问题」）。
 *
 * 判据顺序有讲究：先看未跟踪（`??`），再看冲突（`UU`/`AA`/`DD`），
 * 最后按「是否含 D」→「是否含 A」→ 其余归修改。
 * @param status - porcelain 状态码（已 trim 或未 trim 均可）。
 */
export function statusBadge(status: string): StatusBadge {
  const code = status.replace(/\s/g, '')
  if (code === '??' || code === '?') return { text: 'U', tone: 'untracked', title: '未跟踪的新文件' }
  if (code === 'UU' || code === 'AA' || code === 'DD' || code.includes('U')) {
    return { text: '!', tone: 'conflict', title: '合并冲突' }
  }
  if (code.includes('R')) return { text: 'R', tone: 'modified', title: '重命名' }
  if (code.includes('D')) return { text: 'D', tone: 'deleted', title: '已删除' }
  if (code.includes('A')) return { text: 'A', tone: 'added', title: '新增' }
  if (code.includes('C')) return { text: 'C', tone: 'added', title: '复制' }
  return { text: 'M', tone: 'modified', title: '已修改' }
}
