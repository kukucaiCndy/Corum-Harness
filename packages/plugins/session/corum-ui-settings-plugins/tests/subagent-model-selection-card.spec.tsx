/**
 * issue #165：子 Agent 模型候选集的能力标注在卡片里能编辑、能落盘。
 *
 * 本 spec 钉两件事：
 * 1. **控制器**（真正决定写什么）：标签/备注/手工新增候选都会进
 *    `allowedModels` 的那一次 `mutate`；没有标注的路由写回去时**不带**新字段
 *    （老配置的形状不被顺带改写）；
 * 2. **卡片组件**：已选候选行渲染「能力标注」「备注」两个输入，输入即交给
 *    `editTags` / `editNote`；「添加候选」表单交给 `addCandidate`。
 *
 * DOM 复用仓库已安装的 domino（与 corum-ui-settings-models / corum-ui-conversation
 * 同一手法），不给产品包增加运行时或测试依赖。
 */
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  parseSubagentModelTags,
  subagentModelKey,
  SubagentModelSelectionCardController,
  type AllowedSubagentModel,
  type SubagentModelSelectionCardState,
  type SubagentModelSelectionSettings,
} from '../src/client/subagent-model-selection-card-controller.ts'
import { SubagentModelSelectionCard } from '../src/client/SubagentModelSelectionCard.tsx'

