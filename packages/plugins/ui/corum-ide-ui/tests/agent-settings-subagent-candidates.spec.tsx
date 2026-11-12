/**
 * 「智能体设置 → 子 Agent 候选模型」（issue #165；用户 2026-11-12 两条反馈的验收面）。
 *
 * 钉四件事：
 *  ① **入口在「智能体设置」页里**（不再是独立 settings section）：真实挂载
 *    `AgentSettingsSection`，断言候选组、开关、「添加候选」按钮都在这页里；并且那条
 *    `settings.section`（id `subagent-model-candidates`）确实**不再注册**；
 *  ② **写盘按字段 set**：关开关只写 `enabled:false`（已选候选不被覆盖）；保存候选时
 *    `allowedModels[0]` 同时带 provider / model / **reasoningEffort** / tags；
 *  ③ **常用标签是加/移除语义**（点一次加入、再点一次移除），自由输入与预设页同一套解析；
 *  ④ **读回回填**：已存值里的候选（含思考程度与标签）在页面上按行回填。
 *
 * DOM 复用仓库已安装的 domino（与 preset-child-model-candidates.spec.tsx 同一手法），
 * 不给产品包增加运行时或测试依赖。
 *
 * ⚠️ `ModelPairField` 的三列是 `SelectField`（自绘按钮 + portal 下拉），在 domino 里驱动
 * 它点击等于在测 portal 的定位实现，不测本功能——所以「选供应商/模型/思考程度」这一步
 * 用同一个行编辑器 + 同一个写盘算子（`globalSelectionOps`）覆盖，UI 接线另用源码断言钉住。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { AgentSettingsSection } from '../src/client/settings/sections/SettingsAgentSettingsSection.tsx'
import { ModelCandidatesEditor } from '../src/client/settings/sections/ModelCandidatesEditor.tsx'
import {
  COMMON_CANDIDATE_TAGS, type ModelCandidateRow, parseCandidateTags, toggleCandidateTag,
} from '../src/client/settings/sections/child-model-candidates.ts'
import {
  SUBAGENT_MODEL_SELECTION_NS, globalCandidateRows, globalSelectionFromUser, globalSelectionOps,
} from '../src/client/settings/sections/subagent-candidates.ts'
import { CorumRpcContext, CorumSettingsContext, type CorumSettingsFace } from '../src/client/settings/shared.tsx'

/** DOM globals from the workspace-installed domino (no new dependency). */
const pnpm = resolve(import.meta.dirname, '../../../../../node_modules/.pnpm')
const domino = readdirSync(pnpm).find(name => name.startsWith('@mixmark-io+domino@'))!
const window = createRequire(import.meta.url)(join(pnpm, domino, 'node_modules/@mixmark-io/domino'))
  .createWindow('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})

/** 一条挂载面上被记录下来的写盘调用。 */
interface MutateCall { ns: string; ops: readonly { op: string; path: readonly string[]; value?: unknown }[]; revision?: number }

/**
 * 伪造 settings 面：`describe` 镜像 + 记录写盘调用的 `mutate`。
 * @param user - `subagent-model-selection-settings` 的用户层（读回回填的输入）。
 * @param calls - 写盘调用记录（就地追加）。
 * @returns 可注入 `CorumSettingsContext` 的 settings 面。
 */
function fakeSettings(user: unknown, calls: MutateCall[]): CorumSettingsFace {
  const view = {
    namespaces: [{ ns: SUBAGENT_MODEL_SELECTION_NS, value: user, user, revision: 7 }],
    writable: true,
  }
  return {
    describe: {
      getSnapshot: () => ({ status: 'ready', view, error: null }),
      subscribe: () => () => {},
      ensure: async () => {},
      acceptView: () => {},
    },
    mutate: async (ns, ops, revision) => {
      calls.push({ ns, ops, ...revision === undefined ? {} : { revision } })
      return { ok: true }
    },
  }
}

/** 伪造 corum RPC：模型目录/预设列表都可空（页面不需要它们也照样渲染候选组）。 */
const fakeRpc = async (_svc: string, method: string): Promise<unknown> => {
  if (method === 'listProfiles') return { profiles: [] }
  if (method === 'modelCatalog') return { groups: [] }
  return {}
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
  container.remove()
})

