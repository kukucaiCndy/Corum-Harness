/**
 * scanTextRefs 守卫 —— 草稿里 `/name` `@name` `@dir/` 三类引用的识别边界。
 *
 * 为什么这是判据而不是细节：这个函数的输出直接决定**哪些字符会被染色成引用**，
 * 而它的输入是用户随手打的自由文本。规则一旦放宽，`/plan.md`、`x/name`、
 * `/plan。` 这类普通散文就会被误标；一旦收紧，真正的 `/nfs-hg` 命令又点不亮。
 *
 * 三个边界是本模块的核心契约，且都是「差一个字符」级别的：
 *
 * 1. **触发字符必须在草稿开头或空白之后** —— `x/name` 永不匹配（不是引用）；
 * 2. **名字必须精确命中词表** —— 词表里没有 `plan` 时 `/plan` 不是引用；
 * 3. **`/name` 之后必须是空白或草稿结束** —— `/nfs-hg/xxx` 是路径、`/plan。` 是散文。
 *
 * 第 3 条只对 `/` 成立（`@` 允许 `@dir/sub/` 这种文件夹形态），这是刻意的不对称。
 */
import { describe, expect, it } from 'vitest'
import { scanTextRefs } from '../src/client/input/decorations.ts'

/** 只有斜杠命令词表的词表。 */
function slashLexicon(...names: string[]): ReadonlyMap<'/' | '@', readonly string[]> {
  return new Map([['/', names]])
}

/** 只有 at 词表的词表。 */
function atLexicon(...names: string[]): ReadonlyMap<'/' | '@', readonly string[]> {
  return new Map([['@', names]])
}

describe('scanTextRefs · 基本识别', () => {
  it('空草稿 ⇒ 空结果（不进入扫描）', () => {
    expect(scanTextRefs('', slashLexicon('plan'))).toEqual([])
  })

  it('空词表 ⇒ 斜杠/at 引用都不识别，但文件夹形态仍识别', () => {
    // 契约事实：文件夹扫描不依赖词表（语法可识别），这是刻意的。
    expect(scanTextRefs('/plan @x', new Map())).toEqual([])
    expect(scanTextRefs('@dir/', new Map())).toEqual([{ start: 0, end: 5, trigger: '@' }])
  })

  it('命中词表的 /name 被识别，start/end 覆盖 token（含触发字符）', () => {
    expect(scanTextRefs('/plan', slashLexicon('plan'))).toEqual([
      { start: 0, end: 5, trigger: '/' },
    ])
  })

  it('命中词表的 @name 被识别', () => {
    expect(scanTextRefs('@file', atLexicon('file'))).toEqual([
      { start: 0, end: 5, trigger: '@' },
    ])
  })

  it('未命中词表 ⇒ 不识别', () => {
    expect(scanTextRefs('/nope', slashLexicon('plan'))).toEqual([])
  })

  it('名字可含连字符与下划线', () => {
    expect(scanTextRefs('/nfs-hg_x', slashLexicon('nfs-hg_x'))).toEqual([
      { start: 0, end: 9, trigger: '/' },
    ])
  })
})

describe('scanTextRefs · 边界 1：触发字符必须在开头或空白后', () => {
  it('紧贴前文 ⇒ 不匹配（x/name 是普通文本）', () => {
    expect(scanTextRefs('x/plan', slashLexicon('plan'))).toEqual([])
  })

  it('紧贴前文（at 形态）⇒ 不匹配（邮箱不是引用）', () => {
    expect(scanTextRefs('me@file', atLexicon('file'))).toEqual([])
  })

  it('空白之后 ⇒ 匹配，start 落在触发字符上（不含前导空白）', () => {
    expect(scanTextRefs('see /plan', slashLexicon('plan'))).toEqual([
      { start: 4, end: 9, trigger: '/' },
    ])
  })

  it('换行之后 ⇒ 匹配（\\s 含换行）', () => {
    expect(scanTextRefs('a\n/plan', slashLexicon('plan'))).toEqual([
      { start: 2, end: 7, trigger: '/' },
    ])
  })
})

