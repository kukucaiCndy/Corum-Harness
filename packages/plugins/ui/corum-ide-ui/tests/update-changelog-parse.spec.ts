/**
 * 更新日志解析（2026-10-23 用户要求「能在更新的界面查看历史的更新日志」）。
 *
 * 日志正文随安装包分发（`Resources/assets/CHANGELOG.md`），面板拿它做两件事：
 * ① 状态①「有更新」时显示**当前版本**摘要（取 `- ` 条目，最多 3 条）；
 * ② 「历史版本」入口把整份文件交给编辑器打开。
 *
 * 本 spec 钉死解析契约：只认 `## <版本> — <日期>` 这一级标题；`# ` 文档标题
 * 不算版本节；`###` 分组留作正文；格式漂移不得让功能失效（认不出的行原样保留）。
 */
import { describe, expect, it } from 'vitest'
import { parseChangelog } from '../src/client/update/update-api.ts'

const SAMPLE = `# Corum Harness 更新日志

> 说明段，不属于任何版本。

## v0.6.0 — 2026-10-18

### 新增

- 供应商清单改由 pi-ai 目录驱动
- 启动动画分段视频成为内置默认

### 修复

- 检查更新弹窗加宽

## v0.5.0 — 2026-10-16

- 启动主题系统

## v0.4.0

- 无日期的节（格式漂移容忍）
`

describe('parseChangelog', () => {
  it('按 `## ` 切分版本节，忽略文档标题与前言', () => {
    const sections = parseChangelog(SAMPLE)
    expect(sections.map(s => s.version)).toEqual(['v0.6.0', 'v0.5.0', 'v0.4.0'])
  })

  it('提取日期；缺日期时为空串（不编造）', () => {
    const sections = parseChangelog(SAMPLE)
    expect(sections[0]?.date).toBe('2026-10-18')
    expect(sections[1]?.date).toBe('2026-10-16')
    expect(sections[2]?.date).toBe('')
  })

  it('正文保留 `###` 分组与条目原样', () => {
    const sections = parseChangelog(SAMPLE)
    const body = sections[0]?.body ?? ''
    expect(body).toContain('### 新增')
    expect(body).toContain('### 修复')
    expect(body).toContain('- 供应商清单改由 pi-ai 目录驱动')
  })

  it('节间不串味：v0.5.0 的正文不含 v0.6.0 的条目', () => {
    const sections = parseChangelog(SAMPLE)
    expect(sections[1]?.body).not.toContain('供应商清单')
    expect(sections[1]?.body).toContain('启动主题系统')
  })

  it('无版本节时返回空列表（不抛错）', () => {
    expect(parseChangelog('# 只有标题\n\n普通段落。')).toEqual([])
  })

  it('兼容 CRLF 换行', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n')
    const sections = parseChangelog(crlf)
    expect(sections.map(s => s.version)).toEqual(['v0.6.0', 'v0.5.0', 'v0.4.0'])
    expect(sections[0]?.body).toContain('### 新增')
  })

  it('容忍 em dash / en dash / 连字符三种分隔写法', () => {
    const variants = [
      '## v1.0.0 — 2026-01-01\n- a',
      '## v1.0.0 – 2026-01-01\n- a',
      '## v1.0.0 - 2026-01-01\n- a',
    ]
    for (const text of variants) {
      const sections = parseChangelog(text)
      expect(sections).toHaveLength(1)
      expect(sections[0]?.version).toBe('v1.0.0')
      expect(sections[0]?.date).toBe('2026-01-01')
    }
  })
})