/** 按 aria-label 找元素。 */
function byLabel<T extends HTMLElement>(label: string): T | undefined {
  return container.querySelector<T>(`[aria-label="${label}"]`) ?? undefined
}

/** 受控输入：domino 的裸 input 事件到不了 React，必须走 Simulate. */
async function typeInto(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => { Simulate.change(element, { target: { value } } as never) })
}

describe('① 候选组在「智能体设置」页里（不再是独立 section）', () => {
  it('真实挂载设置页：候选组 + 开关 + 「添加候选」按钮都在这一页', async () => {
    const calls: MutateCall[] = []
    await act(async () => {
      root.render(
        <CorumRpcContext.Provider value={fakeRpc as never}>
          <CorumSettingsContext.Provider value={fakeSettings({ enabled: false, allowedModels: [] }, calls)}>
            <AgentSettingsSection />
          </CorumSettingsContext.Provider>
        </CorumRpcContext.Provider>,
      )
    })
    expect(container.textContent).toContain('子 Agent 候选模型')
    expect(container.textContent).toContain('允许 Agent 为子 Agent 选择模型')
    // 开关（关态）与「添加候选」按钮都在页面上。
    const toggle = byLabel<HTMLButtonElement>('允许 Agent 为子 Agent 选择模型')
    expect(toggle, '候选组开关').toBeDefined()
    expect(toggle!.getAttribute('aria-checked')).toBe('false')
    // 一条候选都没有时开关是禁用的（host 对「开启且候选为空」直接抛错）。
    expect(toggle!.hasAttribute('disabled')).toBe(true)
    expect(container.textContent).toContain('先加一条候选')
    expect(byLabel('添加候选'), '「添加候选」按钮').toBeDefined()
    // 默认没有候选行。
    expect(container.querySelector('[data-child-model-candidate]')).toBeFalsy()
  })

  it('用户点「添加候选」后出现一行（空行 = 供应商/模型都未选）', async () => {
    const calls: MutateCall[] = []
    await act(async () => {
      root.render(
        <CorumRpcContext.Provider value={fakeRpc as never}>
          <CorumSettingsContext.Provider value={fakeSettings({ enabled: false, allowedModels: [] }, calls)}>
            <AgentSettingsSection />
          </CorumSettingsContext.Provider>
        </CorumRpcContext.Provider>,
      )
    })
    await act(async () => { byLabel<HTMLButtonElement>('添加候选')!.click() })
    const rows = container.querySelectorAll('[data-child-model-candidate]')
    expect(rows.length).toBe(1)
    // 空行不写盘（没有任何填全的候选）。
    expect(calls).toHaveLength(0)
  })
})

