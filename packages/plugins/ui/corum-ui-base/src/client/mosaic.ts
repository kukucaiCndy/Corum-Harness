/**
 * 磁贴墙排布算法（Mosaic）—— 集成中心三个内容页（插件 / MCP / 技能）共用的
 * 「错落有致」块生成器。**这是排布算法的单一事实源**：三个页面不再各持一份副本
 * （副本分叉过一次，见文件末「为什么抽出来」）。
 *
 * ## 几何（design.pen 四帧逐帧读实）
 *
 * 设计稿的磁贴墙**不是 CSS grid**，而是「若干等宽 808 的块」上下堆叠；每块内部
 * 一行 flex、各列等高。块只有两种高度：
 *
 * - **高 264 的块**：四列，宽度是 `[264,264,128,128]` 的某个排列。
 *   264 宽列装「一张大贴」或「两条宽贴竖叠」；128 宽列装「一张高贴」或
 *   「两条小贴竖叠」。宽度校验：264+8+264+8+128+8+128 = **808** ✓
 * - **高 128 的块**：列宽模式三选一，均为 808：
 *   `[128×6]` = 768+40 / `[264,128×4]` = 776+32 / `[264,264,128×2]` = 784+24。
 *
 * 列宽 128 与「两条小贴竖叠」的关系：128+8+128 = 264，故 128 宽的列与 264 宽的
 * 列在纵向能装下同样多的贴，两种块的列高都自洽。
 *
 * ## 为什么是「固定种子伪随机」而不是逐块手写
 *
 * 设计稿每帧只画两行，谈不上覆盖真实数据量（插件市场可能几十条）。排布若按
 * 固定序号循环，每块会排得一模一样——用户反馈「当前这种每一列都一种排列方式
 * 是不好看的」。故逐块抽型：**种子为常量 ⇒ 同一份数据每次渲染完全一致**（可
 * 复现、可对账），同时块与块之间形态不同，呈现错落。
 *
 * 曾经的做法是 `display:grid; grid-auto-flow:dense` + 固定序号循环，实测空洞率
 * 6.3%（大贴跨两行时自动放置填不满）且每块同形；改块生成器后整块恰好铺满。
 *
 * @module corum-ui-base/client/mosaic
 */

/** 磁贴尺寸档（与 design.pen 的 264×264 / 264×128 / 128×264 / 128×128 对应）。 */
export type MosaicSize = 'big' | 'wide' | 'tall' | 'small'

/** 块高度档：264 块装大/高贴，128 块装宽/小贴。 */
export type MosaicBlockKind = '264' | '128'

/**
 * 列数模式：6 = 设计稿的细粒度排布（128 基准）；3 = 窄窗降列（264 基准）。
 *
 * 两种模式的块宽**恒等**，故单位宽公式无需分叉：
 *   6 列行 = 2×(2u+g) + 2×u + 3g = 6u+5g
 *   3 列行 = 3×(2u+g) + 2g     = 6u+5g
 * 降列的意义是把同一容器宽摊到更少的列上——实测 546px 容器下 6 列的单位宽只有
 * 83px（名称放不下），降成 3 列后每列 174px，名称与作者都能正常显示。
 */
export type MosaicColumns = 6 | 3

/**
 * 固定种子：**换掉它就换一整套图案**，同一份数据下恒定。
 * 取值本身无深意（任意常量），只承担「可复现」这一个职责。
 */
export const MOSAIC_SEED = 0x5a17

/**
 * 相邻块同型时的重抽上限。几何上两型等概率，5 次仍同型就直接取相
 * 反型——保证「相邻不同型」这条硬约束不会因随机而破。
 */
const BLOCK_RETYPE_MAX = 5

/**
 * 块内一张贴的槽位：尺寸档 + 它承载哪一条数据。
 *
 * `itemIndex` 由算法显式给出，而不是「按顺序数下去」：把长名字安排到 264 宽的
 * 槽需要**跨位置挑选数据**，落位不再是「第 i 张贴 = 第 i 条数据」，故每张槽位都
 * 记下自己的数据下标（{@link MosaicWall} 按它取数据）。
 */
