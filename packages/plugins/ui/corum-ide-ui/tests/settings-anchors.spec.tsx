/**
 * 设置中心**稳定语义锚点**（黑盒自测定位面）+ 快捷键页搜索框的如实标注。
 *
 * ## 为什么要有这组锚点（缺陷形态）
 *
 * 设置行与设置导航项此前**只有两类可定位面**：
 *   ① CSS Modules 哈希类名（`_5r9HZG_row`）：两端构建不同，每次构建还变 ⇒ 测试必碎；
 *   ② 显示文案（`text:快捷键`）：随语言切换 / 措辞微调即碎，且裸文案匹配会误命中
 *      说明文字（例如「搜索设置…」里也有「设置」）。
 * 结果就是设置类用例只能退化成「标题出现即通过」——那不是判据。本文件钉住两个
 * 稳定锚点：行 `data-setting={label}`、导航项 `data-slot="settings.nav.<sectionId>"`。
 *
 * ## 为什么锚点放在 `row.id` 而不是显示文案
 *
 * `row.id` 是 section 的稳定标识（跨语言、跨构建不变）；显示文案会随 locale 变。
 *
 * ## ③ 为什么快捷键页的搜索框必须是「说明」而不是「输入框」
 *
 * 期望（FUNCTIONAL-TEST-SUITE §3 E6）明确要求：搜索框**如实说明**
 * 「尚未实现，当前为只读展示」。此前它只是一个 `<span>搜索快捷键…</span>`：
 * 看起来可搜、实则不可交互 = 假控件。这里钉住三件事：
 *   - 说明文案里同时出现「尚未实现」与「只读展示」（用户能读到它不工作）；
 *   - 该容器里**没有** input（不是假装成输入框的壳）；
 *   - 容器带 `role="note"`（辅助技术读作说明，而不是输入面）；
 *   - 「重置全部快捷键」保持 `disabled`（没有键盘绑定真源，不许装成可改）。
 *
 * ⚠️ 本文件只断言**本页面的静态形态**；「快捷键列表与实际生效的绑定一致」不在
 * 覆盖范围内（没有键盘绑定真源可对照）。
 *
 * @module @corum/corum-ide-ui/tests/settings-anchors
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingRow } from '../src/client/settings/SettingRow.tsx'
import { ShortcutsSection } from '../src/client/settings/sections/SettingsShortcutsSection.tsx'

/** 读本包源码（用于源码不变式断言，与既有 spec 同口径）。 */
function readSource(rel: string): string {
  return readFileSync(join(import.meta.dirname, '..', rel), 'utf8')
}

describe('设置行锚点：data-setting = 行标题', () => {
  it('SettingRow 把 label 原样投影为 data-setting（含描述与徽标时也不变）', () => {
    const html = renderToStaticMarkup(
      <SettingRow label="轨迹视图" desc="说明文字">
        <span>控件</span>
      </SettingRow>,
    )
    expect(html).toContain('data-setting="轨迹视图"')
    // 行标题本身仍在（锚点不是替代品，只是额外属性）
    expect(html).toContain('轨迹视图')
    expect(html).toContain('说明文字')
  })

  it('锚点值只由 label 决定：不同 label 得到不同锚点（不共用常量）', () => {
    const a = renderToStaticMarkup(<SettingRow label="打开 settings.yaml"><span /></SettingRow>)
    const b = renderToStaticMarkup(<SettingRow label="打开配置目录"><span /></SettingRow>)
    expect(a).toContain('data-setting="打开 settings.yaml"')
    expect(b).toContain('data-setting="打开配置目录"')
  })
})

describe('设置导航锚点：data-slot = settings.nav.<sectionId>', () => {
  it('SettingsShell 的导航按钮以 row.id 生成锚点，且 aria-current 语义不变', () => {
    const src = readSource('src/client/SettingsShell.tsx')
    // 锚点存在且用 id 拼接（不是显示文案）
    expect(src).toContain('data-slot={`settings.nav.${row.id}`}')
    // 既有可访问性语义不得被锚点替换掉
    expect(src).toContain("aria-current={row.id === active ? 'true' : undefined}")
  })
})

describe('快捷键页（E6）：只读展示 + 搜索框如实说明 + 重置按钮禁用', () => {
  const html = renderToStaticMarkup(<ShortcutsSection />)

  it('搜索框如实说明「尚未实现 / 只读展示」，且不是 input', () => {
    expect(html).toContain('尚未实现')
    expect(html).toContain('只读展示')
    expect(html).not.toContain('<input')
    expect(html).toContain('role="note"')
    expect(html).toContain('data-slot="settings.shortcuts.search-notice"')
  })

  it('只读列出已实现的快捷键（五个命令行 + 各自键位）', () => {
    for (const label of ['打开设置', '快速打开文件', '命令面板', '新建会话', '关闭弹层']) {
      expect(html).toContain(`data-setting="${label}"`)
    }
    for (const kbd of ['Cmd+,', 'Cmd+K', 'Cmd+Shift+P', 'Cmd+N', 'Esc']) {
      expect(html).toContain(kbd)
    }
  })

  it('「重置全部快捷键」是 disabled（没有键盘绑定真源，不许装成可改）', () => {
    const m = html.match(/<button[^>]*>重置全部快捷键<\/button>/)
    expect(m).not.toBeNull()
    expect(m?.[0]).toContain('disabled')
  })
})
