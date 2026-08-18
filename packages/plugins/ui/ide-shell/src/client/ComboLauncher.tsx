/**
 * ComboLauncher — Shell 启动器界面。
 *
 * App 启动时若无 ?combo= 参数，显示 Combo 图标网格。双击 Combo → 跳转
 * ?combo=<id> 进入工作台。
 *
 * 纯组件：Combo 列表经 props 传入，点击回调通知上层路由。
 */
import type { Combo, ComboIcon } from './combos.ts'
import css from './AppFrame.module.css'

/** Lucide 图标名 → emoji 临时映射（后续接 Lucide React 组件）。 */
const LUCIDE_FALLBACK: Record<string, string> = {
  'code-2': '💻',
  'palette': '🎨',
  'bug': '🐛',
  'message-circle': '💬',
  'monitor-smartphone': '📱',
}

/** 渲染 Combo 图标。 */
function Icon({ icon }: { icon: ComboIcon }) {
  if (icon.type === 'emoji') return <span className={css.launcherIconEmoji}>{icon.value}</span>
  if (icon.type === 'text') return <span className={css.launcherIconText}>{icon.value}</span>
  if (icon.type === 'image') return <img className={css.launcherIconImage} src={icon.value} alt="" />
  // lucide: 临时用 emoji fallback，后续替换为 Lucide React 组件
  const emoji = LUCIDE_FALLBACK[icon.value] ?? '⚡'
  return <span className={css.launcherIconEmoji}>{emoji}</span>
}

/** Combo 启动器 props。 */
export interface ComboLauncherProps {
  /** 所有可用 Combo（内置 + 用户自定义）。 */
  combos: Combo[]
  /** 双击/回车进入 Combo。 */
  onOpen: (comboId: string) => void
}

/** Combo 启动器界面：图标网格 + 品牌标题。 */
export function ComboLauncher({ combos, onOpen }: ComboLauncherProps) {
  return (
    <div className={css.launcherRoot}>
      <div className={css.launcherHeader}>
        <h1 className={css.launcherTitle}>矩道 Corum Harness</h1>
        <p className={css.launcherSubtitle}>选择一个工作流开始</p>
      </div>
      <div className={css.launcherGrid}>
        {combos.map((combo) => (
          <button
            key={combo.id}
            type="button"
            className={css.launcherCard}
            onDoubleClick={() => onOpen(combo.id)}
            onClick={() => onOpen(combo.id)}
            title={combo.description}
          >
            <div className={css.launcherCardIcon}>
              <Icon icon={combo.icon} />
            </div>
            <div className={css.launcherCardName}>{combo.name}</div>
            <div className={css.launcherCardDesc}>{combo.description}</div>
            <div className={css.launcherCardAgent}>Agent: {combo.agentPreset}</div>
          </button>
        ))}
        {/* 新建 Combo 入口 */}
        <button
          type="button"
          className={css.launcherCardNew}
          title="保存当前布局为 Combo"
        >
          <div className={css.launcherCardIcon}>+</div>
          <div className={css.launcherCardName}>新建</div>
        </button>
      </div>
    </div>
  )
}