export interface MosaicSlot {
  readonly size: MosaicSize
  /** 承载的数据下标；形状计划完成后由算法填写（长名字会与短名字成对交换）。 */
  itemIndex: number
}

/** 块内一列：宽度档 + 该列自上而下的贴槽位。 */
export interface MosaicCol {
  /** 列宽（px，未乘密度缩放）：264 或 128。 */
  readonly width: 264 | 128
  /** 该列的贴尺寸序列（自上而下 1~2 张）；分配数据后为可变数组。 */
  readonly sizes: MosaicSize[]
  /** 分配数据后填入的槽位（与 {@link sizes} 同长同序）。 */
  slots?: MosaicSlot[]
}

/** 一个块行：高度档 + 列序列。 */
export interface MosaicBlock {
  readonly kind: MosaicBlockKind
  readonly cols: readonly MosaicCol[]
}

/** mulberry32：小而稳定的 32 位 PRNG（纯函数式状态推进，无外部依赖）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates 洗牌（消费同一 PRNG，保证整条序列可复现）。 */
function shuffled<T>(rng: () => number, items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}


/**
 * 名字档：算法用它在槽位之间做取舍（长名字优先给 264 宽的列）。
 */
/** 一条数据的排布提示。 */
export interface MosaicItemHint {
  /** 展示名的字符数（调用方按**实际用于渲染**的那个名字算）。 */
  readonly nameLength: number
  /** 是否有描述（有描述的长名才值得给大贴，换来额外高度放描述）。 */
  readonly hasDescription?: boolean
}

/** 名字「偏长」的阈值：达到即优先安排进 264 宽的列（宽贴或大贴）。 */
const LONG_NAME_LENGTH = 18

/** 名字「很长」的阈值：配合描述可给大贴（264×264），拿到额外高度显示描述。 */
const VERY_LONG_NAME_LENGTH = 22

/** 6 列模式的块几何：四列宽 `[264,264,128,128]` 的某个排列（6u+5g）。 */
const WIDTHS_6COL = [264, 264, 128, 128] as const

/**
 * 3 列模式的块几何：三列固定 264 宽（3×(2u+g)+2g = 6u+5g，与 6 列块等宽）。
 * 窄窗降列时用——同一容器宽摊到 3 列上，每列宽约翻倍，长名字才放得下。
 */
const WIDTHS_3COL = [264, 264, 264] as const

/**
 * 3 列模式下的第二种列宽模式：`[128,128,264,264]`（1+1+2+2 单位）。
 *
 * 为什么 3 列模式还需要它：**`tall`（竖直矩形 128×264）只能长在 128 宽的列上**，
 * 而 3 列的唯一合法宽度组合是 `264+264+264`（数学上 2+2+2 是 `6u+5g` 的唯一解）
 * —— 全是 264 宽的列 ⇒ 3 列下结构上生不出竖直矩形（实测形状分布只有 big/wide）。
 * 引入这个 4 列模式后，3 列模式也能排出「竖直矩形 + 大正方形」并存的形态。
 * 宽度校验：128+8+128+8+264+8+264 = 808 = 6u+5g ✓（与 3 列块等宽）
 */
const WIDTHS_3COL_TALL = [128, 128, 264, 264] as const

/**
 * 一个块内的**形状配额**：每种形状各出几张。
 *
 * 这是「美观」的第二维——原来只按名字长度决定宽窄（长名给 264 列），结果 264 列
 * 一律退化成「两条宽贴」，整片墙只剩长方形、大正方形消失（实测 wide:17 / big:1）。
 * 现在改为**先给每个块定一份形状配方**（大正方形几张、竖直矩形几张、宽贴几张、
 * 小贴几张），再由位置去消费配额：长名字仍然优先占宽槽，但**形状本身不再由名字
 * 长度决定**——短名字也会轮到正方形与竖直矩形。
 */