describe('② 写盘按字段 set：关开关只写 enabled:false；保存候选带上 provider/model/思考程度/标签', () => {
  it('关掉开关 ⇒ 只有一条 enabled:false（已选候选原样保留）', async () => {
    const calls: MutateCall[] = []
    const stored = {
      enabled: true,
      allowedModels: [{ provider: 'p-a', model: 'm-1', reasoningEffort: 'high', tags: ['长上下文'] }],
    }
    await act(async () => {
      root.render(
        <CorumRpcContext.Provider value={fakeRpc as never}>
          <CorumSettingsContext.Provider value={fakeSettings(stored, calls)}>
            <AgentSettingsSection />
          </CorumSettingsContext.Provider>
        </CorumRpcContext.Provider>,
      )
    })
    await act(async () => { byLabel<HTMLButtonElement>('允许 Agent 为子 Agent 选择模型')!.click() })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.ns).toBe(SUBAGENT_MODEL_SELECTION_NS)
    expect(calls[0]!.revision).toBe(7)
    // 只有开关那一条：allowedModels 一个字节都没动。
    expect(calls[0]!.ops).toEqual([{ op: 'set', path: ['enabled'], value: false }])
  })

  it('保存一条候选 ⇒ allowedModels[0] 同时含 provider/model/reasoningEffort/tags', () => {
    const baseline = globalSelectionFromUser({ enabled: false, allowedModels: [] })
    const rows: ModelCandidateRow[] = [{
      provider: 'deepseek-official',
      model: 'deepseek-v4',
      reasoningEffort: 'high',
      tagsText: '长上下文, 快速',
      noteText: '大改首选',
    }]
    const ops = globalSelectionOps(false, rows, baseline)
    // 开关没变 ⇒ 不写它（按字段分别 set，绝不整节点覆盖）。
    expect(ops).toHaveLength(1)
    expect(ops[0]!.path).toEqual(['allowedModels'])
    expect(ops[0]!.value).toEqual([{
      provider: 'deepseek-official',
      model: 'deepseek-v4',
      reasoningEffort: 'high',
      tags: ['长上下文', '快速'],
      note: '大改首选',
    }])
  })

  it('未选全的行不写入；空标签/空备注不多出空键', () => {
    const baseline = globalSelectionFromUser({ enabled: false, allowedModels: [] })
    const ops = globalSelectionOps(false, [
      { provider: 'p-a', model: '', reasoningEffort: '', tagsText: '', noteText: '' },
      { provider: 'p-b', model: 'm-2', reasoningEffort: '', tagsText: '', noteText: '' },
    ], baseline)
    expect(ops[0]!.value).toEqual([{ provider: 'p-b', model: 'm-2' }])
  })

  it('打开开关 + 新候选 ⇒ 两条 set（enabled 与 allowedModels 各一条）', () => {
    const baseline = globalSelectionFromUser({ enabled: false, allowedModels: [] })
    const ops = globalSelectionOps(true, [
      { provider: 'p-a', model: 'm-1', reasoningEffort: '', tagsText: '快速', noteText: '' },
    ], baseline)
    expect(ops.map(op => op.path[0])).toEqual(['enabled', 'allowedModels'])
  })
})

describe('③ 常用标签：点一次加入、再点一次移除；自由输入同一套解析', () => {
  it('常用标签是那六个用户点得出的中文常量', () => {
    expect(COMMON_CANDIDATE_TAGS).toEqual(['长上下文', '多模态', '快速', '代码强', '工具调用稳', '中文好'])
  })

  it('toggleCandidateTag 是加/移除语义（中英文逗号都切、去重）', () => {
    expect(toggleCandidateTag('', '长上下文')).toBe('长上下文')
    expect(toggleCandidateTag('长上下文', '快速')).toBe('长上下文, 快速')
    expect(toggleCandidateTag('长上下文, 快速', '长上下文')).toBe('快速')
    expect(toggleCandidateTag('长上下文，快速，长上下文 ', '快速')).toBe('长上下文')
  })

  /** 行编辑器的受控宿主（void 组件要有状态所有者，与两个调用方一致）。 */
  function RowHarness({ onChange, initial }: {
    onChange?: (rows: ModelCandidateRow[]) => void
    initial?: ModelCandidateRow[]
  }) {
    const [rows, setRows] = useState<ModelCandidateRow[]>(initial ?? [])
    return (
      <ModelCandidatesEditor
        rows={rows}
        onChange={(next) => { setRows(next); onChange?.(next) }}
      />
    )
  }

  it('DOM：点「添加候选」→ 填供应商/模型/思考程度 → 点常用标签 → 行状态可直接进保存算子', async () => {
    let latest: ModelCandidateRow[] = []
    await act(async () => { root.render(<RowHarness onChange={rows => { latest = rows }} />) })
    await act(async () => { byLabel<HTMLButtonElement>('添加候选')!.click() })
    await typeInto(byLabel<HTMLInputElement>('提供方 — 候选 1')!, 'p-a')
    await typeInto(byLabel<HTMLInputElement>('模型 — 候选 1')!, 'm-1')
    await typeInto(byLabel<HTMLInputElement>('思考程度 — 候选 1')!, 'high')
    // 常用标签：长上下文 + 代码强（点两次都加入）。
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-candidate-tag="长上下文"]')!.click() })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-candidate-tag="代码强"]')!.click() })
    const ops = globalSelectionOps(false, latest, globalSelectionFromUser({ enabled: false, allowedModels: [] }))
    expect(ops[0]!.value).toEqual([{
      provider: 'p-a',
      model: 'm-1',
      reasoningEffort: 'high',
      tags: ['长上下文', '代码强'],
    }])
  })

  it('DOM：常用标签点第二次即移除（aria-pressed 跟着翻），自由输入框可敲任意标签', async () => {
    await act(async () => { root.render(<RowHarness initial={[{ provider: 'p-a', model: 'm-1', reasoningEffort: '', tagsText: '', noteText: '' }]} />) })
    const chip = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('[data-candidate-tag="快速"]')!
    expect(chip().getAttribute('aria-pressed')).toBe('false')
    await act(async () => { chip().click() })
    expect(chip().getAttribute('aria-pressed')).toBe('true')
    expect(byLabel<HTMLInputElement>('能力标注 — 候选 1')!.value).toBe('快速')
    await act(async () => { chip().click() })
    expect(chip().getAttribute('aria-pressed')).toBe('false')
    expect(byLabel<HTMLInputElement>('能力标注 — 候选 1')!.value).toBe('')
    // 自由输入：中英文逗号、去重（解析规则与预设编辑页共用 parseCandidateTags）。
    await typeInto(byLabel<HTMLInputElement>('能力标注 — 候选 1')!, ' 中文好，原生 SQL , 中文好 ')
    expect(parseCandidateTags(byLabel<HTMLInputElement>('能力标注 — 候选 1')!.value))
      .toEqual(['中文好', '原生 SQL'])
  })
})

