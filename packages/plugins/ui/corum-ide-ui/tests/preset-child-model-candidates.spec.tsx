/**
 * issue #165 UI 面：Agent 预设编辑页的「子 Agent 候选模型」覆盖。
 *
 * 钉三条：
 *  ① **保存载荷**：切到「本预设自定义」并填一条候选 ⇒ 载荷里出现
 *    `childModelCandidates`（含 tags/note）；切回「使用全局候选集」⇒ 载荷为
 *    undefined（= 不写该键，见 `child-model-candidates.ts` 的不变式 ①）；
 *  ② **读回**：`profile.childModelCandidates` 存在且 enabled ⇒ 草稿落在「自定义」并
 *    回填候选行；缺省 / 未开启 / 空候选 ⇒ 落在「使用全局候选集」；
 *  ③ **导航分组**：跨 bundle 的 section id 在壳的数据源里归属「智能体」组（缺了这条
 *    它会被当成扩展组的项落到「扩展」区）。
 *
 * DOM 复用仓库已安装的 domino（与 corum-ui-settings-plugins 的卡片测试同一手法），
 * 不给产品包增加运行时或测试依赖。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { ChildModelCandidatesEditor } from '../src/client/settings/sections/ChildModelCandidatesEditor.tsx'
import {
  childModelCandidatesDraftFrom,
  childModelCandidatesPayload,
  parseCandidateTags,
  type ChildModelCandidateDraft, type ChildModelCandidatesMode,
} from '../src/client/settings/sections/child-model-candidates.ts'
import { NAV_GROUP_BY_ID } from '../src/client/settings/SettingsSections.tsx'

/** DOM globals from the workspace-installed domino (no new dependency). */
const pnpm = resolve(import.meta.dirname, '../../../../../node_modules/.pnpm')
const domino = readdirSync(pnpm).find(name => name.startsWith('@mixmark-io+domino@'))!
const { createWindow } = createRequire(import.meta.url)(join(pnpm, domino, 'node_modules/@mixmark-io/domino'))
const window = createWindow('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})

/** what one `onChange` call looked like */
type Change = [ChildModelCandidatesMode, ChildModelCandidateDraft[]]

/**
 * Stateful stand-in for the edit page's `setDraft` handling: the editor is a
 * controlled component, so a harness must own the state the page would own.
 */
function Harness({ onEmit }: { onEmit: (change: Change) => void }) {
  const [state, setState] = useState<{ candidatesMode: ChildModelCandidatesMode; candidates: ChildModelCandidateDraft[] }>({
    candidatesMode: 'global',
    candidates: [],
  })
  return (
    <ChildModelCandidatesEditor
      mode={state.candidatesMode}
      candidates={state.candidates}
      onChange={(mode, candidates) => {
        onEmit([mode, candidates])
        setState({ candidatesMode: mode, candidates })
      }}
    />
  )
}

let root: Root
let container: HTMLElement

beforeEach(() => {
  container = window.document.createElement('div')
  window.document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
})

/** 挂上编辑器并把每次 `onChange` 记进 `changes`。 */
async function mountEditor(changes: Change[]): Promise<void> {
  await act(async () => { root.render(<Harness onEmit={change => changes.push(change)} />) })
}

/** 按 aria-label 找输入框（中文标签即组件里的可访问名字）。 */
function input(label: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  expect(found, `输入框「${label}」`).toBeDefined()
  return found!
}

/** 按 aria-label 找按钮。 */
function button(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(found, `按钮「${label}」`).toBeDefined()
  return found!
}

/** 驱动一个受控输入（domino 的裸 input 事件到不了 React，见卡片测试的同一注释）。 */
async function typeInto(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => { Simulate.change(element, { target: { value } } as never) })
}

/**
 * 选一个候选集来源。
 *
 * 用 `Simulate.change` 而不是 `.click()`：domino 的 `click()` 对单选会走「同组互斥」
 * 的激活步骤（`this.form.getElementsByName`），而 `form` 只在 HTML **解析期**挂给控件
 * ——React 创建的元素没有它 ⇒ 抛错。真实浏览器没有这个前置条件。
 */
async function chooseMode(value: ChildModelCandidatesMode): Promise<void> {
  const radio = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)
  expect(radio, `候选集来源单选项「${value}」`).toBeDefined()
  await act(async () => {
    Simulate.change(radio!, { target: { checked: true, type: 'radio' } } as never)
  })
}