export interface BlockShapePlan {
  /** 大贴（264×264，正方形）。 */
  readonly big: number
  /** 宽贴（264×128，横向长方形）。 */
  readonly wide: number
  /** 高贴（128×264，竖直矩形）。 */
  readonly tall: number
  /** 小贴（128×128）。 */
  readonly small: number
}

/**
 * 为第 `blockIndex` 个块生成形状配方。
 *
 * 设计意图（用户 2026-10-01：「不要只按照名字长度来进行，短名字也可以有大正方形、
 * 竖直的矩形，要增加一个维度，适当调节卡片的排列看上去更加有美感」）：
 * - **每块至少一张大正方形**（264 块的锚点），保证无论数据怎么排都有正方形；
 * - **每个 264 块至少一张竖直矩形**（128×264），让「竖着的长方形」稳定出现；
 * - 其余槽位按一个**轮转配方表**分配，使相邻块的形状组合不同（错落）；
 * - 配方按块序号轮转（不是随机），故同一份数据每次渲染一致、可复现对账。
 *
 * @param blockIndex - 第几个块（0 起）。
 * @returns 该块的形状配额。
 */
export function planBlockShape(blockIndex: number, rng?: () => number): BlockShapePlan {
  /* 有 rng 时**逐块随机配方**（2026-10-24 用户要「排列无规律」）：不再按
     blockIndex 轮转固定四配方——那会让整墙呈现可辨认的重复节奏。
     约束：至少 1 张大贴（视觉锚点）；其余配额随机，骨架消费不完就忽略。 */
  if (rng !== undefined) {
    /* 关键：**大贴不再每块都有**（2026-10-24 用户报「必然有一排正方形」）。
       旧配方 big 恒 ≥1 ⇒ 每个 264 块必出正方形，整墙出现固定节奏。
       现在 35% 概率给 0 张大贴；此时至少给 1 张高贴，满足骨架的
       「非全竖叠」约束（否则 buildColSkeleton 会重抽并退回设计稿首帧，
       反而又把正方形带回来）。 */
    const big = rng() < 0.65 ? (rng() < 0.2 ? 2 : 1) : 0
    const tall = rng() < 0.55 ? (rng() < 0.5 ? 1 : 2) : 0
    return {
      big,
      wide: 1 + Math.floor(rng() * 3),
      tall: big === 0 && tall === 0 ? 1 : tall,
      small: Math.floor(rng() * 2),
    }
  }
  /* 无 rng 的旧路径：轮转配方（保留给确定性调用/测试）。 */
  const RECIPES: readonly BlockShapePlan[] = [
    { big: 1, wide: 1, tall: 1, small: 0 },
    { big: 1, wide: 2, tall: 1, small: 1 },
    { big: 1, wide: 1, tall: 1, small: 0 },
    { big: 1, wide: 1, tall: 1, small: 1 },
  ]
  return RECIPES[blockIndex % RECIPES.length]!
}

/**
 * 生成一个高 264 的块的**列骨架**（只决定列宽排列与每列的贴数，不含数据）。
 *
 * 264 宽列可装「一张大贴」或「两条宽贴竖叠」；128 宽列可装「一张高贴」或
 * 「两条小贴竖叠」。约束：至少一张大贴（视觉锚点）、264 列不得全为双宽、
 * 128 列不得全为双小，违反重抽；耗尽后退到设计稿首帧排法。
 *
 * @param rng - 该次渲染的 PRNG。
 * @param mode - 列数模式（6 或 3）。
 * @param pinFirstTwoSmalls - 首列钉成「两条小贴竖叠」：集成中心的入口贴
 *   （添加服务器 / 添加技能等）固定落在左上角第一张，故需要这枚钉子。
 */