describe('scanTextRefs · 边界 2：名字精确命中', () => {
  it('前缀匹配不算（plan 命中不代表 pl 命中）', () => {
    expect(scanTextRefs('/pl', slashLexicon('plan'))).toEqual([])
  })

  it('超集不算（planner 不在词表里）', () => {
    expect(scanTextRefs('/planner', slashLexicon('plan'))).toEqual([])
  })

  it('同一词表里多个名字各自识别', () => {
    expect(scanTextRefs('/plan /nfs-hg', slashLexicon('plan', 'nfs-hg'))).toEqual([
      { start: 0, end: 5, trigger: '/' },
      { start: 6, end: 13, trigger: '/' },
    ])
  })
})

describe('scanTextRefs · 边界 3：斜杠 token 必须在空白或草稿结束处收尾', () => {
  it('/name/x 是路径，不是引用', () => {
    expect(scanTextRefs('/plan/x', slashLexicon('plan'))).toEqual([])
  })

  it('/plan.md 是文件名，不是引用', () => {
    expect(scanTextRefs('/plan.md', slashLexicon('plan'))).toEqual([])
  })

  it('/plan。 后面是中文标点 ⇒ 是散文，不是引用', () => {
    expect(scanTextRefs('/plan。', slashLexicon('plan'))).toEqual([])
  })

  it('/plan 后接空白 ⇒ 是引用', () => {
    expect(scanTextRefs('/plan 继续', slashLexicon('plan'))).toEqual([
      { start: 0, end: 5, trigger: '/' },
    ])
  })

  it('该条**只对 /** 成立：@name/x 不受此约束（at 引用可接路径）', () => {
    // @ 引用命中词表时没有「必须空白收尾」的限制。
    expect(scanTextRefs('@file/x', atLexicon('file'))).toEqual([
      { start: 0, end: 5, trigger: '@' },
    ])
  })
})

describe('scanTextRefs · 文件夹形态', () => {
  it('@dir/ 被识别为 at 引用', () => {
    expect(scanTextRefs('@src/', new Map())).toEqual([{ start: 0, end: 5, trigger: '@' }])
  })

  it('带引号的文件夹形态被识别（区间含起始引号，止于结尾斜杠）', () => {
    // 契约事实：引号分支 `"[^"\n]*\/` 吃掉起始引号与结尾斜杠，**不含**收尾引号。
    expect(scanTextRefs('@"my dir/"', new Map())).toEqual([
      { start: 0, end: 9, trigger: '@' },
    ])
  })

  it('多级路径 @src/a/ 整段算一个引用', () => {
    expect(scanTextRefs('@src/a/', new Map())).toEqual([{ start: 0, end: 7, trigger: '@' }])
  })

  it('文件夹形态也要求触发字符在开头或空白后', () => {
    expect(scanTextRefs('x@src/', new Map())).toEqual([])
  })

  it('已被词表命中的 @name 区间遮住文件夹形态 ⇒ 不重复输出', () => {
    // `@file/` 同时符合词表 @file 与文件夹语法；去重后只留词表那条。
    expect(scanTextRefs('@file/', atLexicon('file'))).toEqual([
      { start: 0, end: 5, trigger: '@' },
    ])
  })
})

describe('scanTextRefs · 排序与多次扫描', () => {
  it('输出按 start 升序', () => {
    const result = scanTextRefs('@src/ /plan', new Map([['/', ['plan']]]))
    expect(result.map(r => r.start)).toEqual([0, 6])
    expect(result[0]!.trigger).toBe('@')
    expect(result[1]!.trigger).toBe('/')
  })

  it('重复调用结果一致（模块级正则的 lastIndex 被复位）', () => {
    const lexicon = slashLexicon('plan')
    const once = scanTextRefs('/plan 和 /plan', lexicon)
    const twice = scanTextRefs('/plan 和 /plan', lexicon)
    expect(twice).toEqual(once)
    expect(once).toHaveLength(2)
  })

  it('同一草稿里斜杠与 at 并存，各自只认自己的词表', () => {
    const lexicon: ReadonlyMap<'/' | '@', readonly string[]> = new Map([
      ['/', ['plan']],
      ['@', ['file']],
    ])
    expect(scanTextRefs('/plan @file', lexicon)).toEqual([
      { start: 0, end: 5, trigger: '/' },
      { start: 6, end: 11, trigger: '@' },
    ])
  })
})