/** Settings scope stand-in: mirrors accepted values and records each write. */
function fakeScope(initial: SubagentModelSelectionSettings) {
  let revision = 1
  let value = initial
  const writes: SubagentModelSelectionSettings[] = []
  const listeners = new Set<() => void>()
  const scope = {
    getSnapshot: (): ConfigFormSnapshot<SubagentModelSelectionSettings> => ({
      status: 'ready',
      value,
      base: undefined,
      user: value,
      revision,
      writable: true,
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate: async (ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => {
      const next: SubagentModelSelectionSettings = {
        enabled: value.enabled,
        allowedModels: value.allowedModels.map(route => ({ ...route })),
      }
      for (const op of ops) {
        if (op.op !== 'set') continue
        if (op.path[0] === 'enabled') next.enabled = op.value as boolean
        if (op.path[0] === 'allowedModels') next.allowedModels = op.value as AllowedSubagentModel[]
      }
      value = next
      revision += 1
      writes.push({ enabled: next.enabled, allowedModels: next.allowedModels.map(r => ({ ...r })) })
      for (const listener of listeners) listener()
      return true
    },
  }
  return { scope: scope as unknown as ConfigForm<SubagentModelSelectionSettings>, writes }
}

/** Client context whose only used surface is the Host model catalog. */
function fakeContext(): ClientContext {
  return {
    remote: {
      session: {
        modelCatalog: async () => ({
          ok: true,
          value: {
            failures: [],
            groups: [{ id: 'p-a', name: 'Provider A', models: [{ id: 'm-1', name: 'Model One' }] }],
          },
        }),
      },
    },
  } as unknown as ClientContext
}

const ROUTE: AllowedSubagentModel = { provider: 'p-a', model: 'm-1' }

describe('#165 标签文本解析', () => {
  it('中英文逗号都切、去空白、去重、丢空项', () => {
    expect(parseSubagentModelTags('长上下文, 快速，多模态 ,, 快速 ')).toEqual(['长上下文', '快速', '多模态'])
    expect(parseSubagentModelTags('   ')).toEqual([])
  })
})

describe('#165 控制器把能力标注写进 settings', () => {
  it('标签 + 备注随一次 mutate 落到 allowedModels', async () => {
    const { scope, writes } = fakeScope({ enabled: true, allowedModels: [ROUTE] })
    const controller = new SubagentModelSelectionCardController(scope, fakeContext())
    const face = controller.inject()
    face.editTags(subagentModelKey(ROUTE), '长上下文, 快速')
    face.editNote(subagentModelKey(ROUTE), '  大改首选  ')
    face.save()
    await vi.waitFor(() => { expect(writes.length).toBe(1) })
    expect(writes[0]?.allowedModels).toEqual([
      { provider: 'p-a', model: 'm-1', tags: ['长上下文', '快速'], note: '大改首选' },
    ])
    // 段落式输入不应把原始文本（前导空格）写进配置。
    expect(writes[0]?.allowedModels[0]?.note).toBe('大改首选')
    controller.dispose()
  })

  it('清空标注 ⇒ 写回的是老形状（不带 tags/note 键）', async () => {
    const { scope, writes } = fakeScope({
      enabled: true,
      allowedModels: [{ provider: 'p-a', model: 'm-1', tags: ['快速'], note: '旧备注' }],
    })
    const controller = new SubagentModelSelectionCardController(scope, fakeContext())
    const face = controller.inject()
    face.editTags(subagentModelKey(ROUTE), '')
    face.editNote(subagentModelKey(ROUTE), '')
    face.save()
    await vi.waitFor(() => { expect(writes.length).toBe(1) })
    expect(writes[0]?.allowedModels).toEqual([{ provider: 'p-a', model: 'm-1' }])
    controller.dispose()
  })

  it('手工新增目录里没有的候选也能落盘（并保留已配标注）', async () => {
    const { scope, writes } = fakeScope({ enabled: true, allowedModels: [ROUTE] })
    const controller = new SubagentModelSelectionCardController(scope, fakeContext())
    const face = controller.inject()
    face.editTags(subagentModelKey(ROUTE), '多模态')
    face.addCandidate(' p-b ', ' m-9 ')
    face.save()
    await vi.waitFor(() => { expect(writes.length).toBe(1) })
    expect(writes[0]?.allowedModels).toEqual([
      { provider: 'p-a', model: 'm-1', tags: ['多模态'] },
      { provider: 'p-b', model: 'm-9' },
    ])
    controller.dispose()
  })

  it('标签输入保留用户正在敲的原文（不把末尾逗号吃掉）', () => {
    const { scope } = fakeScope({ enabled: true, allowedModels: [ROUTE] })
    const controller = new SubagentModelSelectionCardController(scope, fakeContext())
    const face = controller.inject()
    face.editTags(subagentModelKey(ROUTE), '长上下文, ')
    const state = controller.inject().hooks.subagentModelSelectionCard.getSnapshot()
    const row = state.candidates.find(candidate => candidate.key === subagentModelKey(ROUTE))
    expect(row?.tagsText).toBe('长上下文, ')
    expect(row?.tags).toEqual(['长上下文'])
    controller.dispose()
  })
})

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

let root: Root
let container: HTMLElement

beforeEach(() => {
  container = window.document.createElement('div')
  window.document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  vi.unstubAllGlobals()
})

/** One fully selected candidate row with annotations. */
function cardState(over: Partial<SubagentModelSelectionCardState> = {}): SubagentModelSelectionCardState {
  return {
    available: true,
    writable: true,
    dirty: true,
    invalid: false,
    saving: false,
    failed: false,
    enabled: true,
    catalogStatus: 'ready',
    catalogPartial: false,
    conflicted: false,
    candidates: [{
      provider: 'p-a',
      model: 'm-1',
      key: subagentModelKey(ROUTE),
      providerName: 'Provider A',
      modelName: 'Model One',
      available: true,
      selected: true,
      tags: ['长上下文'],
      note: '大改首选',
      tagsText: '长上下文',
      noteText: '大改首选',
    }],
    ...over,
  }
}

/** Mount the card expanded, wired to spies; `t` returns the locale key. */
async function mountCard(state: SubagentModelSelectionCardState) {
  const editTags = vi.fn()
  const editNote = vi.fn()
  const addCandidate = vi.fn()
  const t = (key: string) => key
  const useSubagentModelSelectionCard = <S,>(selector: (snapshot: SubagentModelSelectionCardState) => S): S =>
    selector(state)
  const props = {
    t,
    useSubagentModelSelectionCard,
    toggleEnabled: vi.fn(),
    toggleModel: vi.fn(),
    editTags,
    editNote,
    addCandidate,
    retryCatalog: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  }
  await act(async () => {
    root.render(
      <ul>
        <SubagentModelSelectionCard {...props as never} />
      </ul>,
    )
  })
  // The card body only renders once expanded (PluginCard starts collapsed).
  const header = Array.from(container.querySelectorAll('button'))
    .find(button => button.getAttribute('aria-label')?.startsWith('expand:'))
  expect(header, '卡片展开按钮').toBeDefined()
  await act(async () => header!.click())
  return { editTags, editNote, addCandidate }
}

/**
 * Drive one controlled input through React's synthetic event system.
 *
 * Dispatching a native `input` event on a domino node never reaches React's
 * `onChange` (its change plugin cannot validate a trust-less target), so the
 * test uses the `Simulate` entry react-dom exposes for exactly this case.
 */
async function typeInto(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Simulate.change(element, { target: { value } } as never)
  })
}

describe('#165 卡片把标签写进 settings', () => {
  it('已选候选行渲染标注/备注输入，输入即交给 editTags / editNote', async () => {
    const spies = await mountCard(cardState())
    const tags = container.querySelector<HTMLInputElement>(
      'input[aria-label="subagentModelSelectionTags — p-a/m-1"]',
    )
    const note = container.querySelector<HTMLInputElement>(
      'input[aria-label="subagentModelSelectionNote — p-a/m-1"]',
    )
    expect(tags?.value).toBe('长上下文')
    expect(note?.value).toBe('大改首选')
    await typeInto(tags!, '长上下文, 多模态')
    expect(spies.editTags).toHaveBeenCalledWith(subagentModelKey(ROUTE), '长上下文, 多模态')
    await typeInto(note!, '一起改')
    expect(spies.editNote).toHaveBeenCalledWith(subagentModelKey(ROUTE), '一起改')
  })

  it('手工添加候选：两个输入 + 提交按钮交给 addCandidate', async () => {
    const spies = await mountCard(cardState())
    const provider = container.querySelector<HTMLInputElement>(
      'input[aria-label="subagentModelSelectionProviderPlaceholder"]',
    )
    const model = container.querySelector<HTMLInputElement>(
      'input[aria-label="subagentModelSelectionModelPlaceholder"]',
    )
    await typeInto(provider!, 'p-b')
    await typeInto(model!, 'm-9')
    const submit = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === 'subagentModelSelectionAdd')
    // 两个 id 都填了才可提交（空输入不产生候选）。
    expect(submit?.disabled).toBe(false)
    // domino 不实现「submit 按钮点击 ⇒ form submit」的隐式行为，直接投递 form 的 submit。
    const form = container.querySelector('form')!
    await act(async () => { Simulate.submit(form) })
    expect(spies.addCandidate).toHaveBeenCalledWith('p-b', 'm-9')
    // 提交后清空，避免同一路由被连点两次。
    expect(provider!.value).toBe('')
    expect(model!.value).toBe('')
  })

  it('未选中的候选不渲染标注编辑器（标签只对有意义的行出现）', async () => {
    const state = cardState()
    await mountCard({
      ...state,
      candidates: state.candidates.map(candidate => ({ ...candidate, selected: false })),
    })
    expect(container.querySelector('input[aria-label^="subagentModelSelectionTags"]') ?? null).toBeNull()
  })
})