export function buildColSkeleton(
  rng: () => number,
  mode: MosaicColumns = 6,
  pinFirstTwoSmalls = false,
  shape: BlockShapePlan = { big: 0, wide: 0, tall: 0, small: 0 },
): MosaicCol[] {
  /* 3 列模式用 `[128,128,264,264]`（4 列、6 单位）——它是 3 列模式里唯一**同时**
     能长出 `tall`（竖直矩形，需 128 列）与容纳入口小贴的形态；纯 `[264,264,264]`
     三列只能出 big/wide，且首个槽位放不下小贴（264 列最小单元就是一张宽贴）。
     6 列模式用 `WIDTHS_6COL`。两者块宽恒等（6 单位 + 5 间隙）。 */
  const base = mode === 3 ? WIDTHS_3COL_TALL : WIDTHS_6COL
  for (let attempt = 0; attempt < BLOCK_RETYPE_MAX; attempt++) {
    const widths = [...shuffled(rng, base)]
    /* 入口贴钉在左上角。**必须换「同单位」的列，不能直接改首列宽**：
       块宽恒等式是「单位数 = 6」（128 列 = 1 单位、264 列 = 2 单位）—— 把 2 单位的
       首列改成 1 单位，整块就少 1 单位（实测钉后列宽 [128,128,128,264] 只剩 672、
       应为 808）；给 3 列硬塞一个 128 列则会多出列数（实测 [264,264,264,128] 涨到
       944）。故这里**只对调、不改值**，把首列换成同模式里已存在的 128 列。 */
    if (pinFirstTwoSmalls) {
      const j = widths.findIndex(w => w === 128)
      if (j > 0) { const t = widths[0]!; widths[0] = widths[j]!; widths[j] = t }
    }
    // 按配额消耗形状：264 列先拿 big（每块至少一张），再 wide；128 列在 tall / small 间交替。
    let bigLeft = shape.big
    let wideLeft = shape.wide
    let tallLeft = shape.tall
    let smallLeft = shape.small
    let hasBig = false
    let hasNonDoubled = false
    const cols: MosaicCol[] = widths.map((w, i) => {
      if (w === 264) {
        /* 264 列可装「一张大贴」（占 1 张、正方形）或「两条宽贴」（占 2 张）。
           先满足大贴配额（它是视觉锚点），配额用尽再出双宽。 */
        if (bigLeft > 0) {
          bigLeft -= 1
          hasBig = true
          hasNonDoubled = true
          return { width: 264, sizes: ['big'] }
        }
        wideLeft -= 1
        return { width: 264, sizes: ['wide', 'wide'] }
      }
      /* 128 列可装「一张高贴」（竖直矩形）或「两条小贴」。 */
      if (tallLeft > 0) {
        tallLeft -= 1
        hasNonDoubled = true
        return { width: 128, sizes: ['tall'] }
      }
      smallLeft -= 1
      return { width: 128, sizes: ['small', 'small'] }
    })
    /* 约束放宽后的判据：整块至少要有一个「大贴」或「高贴」这类**非竖叠**形状，
       否则整块全是成对的贴、没有任何形态变化（早期只查 hasBig，导致宽窗下
       大贴被 preferWide 挤掉后整片都是长方形）。 */
    if (hasNonDoubled || hasBig) return cols
    if (pinFirstTwoSmalls && mode === 6 && cols.length > 0) {
      cols[0] = { width: 128, sizes: ['small', 'small'] }
    }
  }
  // 重抽耗尽：退到设计稿首帧的排法（大 | 双宽 | 高 | 双小），保证仍有大正方形。
  return mode === 3
    ? [
        { width: 264, sizes: ['big'] },
        { width: 264, sizes: ['wide', 'wide'] },
        { width: 264, sizes: ['tall'] },
      ]
    : [
        { width: 264, sizes: ['big'] },
        { width: 264, sizes: ['wide', 'wide'] },
        { width: 128, sizes: ['tall'] },
        { width: 128, sizes: ['small', 'small'] },
      ]
}

/**
 * 高 128 的块骨架：三种列宽模式（均 6u+5g）三选一，再洗牌 264 宽列的位置。
 * 3 列模式下退化为三张宽贴（3×(2u+g)+2g），与该模式其它块等宽。
 */
