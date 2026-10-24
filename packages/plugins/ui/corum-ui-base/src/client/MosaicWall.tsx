/**
 * 磁贴墙（Mosaic）React 组件 —— 集成中心三个内容页共用的展示骨架。
 * 算法在 `./mosaic.ts`、几何在 `./mosaic.module.css`；本文件把两者接成组件。
 *
 * ## 为什么抽出来
 *
 * 插件 / MCP / 技能三页原本各持一份「块生成器 + 排布 CSS + 磁贴本体 + 详情面板」
 * 的副本（跨包 CSS module 不能直接 import 的历史约束）。三份副本必然分叉，实测
 * 已经分叉过：插件页列宽走 `[data-col]` 属性选择器、另两页走 `.mosaicCol264`
 * 类名，且后者漏了块行的 `width: 100%` ⇒ MCP 页的每张贴被拉成整行 808×128，
 * 完全不是磁贴。收敛到本模块后只有一个几何实现。
 *
 * ## 用法
 *
 * ```tsx
 * const blocks = buildMosaic(items.length)      // 或 flattenMosaic 取尺寸序列
 * <MosaicWall items={items} blocks={blocks} renderTile={(item, size, i) => ...} />
 * ```
 *
 * @module corum-ui-base/client/Mosaic
 */
import { Fragment, useEffect, useState, type MutableRefObject, type ReactNode } from 'react'
import css from './mosaic.module.css'
import { pickMosaicColumns } from './mosaic.ts'
import type { MosaicBlock, MosaicColumns, MosaicSize } from './mosaic.ts'

/**
 * 磁贴底色档位（token 见 theme.css）。
 *
 * 2026-10-24 从 4 档扩到 9 档：用户反馈「配色太单一」。档位按色相命名，
 * 不绑定语义；具体用哪档由 `tintForName` 按名字稳定散列，保证同一项每次
 * 渲染同色、相邻项不同色。
 */
export const MOSAIC_TINTS = [
  'violet', 'blue', 'emerald', 'amber', 'rose', 'cyan', 'mauve', 'deep', 'slate',
] as const

/** 磁贴底色档位类型。 */
export type MosaicTint = (typeof MOSAIC_TINTS)[number]

/** 档位 → 样式类名（消费方按语义挑档，不再自己拼类名）。 */
const TINT_CLASS: Readonly<Record<MosaicTint, string>> = {
  violet: css.tileTintViolet,
  blue: css.tileTintBlue,
  emerald: css.tileTintEmerald,
  amber: css.tileTintAmber,
  rose: css.tileTintRose,
  cyan: css.tileTintCyan,
  mauve: css.tileTintMauve,
  deep: css.tileTintDeep,
  slate: css.tileTintSlate,
}

/**
 * 按名字稳定取一个磁贴底色档（FNV-1a 散列）。
 *
 * 用途：列表页的磁贴不再「一律紫」，但也不能每次渲染变来变去——名字相同 ⇒
 * 颜色相同；不同项按色相轮转。语义色（类型徽标、选中态）仍由调用方单独控制。
 *
 * @param name - 稳定标识（包名 / 服务器名 / 技能名 / 扩展包 id）。
 * @returns 9 档之一。
 */
