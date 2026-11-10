/**
 * B3 回归：unicode61 + CJK 逐字分词后，中文正文词的子串必须可命中。
 *
 * 这些用例直接打在真实 SQLite / FTS5（`node:sqlite`，与宿主运行时同一个引擎）上，
 * 不是纯字符串断言 —— B3 的病根是「引擎分词粒度」而不是我们自己的正则。
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { CJK_FIELD_SEPARATOR, isCjkCodePoint, toFtsSegmentedText } from '../src/cjk.ts'
import { FTS_HIGHLIGHT_END, FTS_HIGHLIGHT_START, makeSnippet, quoteFtsData, sanitizeFtsText } from '../src/query.ts'

/** 建一个与后端同形（unicode61）的内存 FTS5 表并写入一条文档。 */
function indexDocument(text: string): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(text, tokenize = 'unicode61')")
  db.prepare('INSERT INTO docs (text) VALUES (?)').run(toFtsSegmentedText(sanitizeFtsText(text)))
  return db
}

/** 用后端真实的 quoteFtsData 构造 MATCH 表达式并取命中数。 */
function hits(db: DatabaseSync, query: string): number {
  const row = db.prepare('SELECT count(*) AS c FROM docs WHERE docs MATCH ?').get(quoteFtsData(query)) as {
    c: number
  }
  return row.c
}

/** 取带 highlight 标记的命中文本（与后端 snippet 走同一条呈现路径）。 */
function marked(db: DatabaseSync, query: string): string | undefined {
  const row = db
    .prepare('SELECT highlight(docs, 0, ?, ?) AS t FROM docs WHERE docs MATCH ?')
    .get(FTS_HIGHLIGHT_START, FTS_HIGHLIGHT_END, quoteFtsData(query)) as { t: string } | undefined
  return row?.t
}

describe('CJK 分词哨兵', () => {
  it('按 CJK 字符切开，ASCII 词保持整词', () => {
    expect(toFtsSegmentedText('检索自检')).toBe(
      ['检', '索', '自', '检'].join(CJK_FIELD_SEPARATOR),
    )
    expect(toFtsSegmentedText('AlphaB3-9182')).toBe('AlphaB3-9182')
  })

  it('CJK 与 ASCII 的交界也切，CJK 连着 ASCII 不再粘成一个 token', () => {
    expect(toFtsSegmentedText('代号CTSB3K1')).toBe(`代${CJK_FIELD_SEPARATOR}号${CJK_FIELD_SEPARATOR}CTSB3K1`)
  })

  it('覆盖汉字/假名/谚文，不误伤 ASCII 与全角标点以外的常规文本', () => {
    for (const character of ['蓝', '鲸', 'あ', 'ア', '한']) {
      expect(isCjkCodePoint(character.codePointAt(0) as number)).toBe(true)
    }
    for (const character of ['A', '9', ',', ' ']) {
      expect(isCjkCodePoint(character.codePointAt(0) as number)).toBe(false)
    }
  })
})

describe('B3：正文中文子串（unicode61 实证）', () => {
  const body = '这是一次检索自检。请原样包含 蓝鲸月饼代号CTSB3K1 以及 AlphaB3-9182。'

  it('1/2/3/4 字中文子串全部命中', () => {
    const db = indexDocument(body)
    for (const query of ['检', '检索', '检索自', '检索自检', '蓝鲸月饼', '鲸月饼']) {
      expect(hits(db, query), `query=${query}`).toBe(1)
    }
  })

  it('CJK 紧贴 ASCII 时，中文前缀与 ASCII 串各自都能命中', () => {
    const db = indexDocument(body)
    expect(hits(db, '蓝鲸月饼代号')).toBe(1)
    expect(hits(db, 'CTSB3K1')).toBe(1)
    expect(hits(db, '代号')).toBe(1)
  })

  it('ASCII 仍是整词 token：词全匹配命中、词中缀不命中（不引入 trigram 语义）', () => {
    const db = indexDocument(body)
    expect(hits(db, 'AlphaB3')).toBe(1)
    expect(hits(db, '9182')).toBe(1)
    expect(hits(db, 'lphaB3')).toBe(0)
  })

  it('无匹配的查询仍为空（不产生假阳性）', () => {
    const db = indexDocument(body)
    expect(hits(db, '月饼蓝鲸')).toBe(0)
    expect(hits(db, 'B3NOTEXIST')).toBe(0)
  })

  it('snippet 里哨兵被去掉，用户看到的是原文（无空格/控制字符）', () => {
    const db = indexDocument(body)
    const text = marked(db, '检索自检')
    expect(text).toBeDefined()
    const snippet = makeSnippet(text as string, 240)
    expect(snippet).toContain('这是一次检索自检。')
    expect(snippet.includes(CJK_FIELD_SEPARATOR)).toBe(false)
  })
})