export function buildColSkeleton128(rng: () => number, mode: MosaicColumns = 6): MosaicCol[] {
  if (mode === 3) {
    return shuffled(rng, WIDTHS_3COL.map(() => ({ width: 264 as const, sizes: ['wide'] as MosaicSize[] })))
  }
  const roll = rng()
  const small = (): MosaicCol => ({ width: 128, sizes: ['small'] })
  const wide = (): MosaicCol => ({ width: 264, sizes: ['wide'] })
  const base: MosaicCol[] = roll < 1 / 3
    ? Array.from({ length: 6 }, small)
    : roll < 2 / 3
      ? [wide(), small(), small(), small(), small()]
      : [wide(), wide(), small(), small()]
  return shuffled(rng, base)
}

/** 取一个块的贴容量。 */
function blockCapacity(cols: readonly MosaicCol[]): number {
  return cols.reduce((n, c) => n + c.sizes.length, 0)
}

/** 按列顺序保留能铺满的列前缀（不留空占位）。 */
function trimCols(cols: readonly MosaicCol[], room: number): MosaicCol[] {
  const kept: MosaicCol[] = []
  let used = 0
  for (const col of cols) {
    if (used + col.sizes.length > room) break
    kept.push(col)
    used += col.sizes.length
  }
  return kept
}

/**
 * 排布选项。
 */
export interface MosaicOptions {
  /**
   * 首块首列钉成「两条小贴竖叠」：集成中心三个页面的入口贴（添加服务器 /
   * 添加技能 / 安装本地包）都固定落在左上角第一张，故需要这枚钉子。
   */
  readonly pinFirstTwoSmalls?: boolean
  /**
   * 列数模式：6（默认，设计稿的细粒度排布）或 3（窄窗降列）。
   * 调用方按容器宽选择——见 {@link pickMosaicColumns}。
   */
  readonly columns?: MosaicColumns
  /**
   * 每条数据的排布提示（与 `items` 同序）。给了它，算法就会把**名字长的**安排到
   * 264 宽的列（宽贴/大贴）上，而不是随机落进 128 宽的窄贴被截断。
   * 省略则退回纯随机（与旧行为一致）。
   */
  readonly hints?: readonly MosaicItemHint[]
  /**
   * 排布随机种子（2026-10-24）。省略 = 固定 `MOSAIC_SEED`（确定性，测试/旧行为）；
   * 页面传入每次挂载生成的随机种子 ⇒ 同一批数据每次打开布局不同，且块内形状
   * 逐块随机（不再按 blockIndex 轮转固定配方）。
   */
  readonly seed?: number
}

/**
 * 按容器宽选列数：够宽用 6 列（设计稿形态），窄到单位宽撑不住长名字时降为 3 列。
 *
 * 判据是**单位宽**而不是容器宽本身：6 列下单位宽 = (容器宽 − 5×gap)/6，低于
 * {@link MIN_UNIT_FOR_6COL} 时长名字在 128 列里必然截断，此时降列比缩字更可读。
 *
 * @param containerWidth - 磁贴群的内容宽（px）。
 * @param gap - 列间隙（px）。
 * @param density - 界面密度缩放（默认 1）。
 */
export const MIN_UNIT_FOR_6COL = 96

export function pickMosaicColumns(containerWidth: number, gap = 8, density = 1): MosaicColumns {
  const g = gap * density
  const unit = (containerWidth - 5 * g) / 6
  return unit < MIN_UNIT_FOR_6COL * density ? 3 : 6
}