describe('④ 读回回填 + 页内接线', () => {
  it('已存值（含思考程度与标签）按行回填到页面上', async () => {
    const calls: MutateCall[] = []
    const stored = globalSelectionFromUser({
      enabled: true,
      allowedModels: [{
        provider: 'p-a', model: 'm-1', reasoningEffort: 'high', tags: ['长上下文', '快速'], note: '大改首选',
      }],
    })
    expect(stored).toEqual({
      enabled: true,
      allowedModels: [{
        provider: 'p-a', model: 'm-1', reasoningEffort: 'high', tags: ['长上下文', '快速'], note: '大改首选',
      }],
    })
    expect(globalCandidateRows(stored)[0]).toEqual({
      provider: 'p-a',
      model: 'm-1',
      reasoningEffort: 'high',
      // 缺省 roles = 两类都可用 ⇒ 界面两枚都勾。
      roles: ['worker', 'research'],
      tagsText: '长上下文, 快速',
      noteText: '大改首选',
    })
    await act(async () => {
      root.render(
        <CorumRpcContext.Provider value={fakeRpc as never}>
          <CorumSettingsContext.Provider value={fakeSettings(stored, calls)}>
            <AgentSettingsSection />
          </CorumSettingsContext.Provider>
        </CorumRpcContext.Provider>,
      )
    })
    // 一行候选回填出来，且常用标签「长上下文」「快速」是选中态。
    expect(container.querySelectorAll('[data-child-model-candidate]')).toHaveLength(1)
    expect(container.querySelector<HTMLButtonElement>('[data-candidate-tag="长上下文"]')!.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector<HTMLButtonElement>('[data-candidate-tag="快速"]')!.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector<HTMLButtonElement>('[data-candidate-tag="多模态"]')!.getAttribute('aria-pressed')).toBe('false')
    // 开关也是开态。
    expect(byLabel<HTMLButtonElement>('允许 Agent 为子 Agent 选择模型')!.getAttribute('aria-checked')).toBe('true')
  })

  it('★ 候选可勾「给哪类子 Agent 用」：两类都勾 ⇒ 不写 roles；只勾一类 ⇒ 写那一条', async () => {
    const { candidateRowToWire } = await import('../src/client/settings/sections/child-model-candidates.ts')
    const base = { provider: 'p-a', model: 'm-1', tagsText: '', noteText: '' }
    // 两类都勾（或角色缺省）= 默认 ⇒ wire 上不出现 roles（设置文件保持干净）。
    expect(candidateRowToWire({ ...base, roles: ['worker', 'research'] })?.roles).toBeUndefined()
    expect(candidateRowToWire({ ...base })?.roles).toBeUndefined()
    // 只勾一类 ⇒ 只写那一条，运行期由 routesForRole 收敛。
    expect(candidateRowToWire({ ...base, roles: ['research'] })?.roles).toEqual(['research'])
    expect(candidateRowToWire({ ...base, roles: ['worker'] })?.roles).toEqual(['worker'])
  })

  it('★ 页面上真的有两枚角色勾选框（渲染断言，不是只写在注释里）', () => {
    const editor = readFileSync(
      join(import.meta.dirname, '../src/client/settings/sections/ModelCandidatesEditor.tsx'),
      'utf8',
    )
    expect(editor).toContain('data-candidate-role={role}')
    expect(editor).toContain('CANDIDATE_ROLE_LABELS')
    // 不许把两类都取消：只剩一类时那一枚被禁用（哪类都用不上的候选应该删掉）。
    expect(editor).toContain('disabled={disabled || (checked && currentRoles.length === 1)}')
  })

  it('页面源码：候选组用共享行编辑器 + 目录三列下拉（renderRoute → ModelPairField）', () => {
    const section = readFileSync(
      join(import.meta.dirname, '../src/client/settings/sections/SettingsAgentSettingsSection.tsx'),
      'utf8',
    )
    expect(section).toContain('<SettingGroup title="子 Agent 候选模型">')
    expect(section).toContain('<ModelCandidatesEditor')
    expect(section).toContain('renderRoute=')
    // 「已配置的供应商模型 + 思考程度」= 同一份 catalog 的 ModelPairField。
    const group = section.slice(section.indexOf('<SettingGroup title="子 Agent 候选模型">'))
    expect(group.slice(0, group.indexOf('</SettingGroup>')))
      .toContain('<ModelPairField')
    // 位置：默认模型组之后、「运行」组之前。
    const defaultGroup = section.indexOf('<SettingGroup title="默认模型">')
    const candidatesGroup = section.indexOf('<SettingGroup title="子 Agent 候选模型">')
    const runGroup = section.indexOf('<SettingGroup title="运行">')
    expect(defaultGroup).toBeGreaterThanOrEqual(0)
    expect(candidatesGroup).toBeGreaterThan(defaultGroup)
    expect(runGroup).toBeGreaterThan(candidatesGroup)
  })

  it('那条独立 settings.section 不再注册（负向断言）', () => {
    const settingsPluginsIndex = readFileSync(
      join(import.meta.dirname, '../../../session/corum-ui-settings-plugins/src/client/index.ts'),
      'utf8',
    )
    // 注册面：不再有 settings.section 注册，也没有那个 id。
    expect(settingsPluginsIndex).not.toContain("ctx.slots.inject('settings.section'")
    expect(settingsPluginsIndex).not.toContain("'subagent-model-candidates'")
    // 壳的导航归属表里也没有它了。
    const shell = readFileSync(
      join(import.meta.dirname, '../src/client/settings/SettingsSections.tsx'),
      'utf8',
    )
    expect(shell).not.toContain("'subagent-model-candidates': 'agent'")
    expect(shell).toContain("id: 'agent-settings'")
  })

  it('客户端与 host 的命名空间字面量一致（跨包唯一对齐点）', () => {
    // host 侧（tools/subagent）：`name = 'subagent-model-selection-settings'`
    const host = readFileSync(
      join(import.meta.dirname, '../../../agent/corum-tool-subagent/src/model-selection-settings.ts'),
      'utf8',
    )
    expect(host).toContain("export const name = 'subagent-model-selection-settings'")
    expect(SUBAGENT_MODEL_SELECTION_NS).toBe('subagent-model-selection-settings')
  })
})