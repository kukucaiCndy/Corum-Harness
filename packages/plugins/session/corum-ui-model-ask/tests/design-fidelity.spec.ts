/**
 * 设计稿保真度守卫（design.pen jO5So「方案C · 通知条+展开面板」）。
 *
 * 为什么用源码断言而不是渲染快照：本插件的偏差**曾经真实发生过**——图标按语义猜
 * （AlertTriangle/Check/ChevronRight/X，设计稿要的是 unplug/zap/link/repeat/ban）、
 * 通知条用了 glass 底色（设计稿是红色告警调 #FF6B6B14）、picker 行被整行藏掉
 * （设计稿里它是恒显示的固定子节点）、字重与圆角多处偏差。这些都不会让构建或 typecheck
 * 报错，只会在界面上「看着不太像」——正是需要钉住的那类静默失真。
 *
 * 断言对象是**设计稿的原始属性值**（见 design.pen 的提取表），不是「当前实现的镜像」：
 * 改实现而不同步设计稿就会红。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(join(import.meta.dirname, '../src/client/ModelAskPanel.module.css'), 'utf8')
const TSX = readFileSync(join(import.meta.dirname, '../src/client/ModelAskPanel.tsx'), 'utf8')

/** 取一条 CSS 规则的声明块（按选择器名匹配，容忍 CSS Module 的哈希前缀由构建期加）。 */
function rule(selector: string): string {
  const at = CSS.indexOf(`.${selector} {`)
  expect(at, `找不到规则 .${selector}`).toBeGreaterThan(-1)
  const end = CSS.indexOf('}', at)
  return CSS.slice(at, end)
}