/**
 * 把 `items` 排进块序列。
 *
 * ## 长名字优先给宽槽
 * 算法**先在整条数据里**按名字长度挑出「长名」，再按槽位顺序把它们填进 264 宽的
 * 槽（大贴 / 宽贴）；短名字补剩下的 128 宽槽（小贴 / 高贴）。这样长名字拿到
 * 264px 宽（窄窗降 3 列后是 ~174px 起），不再被 128px 的窄贴截成「corum…」。
 *
 * ## 为什么返回 itemIndex 而不是「按顺序数下去」
 * 长名字要跨位置挑选，落位不再是「第 i 张贴 = 第 i 条数据」；块内每张槽位都显式
 * 记下它承载的数据下标，调用方按序渲染即可（见 {@link MosaicSlot}）。
 *
 * ## 其它约束
 * - 相邻块不同型（同型重抽，上限 {@link BLOCK_RETYPE_MAX}）；
 * - 整块放得下就整块收，放不下则列级裁剪收尾（末块允许窄于整宽，属裁剪形态）；
 * - **裁剪后仍继续消费剩余数据**——早期实现此处直接退出循环，导致剩余贴被静默
 *   丢弃（实测 2 张贴只渲染出 1 张，即少显示一个条目）。
 *
 * @param items - 数据条数，或与 `hints` 等长的数据数组（只读其 `length`）。
 * @param options - 见 {@link MosaicOptions}。
 * @returns 块序列；块内槽位带 `size` 与 `itemIndex`，调用方按序遍历取数据渲染。
 */
