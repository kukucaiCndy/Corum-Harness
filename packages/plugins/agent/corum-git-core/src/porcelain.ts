/**
 * `git status --porcelain=v1 -z` 的解析内核（`listChanges` RPC 的纯函数部分）。
 *
 * ## 为什么单独成文件
 *
 * 面板的「未提交更改」列表直接决定用户点「提交」后会 `git add` 哪些路径。解析错一条
 * 记录，就会生成一个**不存在的路径**；而面板默认全选 ⇒ `git add -- <幽灵路径>` 失败 ⇒
 * 整次提交失败（用户看到的是「提交失败」，不会有任何提示说是解析的错）。
 *
 * ## `-z` 的重命名/复制记录是两条 NUL 字段
 *
 * 非 `-z` 格式里重命名写成 `R  old -> new`（单行）；`-z` 格式**去掉箭头**，改成两条
 * NUL 分隔字段，且**目标路径在前、源路径在后**：
 *
 * ```
 * R  b.txt\0a.txt\0      ← git mv a.txt b.txt 之后
 * ```
 *
 * 因此那种「按行循环、每行当一条记录」的写法会把源路径当成一条独立记录，而
 * `record.slice(0,2)` 取到 `a.`、`slice(3)` 取到 `xt` —— 这就是幽灵行的来源。
 * 正确写法必须为 REMAME/COPY 记录**多消费一条字段**（同 `git-primitives.ts`
 * 的 `captureEffectiveChanges`）。
 *
 * 本文件不碰文件系统，便于用真实临时仓库的输出直接单测。
 */

/** 一条解析后的记录。 */
export interface PorcelainEntry {
  /** 目标路径（重命名/复制时为新路径）。 */
  path: string
  /** 两字符状态码去空格（`M` / `A` / `D` / `R` / `C` / `??` 等）。 */
  status: string
  /** 重命名/复制的源路径；非 R/C 记录为 `null`。 */
  renameSource: string | null
}

/**
 * 把 `git status --porcelain=v1 -z` 的输出拆成记录。
 *
 * `-z` 的记录以 NUL 分隔（不是换行），末尾可能带一个多余 NUL。
 * @param raw - git 的原始 stdout。
 * @returns 非空字段列表。
 */
export function splitPorcelainZ(raw: string): string[] {
  return raw.split('\0').filter(record => record !== '')
}

/**
 * 解析 `-z` 记录列表。
 *
 * 重命名/复制记录（状态码含 `R` 或 `C`）会**多消费一条字段**作为源路径，
 * 从而不会把源路径误当成一条独立记录。
 * @param records - `splitPorcelainZ` 拆出的字段列表（也接受未拆的原始输出）。
 * @returns 每个真实改动一条记录，顺序与 git 输出一致。
 */
export function parsePorcelainZ(records: readonly string[]): PorcelainEntry[] {
  const entries: PorcelainEntry[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    // 最短合法记录是 `XY p`（4 字符）。异常短记录跳过而不是产出空路径。
    if (record === undefined || record.length < 4) continue
    const status = record.slice(0, 2)
    const path = record.slice(3)
    if (/[RC]/.test(status)) {
      const renameSource = records[++i] ?? null
      entries.push({ path, status: status.trim(), renameSource })
    } else {
      entries.push({ path, status: status.trim(), renameSource: null })
    }
  }
  return entries
}

/**
 * 一步到位：原始 stdout → 记录列表。
 * @param raw - `git status --porcelain=v1 -z` 的原始 stdout。
 */
export function parsePorcelainZText(raw: string): PorcelainEntry[] {
  return parsePorcelainZ(splitPorcelainZ(raw))
}

/**
 * 分支名是否可安全交给 `git checkout`。
 *
 * 只放行常规分支名：以字母数字开头（**排除 `-` 开头**，那会被 git 当选项）、
 * 不含空白/控制字符/`..`/`~^:?*[\` 等 git 保留字符。远程跟踪分支
 * （`origin/feat-x`）的斜杠是合法的。
 * @param branch - 待校验的分支名。
 */
export function isSafeBranchName(branch: string): boolean {
  if (branch === '' || branch.length > 255) return false
  if (branch.startsWith('-')) return false
  if (branch.includes('..') || branch.includes('//')) return false
  return /^[0-9A-Za-z_][0-9A-Za-z._/-]*$/.test(branch)
}
