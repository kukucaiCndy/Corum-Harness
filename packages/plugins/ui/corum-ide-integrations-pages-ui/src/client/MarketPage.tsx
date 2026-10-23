/**
 * MarketPage — 集成中心 · 市场页（P5e 占位）。
 *
 * P5b 只声明了第 5 个页签；真正的统一市场（插件/技能/MCP/扩展包磁贴）
 * 在 P5e 落地。这里给一个诚实的「建设中」空态，避免点开是空白面板。
 *
 * @module corum-ide-integrations-pages-ui/client/MarketPage
 */
import { Store } from 'lucide-react'

/** 市场页占位：图标 + 标题 + 说明（不假造任何市场内容）。 */
export function MarketPage() {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: 24,
        textAlign: 'center',
        color: 'var(--corum-label-secondary, #c9c4dd)',
      }}
    >
      <span
        style={{
          width: 48,
          height: 48,
          borderRadius: 14,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--corum-glass-2, #3b36633a)',
          border: '1px solid var(--corum-glass-border, #ffffff1f)',
          color: 'var(--corum-brand-text, #a78bfa)',
        }}
      >
        <Store size={22} />
      </span>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--corum-label-primary, #f5f5f5)' }}>
        市场建设中
      </div>
      <div style={{ fontSize: 10.5, maxWidth: 320, lineHeight: 1.5 }}>
        插件 / 技能 / MCP / 扩展包 的统一市场将在 P5e 落地。
      </div>
    </div>
  )
}
