/**
 * ModelAskPanel —— 子 Agent 模型不可用的决定面板（design.pen jO5So「方案C」）。
 *
 * 两态就地切换，**不跳转、不弹模态**：
 *   ① 收起态 notify-bar：unplug 图标 + 两行文案 + 「处理」+ ×（挂起）
 *   ② 展开态 panel-expanded：phead(unplug + 标题 + chevron-up)
 *      → chips（四档位）→ picker(cpu + 文案 + chevron-down) → pfoot(hint + 应用并继续)
 *
 * 与提问卡（QuestionCard）的关键差别：**一轮完成**。官方提问流要两轮问答（先问处理方式，
 * 选「永久改为指定模型」再弹第二轮模型选择），方案 C 把模型选择内嵌进同一个面板。
 *
 * 图标名逐项取自设计稿的 `icon` 属性（lucide 库）：unplug / zap / link / repeat / ban /
 * cpu / chevron-up / chevron-down / x —— 不按语义猜（猜会得到 AlertTriangle、Check 这类
 * 形状对不上的图标）。档位文案由 host 下发（`request.options`），本组件不硬编码。
 */
import { useState } from 'react'
import {
  Ban,
  ChevronDown,
  ChevronUp,
  Cpu,
  Link as LinkIcon,
  Repeat,
  Unplug,
  X,
  Zap,
} from 'lucide-react'
import {
  modelAskAnswerOf,
  modelAskNeedsRoute,
  type ModelAskCatalogProvider,
  type ModelAskKind,
  type PendingModelAsk,
} from './contract.ts'
import css from './ModelAskPanel.module.css'

export interface ModelAskPanelProps {
  pending: PendingModelAsk
}

/** 选中的路由（内嵌模型选择的内部状态）。 */
interface PickedRoute {
  provider: string
  model: string
  label: string
}

/**
 * 档位图标（**设计稿逐项指定**，不是按语义猜）。
 *
 * 为什么写死映射而不是用「看起来像」的图标：设计稿给的是 lucide 具体名
 * （zap / link / repeat / ban），按语义猜会得到形状完全不同的图标
 * （曾用 Check / ChevronRight / X，与设计稿对不上）。
 */
const CHIP_ICON: Readonly<Record<ModelAskKind, typeof Zap>> = {
  'temporary': Zap,
  'permanent-follow': LinkIcon,
  'permanent-route': Repeat,
  'retry': Repeat,
  'decline': Ban,
}

/**
 * 内嵌模型选择：**默认整块隐藏，选中「永久改指定模型」时才出现**。
 *
 * 判据是设计稿该行 lbl 的原文：「指定模型：**选『永久改指定模型』时展开选择**」——
 * 「展开选择」的主语是这一整块（行 + 列表），不是只有列表。
 *
 * ⚠️ 2026-09-19 用户实测纠正：此前实现成「行恒显示、只有列表按需展开」，且把那行做成
 * 不可点的 div。用户看到的是一行带箭头的下拉却点不动 —— 「下拉仍然存在，并且是不可选中
 * 状态，默认应该隐藏才对」。两个错都要修：**默认不渲染**（不是渲染成禁用样），出现时
 * 是一个真正可交互的控件。
 */