describe('#165 预设候选集 — 编辑器把行交回草稿、保存载荷带上 childModelCandidates', () => {
  it('切到自定义并填一条候选 ⇒ 载荷含 provider/model/tags/note', async () => {
    const changes: Change[] = []
    await mountEditor(changes)
    // 默认「使用全局候选集」：没有候选行编辑器。
    expect(container.querySelector('input[aria-label^="能力标注"]')).toBeUndefined()

    await chooseMode('custom')
    await act(async () => { button('添加候选').click() })
    await typeInto(input('提供方 — 候选 1'), 'p-a')
    await typeInto(input('模型 — 候选 1'), 'm-1')
    await typeInto(input('能力标注 — 候选 1'), '长上下文, 快速，长上下文')
    await typeInto(input('备注 — 候选 1'), '  大改首选  ')

    const last = changes[changes.length - 1]!
    // 保存的就是这一份：与 doSave 同一条路径（childModelCandidatesPayload）。
    expect(childModelCandidatesPayload(last[0], last[1])).toEqual({
      enabled: true,
      models: [{
        provider: 'p-a',
        model: 'm-1',
        // 中英文逗号都切、去重、去空白；备注 trim。
        tags: ['长上下文', '快速'],
        note: '大改首选',
      }],
    })
  })

  it('切回「使用全局候选集」⇒ 载荷为 undefined（保存时不写该键）', async () => {
    const changes: Change[] = []
    await mountEditor(changes)
    await chooseMode('custom')
    await act(async () => { button('添加候选').click() })
    await typeInto(input('提供方 — 候选 1'), 'p-a')
    await typeInto(input('模型 — 候选 1'), 'm-1')

    await chooseMode('global')
    const last = changes[changes.length - 1]!
    expect(last[0]).toBe('global')
    expect(childModelCandidatesPayload(last[0], last[1])).toBeUndefined()
  })

  it('删除按钮去掉对应行，行号随之重排', async () => {
    const changes: Change[] = []
    await mountEditor(changes)
    await chooseMode('custom')
    await act(async () => { button('添加候选').click() })
    await act(async () => { button('添加候选').click() })
    await typeInto(input('提供方 — 候选 2'), 'p-b')
    await act(async () => { button('移除候选 1').click() })
    const last = changes[changes.length - 1]!
    expect(last[1]).toHaveLength(1)
    // 原来的第 2 行现在是第 1 行，值没有丢。
    expect(input('提供方 — 候选 1').value).toBe('p-b')
  })
})

describe('#165 预设候选集 — 读回 profile', () => {
  it('存在且 enabled ⇒ 自定义 + 回填候选行（标签按编辑器文本格式化）', () => {
    const draft = childModelCandidatesDraftFrom({
      enabled: true,
      models: [{ provider: 'p-a', model: 'm-1', tags: ['长上下文', '快速'], note: '大改首选' }],
    })
    expect(draft).toEqual({
      candidatesMode: 'custom',
      candidates: [{ provider: 'p-a', model: 'm-1', tagsText: '长上下文, 快速', noteText: '大改首选' }],
    })
    // 与卡片同一份格式化规则（逗号 + 空格）。
    expect(draft.candidates[0]?.tagsText).toBe('长上下文, 快速')
  })

  it('缺省 / 未开启 / 空候选 ⇒ 使用全局候选集', () => {
    for (const value of [undefined, { enabled: false, models: [] }, { enabled: true, models: [] }]) {
      expect(childModelCandidatesDraftFrom(value as never)).toEqual({ candidatesMode: 'global', candidates: [] })
    }
  })

  it('自定义模式下没填全的行被丢弃；全空 ⇒ 不写键（= 用全局）', () => {
    expect(childModelCandidatesPayload('custom', [
      { provider: '', model: '', tagsText: '', noteText: '' },
    ])).toBeUndefined()
    expect(childModelCandidatesPayload('custom', [
      { provider: 'p-a', model: '', tagsText: '', noteText: '' },
      { provider: 'p-b', model: 'm-9', tagsText: '', noteText: '' },
    ])).toEqual({ enabled: true, models: [{ provider: 'p-b', model: 'm-9' }] })
  })

  it('标签解析与全局候选集卡片同一规则（中英文逗号 / trim / 去重 / 丢空项）', () => {
    expect(parseCandidateTags('长上下文, 快速，多模态 ,, 快速 ')).toEqual(['长上下文', '快速', '多模态'])
    expect(parseCandidateTags('   ')).toEqual([])
  })
})

describe('#165 预设候选集 — 编辑页接线与导航分组', () => {
  const SECTION = readFileSync(
    join(import.meta.dirname, '../src/client/settings/sections/SettingsAgentPresetsSection.tsx'),
    'utf8',
  )

  it('编辑页的保存载荷里确实带 childModelCandidates（字段接错即红）', () => {
    expect(SECTION).toContain('childModelCandidatesPayload(draft.candidatesMode, draft.candidates)')
    expect(SECTION).toContain('childModelCandidates: candidatesPayload')
    // 读回也接上了（缺了它就永远显示「使用全局候选集」）。
    expect(SECTION).toContain('...childModelCandidatesDraftFrom(p.childModelCandidates)')
  })

  it('「子 Agent 候选模型」编辑块挂在编辑页正文里（不是只在注释里）', () => {
    expect(SECTION).toContain('<ChildModelCandidatesEditor')
    expect(SECTION).toContain('子 Agent 候选模型')
  })

  it('跨 bundle 的 section 归属「智能体」组', () => {
    expect(NAV_GROUP_BY_ID['subagent-model-candidates']).toBe('agent')
  })
})