export function buildMosaic(
  items: number | readonly unknown[],
  options: MosaicOptions = {},
): MosaicBlock[] {
  const count = typeof items === 'number' ? items : items.length
  if (count <= 0) return []
  const mode = options.columns ?? 6
  const rng = mulberry32(options.seed ?? MOSAIC_SEED)
  const blocks: MosaicBlock[] = []

  /* ── 数据分配：长名字优先占 264 宽的槽 ───────────────────────────────────
     入口贴（下标 0，通常是「添加」）**不进长名队列**：它固定占整个墙的第一个槽位
     （左上角）。若把它混进队列，长名字会排到它前面、把它挤到墙中间
     （实测传 hints 时「左上角是入口贴」的命中率只有 3/118）。 */
  const hints = options.hints ?? []
  const entryPinned = options.pinFirstTwoSmalls === true && count >= 2
  const longFirst: number[] = []
  const shortRest: number[] = []
  for (let i = entryPinned ? 1 : 0; i < count; i++) {
    if ((hints[i]?.nameLength ?? 0) >= LONG_NAME_LENGTH) longFirst.push(i)
    else shortRest.push(i)
  }
  // 长名内部：更长 + 有描述者优先（大贴要给描述留高度）。
  longFirst.sort((a, b) => {
    const la = hints[a]?.nameLength ?? 0
    const lb = hints[b]?.nameLength ?? 0
    if (lb !== la) return lb - la
    const da = hints[a]?.hasDescription === true ? 1 : 0
    const db = hints[b]?.hasDescription === true ? 1 : 0
    return db - da
  })
  /** 数据分配顺序：入口贴在队首（若被钉），其后是「长名（最长在前）→ 其余」。 */
  const order = entryPinned ? [0, ...longFirst, ...shortRest] : [...longFirst, ...shortRest]
  let cursor = 0
  const take = (): number => order[cursor++] ?? 0

  /* ── 逐块生成 ─────────────────────────────────────────────────────────────
     顺序至关重要：**先按剩余额度裁剪列骨架，再给留下的槽位分配数据**。
     反过来（先给整块分配、再裁剪）会让被裁掉的那些列已经 `take()` 走数据下标，
     而 cursor 已越过它们 ⇒ 那些数据被静默丢弃（实测 n=12 只产出 6 个槽位、
     n=6 只产出 1 个）。这是本算法长期存在的缺陷，与「末块裁剪」无关。

     形状**不按名字长度决定**：每块先用 {@link planBlockShape} 取一份形状配方
     （大正方形 / 竖直矩形 / 宽贴 / 小贴各几张），再由位置消费配额 —— 于是短名字
     也会轮到正方形与竖直矩形。名字长度只影响「谁先占宽槽」（数据分配顺序），
     不再决定形状本身。 */
  const buildBlock = (kind: MosaicBlockKind, pin: boolean, room: number, blockIndex: number): MosaicCol[] => {
    const skeleton = kind === '264'
      ? buildColSkeleton(rng, mode, pin, planBlockShape(blockIndex, rng))
      : buildColSkeleton128(rng, mode)
    const kept = trimCols(skeleton, room)
    /* 入口贴先钉进**视觉首列的第一个槽**（左上角）。不能只依赖宽度排序：列是按
       宽度降序取数的（为了让长名字进 264 列），那样数据 0 会落到最宽的列、而不是
       最靠前的列（实测命中率只有 203/400）。 */
    let firstColPlaced = false
    if (pin && kept.length > 0 && kept[0]!.sizes.length > 0) {
      const first = kept[0]!
      first.slots = [{ size: first.sizes[0]!, itemIndex: take() }]
      firstColPlaced = true
    }
    // 其余槽位：264 宽的列先填（长名字优先），128 宽的列后填。
    const ordered = [...kept].sort((a, b) => b.width - a.width)
    for (const col of ordered) {
      const start = firstColPlaced && col === kept[0] ? 1 : 0
      const rest = col.sizes.slice(start).map(size => ({ size, itemIndex: take() }))
      col.slots = col.slots === undefined ? rest : [...col.slots, ...rest]
    }
    return kept
  }

  /** 收一个块：列已按额度裁好，此处只做登记。 */
  const emit = (block: MosaicBlock): boolean => {
    if (block.cols.length === 0) return false
    blocks.push(block)
    return true
  }

  if (options.pinFirstTwoSmalls === true && count >= 2) {
    const cols = buildBlock('264', true, count, 0)
    emit({ kind: '264', cols })
  } else if (count === 1) {
    const itemIndex = take()
    emit({ kind: '128', cols: [{ width: 128, sizes: ['small'], slots: [{ size: 'small', itemIndex }] }] })
  }

  while (cursor < count) {
    /* 块类型（= 行高：264/128）。**不再强制相邻不同**（2026-10-24 用户报
       「高度都一样 / 每排都有正方形」）：只有两种 kind 时「相邻必须不同」
       等价于**严格交替**，整墙呈现固定节奏。现在 60% 概率延续上一行的
       kind，形成 2~4 行的同高连续段，再随机换高。 */
    const last = blocks.length === 0 ? null : blocks[blocks.length - 1]!.kind
    let kind: MosaicBlockKind
    if (last === null) {
      kind = rng() < 0.5 ? '264' : '128'
    } else {
      kind = rng() < 0.6 ? last : (last === '264' ? '128' : '264')
    }
    const block = { kind, cols: buildBlock(kind, false, count - cursor, blocks.length) }
    if (emit(block)) continue
    // 连一列都放不下（剩余额度小于任一列的张数）：退化为单张贴窄块收尾。
    const tailKind: MosaicBlockKind = last === '264' ? '128' : '264'
    const itemIndex = take()
    const tailSize: MosaicSize = tailKind === '264' ? 'tall' : 'small'
    emit({
      kind: tailKind,
      cols: [{ width: 128, sizes: [tailSize], slots: [{ size: tailSize, itemIndex }] }],
    })
  }
  return blocks
}

/**
 * 块序列 → 扁平贴序列（按「块 → 列 → 列内自上而下」的渲染顺序），
 * 只返回尺寸档，数据由调用方按同序提供。
 *
 * 走 `buildMosaic` 的 `itemIndex` 时会重排数据，故大多数调用方应直接用
 * {@link MosaicWall}（它按 `itemIndex` 取数据）；本函数留给「数据顺序与槽位
 * 顺序一致」的简单场景。
 */
export function flattenMosaic(blocks: readonly MosaicBlock[]): MosaicSize[] {
  const out: MosaicSize[] = []
  for (const block of blocks) {
    for (const col of block.cols) {
      for (const slot of col.slots ?? []) out.push(slot.size)
    }
  }
  return out
}