export function tintForName(name: string): MosaicTint {
  let hash = 0x811c9dc5
  for (const ch of name.toLowerCase()) {
    hash ^= ch.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return MOSAIC_TINTS[(hash >>> 0) % MOSAIC_TINTS.length]!
}

/**
 * 贴内骨架的 props：**一份结构、四种布局**。
 *
 * 形状由外层贴的 `data-tile-size` 决定（CSS 按它切 `flex-direction` 与行数），
 * 故这里不需要 `size` 参数 —— 消费方把骨架放进已带 `data-tile-size` 的贴里即可。
 *
 * 各形状的取舍（用户 2026-10-02 定调）：
 * - `big`：图标居左上 → 名称（最多 3 行）→ 作者；
 * - `wide`：图文**并排**（图标左、文字右）；
 * - `tall`：纵向 → 名称 → 作者沉底；
 * - `small`：图标 + 名称。
 *
 * **卡片上不渲染简介**（用户 2026-10-02 定调）：简介只在右侧详情面板呈现。
 * 故本组件没有 `desc` prop —— 原先按贴高隐藏简介的容器查询会让同一张卡片在不同
 * 窗口尺寸下时有时无（用户实测报障），移除后该分支不复存在。
 */
export interface MosaicTileBodyProps {
  /** 图标（消费方按形状自定尺寸；骨架只负责落位）。 */
  readonly icon: ReactNode
  /** 名称（必给）。 */
  readonly name: ReactNode
  /** 版本徽章；省略则不渲染。窄贴会被容器查询自动隐去。 */
  readonly version?: ReactNode
  /** 底部小字（作者 / 地址等）；省略则不渲染。 */
  readonly sub?: ReactNode
  /** 右上角角标（热度 / 状态点 / 开关）；绝对定位，不参与排版。 */
  readonly corner?: ReactNode
}

/**
 * 按形状分档的贴内骨架。
 *
 * @param props - 见 {@link MosaicTileBodyProps}。
 * @returns 贴内结构（外层应是一个带 `data-tile-size` 的磁贴元素）。
 */
export function MosaicTileBody({ icon, name, version, sub, corner }: MosaicTileBodyProps): ReactNode {
  return (
    <>
      {corner}
      <div className={css.tileBodyScaffold}>
        <span className={css.tileIcon}>{icon}</span>
        <div className={`${css.tileBottom} ${css.tileBodyText}`}>
          <div className={css.tileNameRow}>
            <span className={css.tileName}>{name}</span>
            {version !== undefined && <span className={css.tileVersion}>{version}</span>}
          </div>
          {sub !== undefined && <span className={css.tileSub}>{sub}</span>}
        </div>
      </div>
    </>
  )
}

/** 磁贴墙：把块序列渲染成块行 + 列 + 贴。 */
export interface MosaicWallProps<T> {
  /** 贴的数据源（按渲染顺序，与 {@link flattenMosaic} 的顺序一致）。 */
  readonly items: readonly T[]
  /** 块序列（`buildMosaic` 的输出）。 */
  readonly blocks: readonly MosaicBlock[]
  /**
   * 列数模式（与传给 `buildMosaic` 的 `columns` 一致）。
   *
   * 必须传：单位宽算式随列数切换（6 列 `(W−5g)/6` / 3 列 `(W−2g)/3`），CSS 靠这个
   * 属性选式子。不传则 3 列下三列宽和小于块宽、右缘留白（实测 522 vs 538）。
   */
  readonly columns?: MosaicColumns
  /**
   * 渲染单张贴。
   * @param item - 对应位置的数据。
   * @param size - 该位置应使用的尺寸档（已由算法决定，消费方按它调字号/图标）。
   * @param index - 在整面墙里的序号（0 起；入口贴通常在第 0 位）。
   */
  readonly renderTile: (item: T, size: MosaicSize, index: number) => ReactNode
}

/**
 * 磁贴墙（块行 → 列 → 贴）。
 *
 * @param props - 见 {@link MosaicWallProps}。
 * @returns 磁贴墙元素。
 */
export function MosaicWall<T>({ items, blocks, columns = 6, renderTile }: MosaicWallProps<T>): ReactNode {
  return (
    <div className={css.tileGrid} data-mosaic-columns={columns}>
      {blocks.map((block, bi) => (
        <div key={`block:${bi}`} className={css.mosaicBlock} data-mosaic-block={block.kind}>
          {block.cols.map((col, ci) => (
            <div key={`col:${bi}:${ci}`} className={css.mosaicCol} data-col={col.width}>
              {col.sizes.map((size, si) => {
                /* 数据下标由算法给出（长名字会跨位置挑选，落位不再等于渲染序），
                   无槽位信息时退回「按序取」以兼容只给 sizes 的简单用法。 */
                const index = col.slots?.[si]?.itemIndex ?? si
                const item = items[index]
                if (item === undefined) return null
                return (
                  <Fragment key={`tile:${bi}:${ci}:${si}`}>
                    {renderTile(item, size, index)}
                  </Fragment>
                )
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * 取某一张贴该挂的属性（消费方展开到自己的 `<button>` 上）。
 *
 * 贴必须是列的**直接子元素**（CSS 靠 `.mosaicCol > [data-tile-size]` 分档列高），
 * 故这里不包壳层元素，只把类名与 data 属性交给消费方。
 *
 * @param props - 见 {@link MosaicTileProps}。
 * @returns 可展开的属性对象。
 */
export function mosaicTileAttrs(props: MosaicTileProps): {
  className: string
  'data-tile-size': MosaicSize
} {
  return {
    className: mosaicTileClass(props),
    'data-tile-size': props.size,
  }
}

/** 磁贴按钮的属性集（消费方直接展开到自己的 `<button>`/`<div>` 上）。 */
export interface MosaicTileProps {
  /** 尺寸档（算法给的，决定字号/图标/是否独占列高）。 */
  readonly size: MosaicSize
  /** 底色档。 */
  readonly tint: MosaicTint
  /** 是否选中（进详情面板的那一张）。 */
  readonly active?: boolean
  /** 是否加品牌色 glow（大贴/主推）。 */
  readonly glow?: boolean
  /** 额外类名。 */
  readonly className?: string
}

/** 拼磁贴的类名（`size` 走 data 属性，其余走类名）。 */
export function mosaicTileClass({ tint, active, glow, className }: MosaicTileProps): string {
  return [
    css.tile,
    TINT_CLASS[tint],
    active === true ? css.tileActive : '',
    glow === true ? css.tileGlow : '',
    className ?? '',
  ].filter(Boolean).join(' ')
}

/** 共享样式表的窄化面（消费方拼自己的结构时按需取这些类名）。 */
export interface MosaicStyleSheet {
  readonly tileGrid: string
  readonly mosaicBlock: string
  readonly mosaicCol: string
  readonly tile: string
  readonly tileTop: string
  readonly tileBodyScaffold: string
  readonly tileBodyText: string
  readonly tileIcon: string
  readonly tileCorner: string
  readonly tileBottom: string
  readonly tileNameRow: string
  readonly tileName: string
  readonly tileVersion: string
  readonly tileSub: string
  readonly tileDot: string
  readonly tileDotOff: string
  readonly tileSwitch: string
  readonly tileSwitchKnob: string
  readonly tilePlaceholder: string
  readonly tilePlaceholderIcon: string
  readonly tilePlaceholderText: string
  readonly hotRow: string
}

/**
 * 共享样式表：三个页面拼贴内结构（图标行 / 名称行 / 小字…）时取这里的类名，
 * 不再各持一份 CSS。返回的是本模块自己 import 的那份 CSS module 对象。
 */
export const mosaicStyles: MosaicStyleSheet = {
  tileGrid: css.tileGrid,
  mosaicBlock: css.mosaicBlock,
  mosaicCol: css.mosaicCol,
  tile: css.tile,
  tileTop: css.tileTop,
  tileBodyScaffold: css.tileBodyScaffold,
  tileBodyText: css.tileBodyText,
  tileIcon: css.tileIcon,
  tileCorner: css.tileCorner,
  tileBottom: css.tileBottom,
  tileNameRow: css.tileNameRow,
  tileName: css.tileName,
  tileVersion: css.tileVersion,
  tileSub: css.tileSub,
  tileDot: css.tileDot,
  tileDotOff: css.tileDotOff,
  tileSwitch: css.tileSwitch,
  tileSwitchKnob: css.tileSwitchKnob,
  tilePlaceholder: css.tilePlaceholder,
  tilePlaceholderIcon: css.tilePlaceholderIcon,
  tilePlaceholderText: css.tilePlaceholderText,
  hotRow: css.hotRow,
}

export { mosaicStyles as css }

/**
 * 按容器宽决定列数，并在窗口变化时更新（窄窗降 3 列、宽窗回 6 列）。
 *
 * 为什么需要它：6 列在窄窗下单位宽会掉到 80px 出头，长名字必然截断；降成 3 列后
 * 每列宽约翻倍（同一容器宽摊到更少的列上），名称与作者都能正常显示。两种模式的
 * 块宽**恒等**（6u+5g），故切换只改块内列结构、不改变整墙宽度。
 *
 * @param ref - 磁贴群容器（量其内容宽；`ResizeObserver` 监听尺寸变化）。
 * @returns 当前应使用的列数。
 */
export function useMosaicColumns(ref: MutableRefObject<HTMLElement | null>): MosaicColumns {
  const [columns, setColumns] = useState<MosaicColumns>(6)
  useEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      const style = getComputedStyle(el)
      const gap = Number.parseFloat(style.gap) || 8
      /* scrollbar-gutter 预留的滚动槽也计入 clientWidth，扣掉才是真正的列可用宽。 */
      const contentWidth = el.clientWidth - (el.offsetWidth - el.clientWidth)
      setColumns(pickMosaicColumns(contentWidth, gap))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [ref])
  return columns
}
