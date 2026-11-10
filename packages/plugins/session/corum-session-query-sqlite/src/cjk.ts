/**
 * CJK substring reachability for the unicode61 FTS5 read model.
 *
 * B3（CTS 历史严重 bug）：中文正文词搜不到。`unicode61` 把一段**连续的字母/数字**
 * 切成一个 token —— CJK 汉字是 `L*`，所以「这是一次检索自检。」整句是一个 token，
 * 用户搜其中的「检索自检」永远命中不了；CJK 紧贴 ASCII（`蓝鲸月饼代号CTSB3K1`）
 * 更糟：连「蓝鲸月饼代号」都搜不到，`CTSB3K1` 单独也搜不到（同一 token）。
 *
 * 修复口径（最小且兼容，不动 tokenizer 语义）：
 *   · 索引侧：在每个 CJK 字符与相邻字符之间插入**一个分隔哨兵**，让 unicode61
 *     「一个 CJK 字符 = 一个 token」；ASCII 词/数字仍是整词 token（上游语义不变，
 *     ASCII 仍然不做词中缀匹配）。
 *   · 查询侧：对查询串做同一变换后整体作为一个 phrase（`"…"`），于是
 *     「连字的若干 CJK 字符」= phrase 内连续的单字 token ⇒ 子串匹配，1/2/3+ 字都成立。
 *   · 呈现侧：把哨兵从 snippet 里去掉，用户看到的是原文（无空格、无控制字符）。
 *
 * 哨兵必须满足：① 对 unicode61 是分隔符（非 `L*`/`N*`/`Co`）；② 不是空白
 * （`normalizeMarkedText` 会把连续空白压成一个空格，用空白会把中文句子破坏成
 * 「检 索 自 检」）；③ 不与 FTS5 highlight 标记（U+FDD0/U+FDD1）和 NUL 冲突。
 * U+001F（INFORMATION SEPARATOR ONE，Cc 类）三条都满足（tests/cjk.spec.ts 里
 * 有对 SQLite 的实证，见 docs/evidence/rc3-b3-search-verification-2026-11-07.md）。
 */

/** 分隔哨兵：对 FTS5 unicode61 是分隔符，对 snippet 呈现是透明字符。 */
export const CJK_FIELD_SEPARATOR = '\u001F'

/**
 * 是否属于需要在检索粒度上拆到「单字」的 CJK 类文字。
 * @param codePoint - 码点（`codePointAt` 的返回值）。
 * @returns 该码点是否按单字建 token。
 */
export function isCjkCodePoint(codePoint: number): boolean {
  return (
    // CJK 部首 / 笔画 / 符号（字读上属于表意体系，按字切分便于逐字命中）
    (codePoint >= 0x2e80 && codePoint <= 0x2eff) ||
    (codePoint >= 0x2f00 && codePoint <= 0x2fdf) ||
    // 々 〆 〇 等
    codePoint === 0x3005 ||
    codePoint === 0x3006 ||
    codePoint === 0x3007 ||
    (codePoint >= 0x3021 && codePoint <= 0x3029) ||
    // 平假名 / 片假名 / 注音 / 韩文兼容
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3100 && codePoint <= 0x312f) ||
    (codePoint >= 0x31a0 && codePoint <= 0x31bf) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0x3130 && codePoint <= 0x318f) ||
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    // 汉字（基本区 / 扩展 A / 兼容 / 扩展 B 及以上）
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xff66 && codePoint <= 0xff9f) ||
    (codePoint >= 0xffa0 && codePoint <= 0xffdc) ||
    (codePoint >= 0x20000 && codePoint <= 0x3ffff)
  )
}

/**
 * 在「CJK ↔ 任意字符」边界插入哨兵，使每个 CJK 字符成为独立 token。
 * @param text - 已 sanitize 的文档文本或查询文本。
 * @returns 供 FTS5 建索引 / 匹配用的变换文本。
 */
export function toFtsSegmentedText(text: string): string {
  if (text.length === 0) return text
  const characters = Array.from(text)
  const parts: string[] = []
  let previousCjk = false
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index] as string
    const cjk = isCjkCodePoint(character.codePointAt(0) as number)
    if (index > 0 && (cjk || previousCjk)) parts.push(CJK_FIELD_SEPARATOR)
    parts.push(character)
    previousCjk = cjk
  }
  return parts.join('')
}

/**
 * 把哨兵从呈现文本里去掉（snippet 用）。
 * @param text - 含哨兵的文本。
 * @returns 不含哨兵的原文呈现。
 */
export function stripFtsSeparators(text: string): string {
  return text.includes(CJK_FIELD_SEPARATOR) ? text.replaceAll(CJK_FIELD_SEPARATOR, '') : text
}