function ModelPicker({ catalog, picked, open, listOpen, onToggle, onPick }: {
  catalog: readonly ModelAskCatalogProvider[]
  picked: PickedRoute | undefined
  /** 是否显示（= 选中了「永久改指定模型」）。false 时**整块不渲染**。 */
  open: boolean
  /** 模型列表是否展开（行右侧小箭头控制）。 */
  listOpen: boolean
  /** 收起/展开模型列表。 */
  onToggle: () => void
  onPick: (route: PickedRoute) => void
}) {
  if (!open) return null
  return (
    <>
      {/* 行本身是容器而非按钮（嵌套 button 是非法 HTML，本仓已为此付过学费：
          见 dev-conventions §13.5「row 不能是 button 如果它还要自己的按钮」）。
          收起动作放在右侧独立的小按钮上。 */}
      <div className={css.picker}>
        <span className={css.pickerGlyph}><Cpu size={11} /></span>
        <span className={css.pickerLabel}>
          {picked === undefined
            ? '选择本次使用的模型（包含主 Agent 模型）'
            : `${picked.label}（${picked.provider}/${picked.model}）`}
        </span>
        <button
          type="button"
          className={css.pickerToggle}
          aria-label={listOpen ? "收起模型列表" : "展开模型列表"}
          onClick={onToggle}
        >
          {listOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
      </div>
      {listOpen && <div className={css.pickerList}>
        {catalog.length === 0 && <div className={css.pickerEmpty}>没有可用的模型</div>}
        {catalog.map(provider => (
          <div key={provider.provider}>
            <div className={css.pickerGroup}>{provider.label}</div>
            {provider.models.map(model => {
              const active = picked?.provider === provider.provider && picked?.model === model.model
              return (
                <button
                  key={`${provider.provider}/${model.model}`}
                  type="button"
                  className={active ? `${css.pickerRow} ${css.pickerRowActive}` : css.pickerRow}
                  onClick={() => onPick({
                    provider: provider.provider,
                    model: model.model,
                    label: `${provider.label} / ${model.label}`,
                  })}
                >
                  <span className={css.pickerModel}>{model.label}</span>
                </button>
              )
            })}
          </div>
        ))}
      </div>}
    </>
  )
}

/**
 * 决定面板。
 * @param props - 待决定项。
 */
export function ModelAskPanel({ pending }: ModelAskPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [kind, setKind] = useState<ModelAskKind | undefined>(undefined)
  const [picked, setPicked] = useState<PickedRoute | undefined>(undefined)
  // 模型列表的展开态。**每次换档位都重置为展开**：选中「永久改指定模型」的目的就是挑模型，
  // 再让用户多点一次「展开」是多余的一步；用户在列表里收起来后换回来才保留其选择。
  const [listOpen, setListOpen] = useState(true)
  const [applying, setApplying] = useState(false)
  const { request } = pending

  const needsRoute = modelAskNeedsRoute(kind)
  // 「永久改指定模型」必须真的选了一个模型才能应用（否则回传 dismissed = 什么都没变，
  // 却让用户以为已经处理好了）。
  const canApply = kind !== undefined && (!needsRoute || picked !== undefined) && !applying
  /** 选档位：换档时把模型列表重置为展开（见 listOpen 的说明）。 */
  const chooseKind = (next: ModelAskKind): void => {
    if (next !== kind) setListOpen(true)
    setKind(next)
  }

  const apply = (): void => {
    if (!canApply) return
    setApplying(true)
    void pending.answer(modelAskAnswerOf(kind, picked === undefined
      ? undefined
      : { provider: picked.provider, model: picked.model })).catch(() => {
      // 回传失败（pending 已被结算/已失效）⇒ **必须把按钮放开**。否则 `applying` 停在
      // true、按钮永久 disabled，用户被卡在一个点不动的面板里（J+K 的第二个失败形态：
      // `void promise` 把 rejection 吞掉，界面上看不到任何异常，只表现为「应用中…」）。
      setApplying(false)
    })
  }

  if (!expanded) {
    return (
      <div className={css.shell}>
        <div className={css.bar} role="status">
          <span className={css.barIcon}><Unplug size={14} /></span>
          <span className={css.barTx}>
            <span className={css.barTitle}>子 Agent 模型不可用 · 任务已暂停</span>
            <span className={css.barDesc}>{request.label} · {request.cause}</span>
          </span>
          <button type="button" className={css.handleBtn} onClick={() => setExpanded(true)}>处理</button>
          <button
            type="button"
            className={css.iconBtn}
            title="稍后处理"
            aria-label="稍后处理"
            onClick={() => { void pending.dismiss() }}
          >
            <X size={12} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={css.shell}>
      <div className={css.panel} role="dialog" aria-label="模型不可用，选择处理方式">
        <div className={css.phead}>
          <span className={css.pheadIcon}><Unplug size={15} /></span>
          <span className={css.pheadTx}>模型不可用，选择处理方式</span>
          <button
            type="button"
            className={css.pheadChev}
            aria-label="收起"
            onClick={() => setExpanded(false)}
          >
            <ChevronUp size={14} />
          </button>
        </div>

        <div className={css.chips}>
          {request.options.map(option => {
            const Icon = CHIP_ICON[option.kind]
            const active = kind === option.kind
            return (
              <button
                key={option.kind}
                type="button"
                className={active ? `${css.chip} ${css.chipActive}` : css.chip}
                title={option.description}
                onClick={() => chooseKind(option.kind)}
              >
                <span className={css.chipIcon}><Icon size={11} /></span>
                {option.label}
              </button>
            )
          })}
        </div>

        {/* picker 整块**默认不渲染**，只在选中「永久改指定模型」时出现
            （2026-09-19 用户实测纠正：此前做成「恒显示的不可点下拉」，用户看到一行
            带箭头却点不动的控件）。 */}
        <ModelPicker
          catalog={[
            { provider: request.fallback.provider, label: '主 Agent 模型', models: [{ model: request.fallback.model, label: request.fallback.model }] },
            ...request.catalog.map(provider => ({ ...provider, models: provider.models.filter(model => provider.provider !== request.fallback.provider || model.model !== request.fallback.model) })).filter(provider => provider.models.length > 0),
          ]}
          picked={picked}
          open={needsRoute}
          listOpen={listOpen}
          onToggle={() => setListOpen(v => !v)}
          onPick={setPicked}
        />

        <div className={css.pfoot}>
          <span className={css.footHint}>挂起后可从子 Agent 卡片随时恢复处理</span>
          <button type="button" className={css.applyBtn} disabled={!canApply} onClick={apply}>
            {applying ? '应用中…' : kind === 'decline' ? '取消委派' : kind === 'retry' ? '重试' : '应用并继续'}
          </button>
        </div>
      </div>
    </div>
  )
}
