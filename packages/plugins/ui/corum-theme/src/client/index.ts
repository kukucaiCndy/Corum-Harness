/**
 * corum-theme browser half: the 矩道 Corum Harness liquid-glass palette.
 *
 * It does NOT register a new theme id — the mode axis (minimal/IDE) is
 * orthogonal to the theme axis (light/dark/system), and IDE mode is meant to
 * re-skin the SAME built-in light/dark pair. So this plugin stacks one token
 * override layer (`corum-glass`) on top of the active theme through
 * `ctx.theme.overrideTokens`, mapping the design's semantic tokens onto the
 * official `--dsw-alias-*` variables. Light/dark flips only the token VALUE
 * (the presenter already projects the composed snapshot onto document.body),
 * so switching the Appearance preference inside IDE mode just re-colors the
 * same glass structure.
 *
 * The layer maps the alias tokens (backgrounds, labels, brand, states, the
 * sidebar fill, the primary button). The design's OWN variables — `--glass-*`,
 * `--brand-*`, `--glow-*`, fonts, the ambient glow background, and the
 * `.glass-card` helper — are plain CSS (theme.css) inlined into the client
 * bundle by the post-build step, flipped on `body[data-ds-dark-theme]` exactly
 * like the official palette.
 * @module corum-theme/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import './theme.css'

/**
 * The alias-token override layer. Every value is a `{ light, dark }` pair so
 * the override never goes illegible when the user switches color scheme; the
 * presenter picks the value matching the active scheme.
 */
const GLASS_TOKENS: ThemeTokenOverrides = {
  // Backgrounds — the glass hierarchy over the base.
  '--dsw-alias-bg-base': { light: '#E9E9F2', dark: '#0D0817' },
  '--dsw-alias-bg-layer-1': { light: '#FFFFFFE6', dark: '#1D112BD9' },
  '--dsw-alias-bg-layer-2': { light: '#FFFFFFCC', dark: '#2A1840D9' },
  '--dsw-alias-bg-layer-3': { light: '#FFFFFFB3', dark: '#372050CC' },
  '--dsw-alias-bg-overlay': { light: '#FFFFFFB3', dark: '#372050CC' },
  // Glass light-edge border (white in light, neon-translucent in dark).
  '--dsw-alias-border-l1': { light: '#FFFFFF', dark: '#B98CFF2E' },
  // Label hierarchy.
  '--dsw-alias-label-primary': { light: '#0E0E1C', dark: '#F3ECFF' },
  '--dsw-alias-label-secondary': { light: '#5C5C77', dark: '#B3A6D9' },
  '--dsw-alias-label-tertiary': { light: '#8B8BA3', dark: '#7E719E' },
  '--dsw-alias-label-dimmed': { light: '#B9B9C9', dark: '#55486F' },
  // Brand (electric violet in light, neon cyan in dark).
  '--dsw-alias-brand-primary': { light: '#5B21F5', dark: '#01CDFE' },
  '--dsw-alias-brand-text': { light: '#5B21F5', dark: '#4DE3FF' },
  // States.
  '--dsw-alias-state-error-primary': { light: '#E0245E', dark: '#FF5C8A' },
  '--dsw-alias-state-success-primary': { light: '#0BA57C', dark: '#3EE6B0' },
  '--dsw-alias-state-warn-primary': { light: '#E07A00', dark: '#FFB45C' },
  // Interaction surfaces (glass half-translucency).
  '--dsw-alias-interactive-bg-hover': { light: 'rgba(14, 14, 28, 0.05)', dark: 'rgba(243, 236, 255, 0.08)' },
  '--dsw-alias-interactive-bg-active': { light: 'rgba(14, 14, 28, 0.09)', dark: 'rgba(243, 236, 255, 0.14)' },
  // Code blocks keep contrast against the glass cards.
  '--dsw-alias-markdown-code-block': { light: '#DDDCE8', dark: '#0A0612' },
  '--dsw-alias-markdown-inline-code': { light: '#DDDCE8', dark: '#1D112B' },
  // Shell chrome: the sidebar fill and the primary button ride the glass/brand.
  '--dsw-specific-sidebar-fill': { light: '#FFFFFFE6', dark: '#1D112BD9' },
  '--dsw-alias-button-primary-fill': { light: '#5B21F5', dark: '#01CDFE' },
}

/** Required services: the theme runtime this plugin shades. */
export const inject = ['theme']

/**
 * Stack the glass token layer over the active theme for this plugin's
 * lifetime. `overrideTokens` returns a disposer, so the effect tears the layer
 * down (and restores the base palette) if this plugin is unloaded.
 * @param ctx - client root context carrying `ctx.theme`.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.theme.overrideTokens('corum-glass', GLASS_TOKENS), 'corum-theme: glass token layer')
}
