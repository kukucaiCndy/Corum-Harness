/**
 * issue #165：全局候选集的**可达入口**（「设置 → 智能体 → 子 Agent 候选模型」）。
 *
 * 钉三件事：
 *  ① 注册项真的存在：`settings.section` / id `subagent-model-candidates` / 与
 *    「智能体」组同序位（order 70）/ 导航文案取自本包字典；
 *  ② 注入面就是现成那张卡的**同一份** controller 面（hooks + 全部动作），不是新造一份
 *    状态；section 组件确实把卡片渲染出来（薄适配不是空壳）；
 *  ③ 负向：卡片仍**不**注册进 `settings.plugin.item`——那个子槽没有渲染者，注册进去
 *    就是回到「注册了也看不见」的原状。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'
import { SubagentModelCandidatesSection } from '../src/client/SubagentModelCandidatesSection.tsx'
import { SubagentModelSelectionCard } from '../src/client/SubagentModelSelectionCard.tsx'
import {
  SUBAGENT_MODEL_SELECTION_NS, subagentModelKey,
  type SubagentModelSelectionCardState,
} from '../src/client/subagent-model-selection-card-controller.ts'
import { zh } from '../src/client/locales.ts'

/** One registered entry captured from the fake slot ledger. */
interface Captured { options: Record<string, unknown>; component: unknown }

/** 一条已注册 settings.section 的最小投影（只读我们断言的字段）。 */
interface CapturedSection extends Captured {
  options: {
    name: string
    id: string
    order: number
    label: () => string
    inject: () => Record<string, unknown>
  } & Record<string, unknown>
}

/**
 * Client context stand-in: only the surfaces `apply` touches (locale dictionary,
 * effect, configForms mirror, slot ledger, remote events + model catalog).
 */
function fakeContext() {
  const dictionaries: Record<string, Record<string, string>> = {}
  const sections: Captured[] = []
  const items: Captured[] = []
  let revision = 1
  const form = {
    getSnapshot: () => ({
      status: 'ready',
      value: { enabled: false, allowedModels: [] },
      base: undefined,
      user: { enabled: false, allowedModels: [] },
      revision,
      writable: true,
    }),
    subscribe: () => () => {},
    set: async () => { revision += 1; return true },
    unset: async () => { revision += 1; return true },
    mutate: async () => { revision += 1; return true },
  }
  const ctx = {
    locale: {
      // 绑定时字典还没注册（apply 的顺序就是绑定在前），故在**调用时**解析。
      bind: (ns: string) => (key: string) => dictionaries[ns]?.[key] ?? key,
      register: (ns: string, dicts: { zh: Record<string, string> }) => {
        dictionaries[ns] = dicts.zh
        return () => {}
      },
    },
    effect: (fn: () => unknown) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    configForms: {
      get: () => form,
      describe: () => ({
        subscribe: () => () => {},
        ensure: () => {},
        getSnapshot: () => ({ view: undefined }),
      }),
    },
    slots: {
      inject: (_name: string, factory: () => unknown) => {
        const result = factory()
        return typeof result === 'function' ? result : () => {}
      },
      register: (options: Record<string, unknown>, component: unknown) => {
        if (options.name === 'settings.section') sections.push({ options, component })
        else items.push({ options, component })
        return () => {}
      },
      entries: () => [],
      subscribe: () => () => {},
    },
    remote: {
      $on: () => () => {},
      session: { modelCatalog: async () => ({ ok: true, value: { failures: [], groups: [] } }) },
    },
    on: () => () => {},
  }
  return { ctx: ctx as unknown as ClientContext, sections, items, dictionaries }
}

describe('#165 全局候选集 — 设置入口注册项', () => {
  it('注册了一条 settings.section「子 Agent 候选模型」', () => {
    const { ctx, sections } = fakeContext()
    apply(ctx)
    const section = sections.find(entry => entry.options.id === 'subagent-model-candidates') as CapturedSection | undefined
    expect(section, 'settings.section 注册项').toBeDefined()
    expect(section!.options.name).toBe('settings.section')
    // order 70：落在「权限与保护」(65) 之后、「Hooks」(90) 之前——智能体组内的候选面。
    expect(section!.options.order).toBe(70)
    // 导航文案走本包字典（中英各一份，缺一个键会在编译期红）。
    expect(section!.options.label()).toBe('子 Agent 候选模型')
    expect(zh.subagentModelCandidatesNav).toBe('子 Agent 候选模型')
  })

  it('注入面复用的是现成卡片 controller 的同一份面', () => {
    const { ctx, sections } = fakeContext()
    apply(ctx)
    const section = sections.find(entry => entry.options.id === 'subagent-model-candidates') as CapturedSection
    const face = section.options.inject()
    expect((face as { hooks?: Record<string, unknown> }).hooks?.subagentModelSelectionCard).toBeDefined()
    for (const action of ['toggleEnabled', 'toggleModel', 'editTags', 'editNote', 'addCandidate', 'retryCatalog', 'save', 'discard']) {
      expect(typeof face[action], `动作 ${action}`).toBe('function')
    }
    void SUBAGENT_MODEL_SELECTION_NS
  })

  it('section 组件把卡片渲染出来（薄适配不是空壳）', () => {
    const route = { provider: 'p-a', model: 'm-1' }
    const state: SubagentModelSelectionCardState = {
      available: true,
      writable: true,
      dirty: false,
      invalid: false,
      saving: false,
      failed: false,
      enabled: false,
      catalogStatus: 'idle',
      catalogPartial: false,
      conflicted: false,
      candidates: [{
        ...route,
        key: subagentModelKey(route),
        providerName: 'Provider A',
        modelName: 'Model One',
        available: true,
        selected: false,
        tags: [],
        note: '',
        tagsText: '',
        noteText: '',
      }],
    }
    // PropsRuntime<'settings.plugin.item'> 只有可选的 children 标记位 ⇒ 测试里不必给；
    // 其余 props 面由断言逐条钉住，故此处一次收成对象再展开。
    const props = {
      t: (key: string) => key,
      useSubagentModelSelectionCard: (selector: (snapshot: SubagentModelSelectionCardState) => unknown) => selector(state),
      toggleEnabled: () => {},
      toggleModel: () => {},
      editTags: () => {},
      editNote: () => {},
      addCandidate: () => {},
      retryCatalog: () => {},
      save: () => {},
      discard: () => {},
    } as never
    const html = renderToStaticMarkup(<SubagentModelCandidatesSection {...props} />)
    // 卡片标题 + 插件名，即 configurable tab 之外的同一张卡。
    expect(html).toContain('subagentModelSelectionTitle')
    expect(html).toContain('<ul')
  })

  it('卡片仍不注册进 settings.plugin.item（那个子槽没有渲染者）', () => {
    const { ctx, items } = fakeContext()
    apply(ctx)
    expect(items.map(entry => entry.component)).not.toContain(SubagentModelSelectionCard)
    expect(items.map(entry => (entry.options as { key?: string }).key)).not.toContain('web-search-deepseek')
  })
})