/**
 * 剥掉注释（含 /* … *​/ 与行内 //）。
 *
 * 为什么需要：注释里正当地记着设计稿原文（`/* #01CDFE14 *​/`）与「曾用错哪个图标」
 * 的说明——那些文本里的 hex 与图标名不是代码，裸子串判会把说明性注释也算成违规。
 * 本仓已有这个学费（见 corum-tool-subagent 测试的 stripComments）。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('design.pen jO5So 保真度 —— ① 通知条 notify-bar', () => {
  it('★ 底色/描边是红色告警调（#FF6B6B14 / #FF6B6B55），不是 glass 中性色', () => {
    // 设计稿 notify-bar 是**错误态**通知条：fill #FF6B6B14 + stroke #FF6B6B55。
    // 用 glass-1/glass-border 会渲染成中性卡片，丢掉「出错了」的视觉语义。
    const bar = rule('bar')
    expect(bar).toContain('rgba(255, 107, 107, 0.08)') // #FF6B6B14
    expect(bar).toContain('rgba(255, 107, 107, 0.33)') // #FF6B6B55
    expect(bar).not.toContain('--corum-glass-1')
  })

  it('★ padding[9,12] + gap8 + r12 + 横排 ai=center', () => {
    const bar = rule('bar')
    expect(bar).toContain('padding: 9px 12px')
    expect(bar).toContain('gap: 8px')
    expect(bar).toContain('border-radius: 12px')
    expect(bar).toContain('align-items: center')
    expect(bar).toContain('flex-direction: row')
  })

  it('★ 两行文案行高 16/15（13px 与 12px 字的可读行高）', () => {
    expect(rule('barTitle')).toContain('line-height: 16px')
    expect(rule('barDesc')).toContain('line-height: 15px')
  })

  it('★ 字号走 App 实际字阶（B2·13 / UI·12），不是设计稿窄 mockup 的 11/10', () => {
    // 方案C 是 400 宽的并排对比 mockup（其 Chat Input 被压到 372，真宽 720），
    // 字号档位低于 App 实际 UI 档位；按它写 11/10 会比周围界面小一截。
    const title = rule('barTitle')
    expect(title).toContain('calc(13px * var(--corum-ui-font-scale, 1))')
    expect(title).toContain('font-weight: 600')
    expect(rule('barDesc')).toContain('calc(12px * var(--corum-ui-font-scale, 1))')
  })

  it('★★ 所有 font-size 必须经过 --corum-ui-font-scale（跟随设置面板的「界面字号」）', () => {
    // 全仓 615 处 font-size 都已迁到 `calc(<N>px * var(--corum-ui-font-scale, 1))`
    // （见 corum-ide-ui/client/ui-font-scale.ts）。裸 px 不跟随设置 ⇒ 用户改界面字号时
    // 本面板是唯一不变的那块。这条守卫防的就是「新插件忘了迁」。
    // 取每一条 font-size 声明整行（正则里不能用 `\s*(?!calc\()`——`\s*` 会回溯到零宽，
    // 负向断言就永远不成立），直接抓「font-size: 后面到分号」的整段值再判。
    const decls = stripComments(CSS).match(/^\s*font-size:([^;]*);/gm) ?? []
    expect(decls.length, '没抓到任何 font-size 声明，正则或文件结构变了').toBeGreaterThan(0)
    const bare = decls.filter(decl => !decl.includes('var(--corum-ui-font-scale, 1)'))
    expect(bare, `这些 font-size 没走 --corum-ui-font-scale：${bare.join(' | ')}`).toEqual([])
  })

  it('★ tx 竖排 gap1', () => {
    const tx = rule('barTx')
    expect(tx).toContain('flex-direction: column')
    expect(tx).toContain('gap: 1px')
  })

  it('★「处理」按钮是 $brand-primary 实心 + pad[5,10] + r8 + 12px/700', () => {
    const btn = rule('handleBtn')
    expect(btn).toContain('--dsw-alias-brand-primary')
    expect(btn).toContain('padding: 5px 10px')
    expect(btn).toContain('border-radius: 8px')
    expect(btn).toContain('calc(12px * var(--corum-ui-font-scale, 1))')
    expect(btn).toContain('font-weight: 700')
  })

  it('★ × 按钮 22×22 + r7（设计稿无底色容器）', () => {
    const btn = rule('iconBtn')
    expect(btn).toContain('width: 22px')
    expect(btn).toContain('height: 22px')
    expect(btn).toContain('border-radius: 7px')
    expect(btn).toContain('background: transparent')
  })
})

describe('design.pen jO5So 保真度 —— ② 展开面板 panel-expanded', () => {
  it('★ 容器 $glass-1 + $glass-border + pad[12,14] + gap10 + r16 + 竖排', () => {
    const panel = rule('panel')
    expect(panel).toContain('--corum-glass-1')
    expect(panel).toContain('--corum-glass-border')
    expect(panel).toContain('padding: 12px 14px')
    expect(panel).toContain('gap: 10px')
    expect(panel).toContain('border-radius: 16px')
    expect(panel).toContain('flex-direction: column')
  })

  it('★ phead 高度 + 标题 15px/700（与提问卡 .qTitle 同档）', () => {
    expect(rule('phead')).toContain('height: 21px')
    const t = rule('pheadTx')
    expect(t).toContain('calc(15px * var(--corum-ui-font-scale, 1))')
    expect(t).toContain('font-weight: 700')
  })

  it('★ phead 的 chevron 是**裸 14×14 图标**，不能借用 22×22 的 dismiss 按钮', () => {
    // 借用会让 phead 被撑到 22px，整块面板高出 3px（实测过的偏差）。
    const chev = rule('pheadChev')
    expect(chev).toContain('width: 14px')
    expect(chev).toContain('height: 14px')
    expect(chev).toContain('padding: 0')
    expect(TSX).not.toContain('${css.iconBtn} ${css.pheadChev}')
  })

  it('★ chip：pad[6,9] + gap5 + r9 + 12px/600（行高 15px）', () => {
    const chip = rule('chip')
    expect(chip).toContain('padding: 6px 9px')
    expect(chip).toContain('gap: 5px')
    expect(chip).toContain('border-radius: 9px')
    expect(chip).toContain('calc(12px * var(--corum-ui-font-scale, 1))')
    expect(chip).toContain('line-height: 15px')
    expect(chip).toContain('font-weight: 600')
  })

  it('★ chip 未选中态 = $glass-2 底 + $glass-border 描边 + $label-secondary 字', () => {
    const chip = rule('chip')
    expect(chip).toContain('--corum-glass-2')
    expect(chip).toContain('--corum-glass-border')
    expect(chip).toContain('--dsw-alias-label-secondary')
  })

  it('★ chip 选中态 = #01CDFE14 底 + $glass-border-active 描边 + $brand-primary 字', () => {
    const active = rule('chipActive')
    expect(active).toContain('rgba(1, 205, 254, 0.08)') // #01CDFE14
    expect(active).toContain('--corum-glass-border-active')
    expect(active).toContain('--dsw-alias-brand-text')
  })

  it('★ chips 一排**不换行**（设计稿四个 chip 在 372 宽内一排放下）', () => {
    const chips = rule('chips')
    expect(chips).toContain('flex-direction: row')
    expect(chips).not.toContain('flex-wrap: wrap')
  })

  it('★ picker：$glass-2 + pad[7,10] + gap6 + r10 + **横排 ai=center**', () => {
    const picker = rule('picker')
    expect(picker).toContain('--corum-glass-2')
    expect(picker).toContain('padding: 7px 10px')
    expect(picker).toContain('gap: 6px')
    expect(picker).toContain('border-radius: 10px')
    // 设计稿 picker 是 row（ic + lbl + chev），竖排会让它长得像一块区块。
    expect(picker).toContain('flex-direction: row')
    expect(picker).toContain('align-items: center')
  })

  it('★★ picker 整块**默认不渲染**，选中「临时用主模型」或「永久改指定模型」才出现（用户实测纠正）', () => {
    // 判据：设计稿该行 lbl 原文「指定模型：**选『永久改指定模型』时展开选择**」——
    // 「展开选择」的主语是这一整块（行 + 列表）。
    // issue #166 起「临时用主模型」档也可指定模型，故该块由两档共同驱动（`open={needsRoute}`）。
    //
    // ⚠️ 用户 2026-09-19 实测：「下拉仍然存在，并且是不可选中状态，默认应该隐藏才对」。
    // 此前实现成「行恒显示、只把列表按需展开」，且那行是不可点的 div ⇒ 用户看到一行
    // 带箭头的下拉却点不动。两个错都在本条钉住：①默认不渲染；②出现时是真控件。
    const picker = TSX.slice(TSX.indexOf('function ModelPicker'), TSX.indexOf('export function ModelAskPanel'))
    // ① 默认整块不渲染（early return，而不是渲染成禁用样）。
    expect(picker).toContain('if (!open) return null')
    // ② 列表由 listOpen 控制；行右侧的收起按钮是真 button（不是不可点的 div）。
    expect(picker).toContain('{listOpen && <div className={css.pickerList}>')
    expect(picker).toContain('css.pickerToggle')
    // 行本身是容器（嵌套 button 非法，见 dev-conventions §13.5）。
    expect(picker).toContain('<div className={css.picker}>')
    expect(picker).not.toContain('<button type="button" className={css.picker}>')
    // ③ 调用点用档位决定是否渲染。
    expect(TSX).toContain('open={needsRoute}')
    // 不得回潮成「恒显示 + data-open 样式态」。
    expect(TSX).not.toContain('data-open={open || undefined}')
  })

  it('★ picker 出现时列表默认展开（选中该档的目的就是挑模型，不多要一次点击）', () => {
    expect(TSX).toContain('const [listOpen, setListOpen] = useState(true)')
    expect(TSX).toContain('setListOpen(true)')
  })

  it('★ picker：$glass-2 + pad[7,10] + gap6 + r10 + **横排 ai=center**', () => {
    const picker = rule('picker')
    expect(picker).toContain('--corum-glass-2')
    expect(picker).toContain('padding: 7px 10px')
    expect(picker).toContain('gap: 6px')
    expect(picker).toContain('border-radius: 10px')
    // 设计稿 picker 是 row（ic + lbl + chev），竖排会让它长得像一块区块。
    expect(picker).toContain('flex-direction: row')
    expect(picker).toContain('align-items: center')
  })

  it('★ 应用按钮：$brand-primary + pad[6,12] + gap5 + r8 + 10px/700', () => {
    const btn = rule('applyBtn')
    expect(btn).toContain('--dsw-alias-brand-primary')
    expect(btn).toContain('padding: 6px 12px')
    expect(btn).toContain('gap: 5px')
    expect(btn).toContain('border-radius: 8px')
    expect(btn).toContain('calc(13px * var(--corum-ui-font-scale, 1))')
    expect(btn).toContain('font-weight: 700')
  })

  it('★ pfoot 横排 ai=center gap8；hint 11px $label-tertiary', () => {
    const foot = rule('pfoot')
    expect(foot).toContain('gap: 8px')
    expect(foot).toContain('align-items: center')
    const hint = rule('footHint')
    expect(hint).toContain('calc(11px * var(--corum-ui-font-scale, 1))')
    expect(hint).toContain('--dsw-alias-label-tertiary')
  })
})

describe('design.pen jO5So 保真度 —— ③ 图标（lucide 名逐项取自设计稿，不得按语义猜）', () => {
  it('★★ 档位图标是设计稿指定的 zap / link / repeat / ban', () => {
    // 按语义猜曾用 Check / ChevronRight / X，形状与设计稿完全对不上。
    expect(TSX).toContain("'temporary': Zap")
    expect(TSX).toContain("'permanent-follow': LinkIcon")
    expect(TSX).toContain("'permanent-route': Repeat")
    expect(TSX).toContain("'decline': Ban")
    // issue #166 新增档：设计稿没有它，取本仓「重试」动作的既有图标（corum-ide-ui 同款）。
    expect(TSX).toContain("'retry': RefreshCw")
    // 猜出来的那几个不得回潮（剥注释判：注释里正当地记着这次偏差的原文）。
    const code = stripComments(TSX)
    expect(code).not.toContain('AlertTriangle')
    expect(code).not.toContain('ChevronRight')
    expect(code).not.toContain('Check')
  })

  it('★ 通知条/面板主图标是 unplug（不是 AlertTriangle）', () => {
    expect(TSX).toContain('Unplug')
  })

  it('★ phead chevron 是 chevron-up（收起语义），picker chevron 是 chevron-down', () => {
    expect(TSX).toContain('ChevronUp')
    expect(TSX).toContain('ChevronDown')
  })

  it('★ picker 左侧图标是 cpu', () => {
    expect(TSX).toContain('Cpu')
  })

  it('★ 图标尺寸逐项对齐：条图标 14、面板图标 15、chip/picker 11、chevron 14', () => {
    expect(TSX).toContain('<Unplug size={14} />')   // notify-bar/ic 14×14
    expect(TSX).toContain('<Unplug size={15} />')   // phead/ic 15×15
    expect(TSX).toContain('<Cpu size={11} />')      // picker/ic 11×11
    expect(TSX).toContain('<ChevronUp size={14} />') // phead/chev 14×14
  })
})

describe('design.pen jO5So 保真度 —— ④ 色值纪律', () => {
  it('★ CSS 里除设计稿给定的 alpha 合成色外，不得出现字面 hex', () => {
    // 设计稿直接给的叠加色（#FF6B6B14/#FF6B6B55/#01CDFE14）在仓库里没有对应变量，
    // 按 QuestionCard 的既成做法用 rgba + 注释注明来源。剥注释后判：注释里的设计稿
    // 原文不算违规。
    const hex = stripComments(CSS).match(/#[0-9A-Fa-f]{3,8}\b/g) ?? []
    expect(hex, `CSS 出现未走变量的字面 hex：${hex.join(', ')}`).toEqual([])
  })

  it('★ 三处设计稿 alpha 色都必须带来源注释', () => {
    expect(CSS).toContain('/* #FF6B6B55 */')
    expect(CSS).toContain('/* #FF6B6B14 */')
    expect(CSS).toContain('/* #01CDFE14 */')
  })
})
