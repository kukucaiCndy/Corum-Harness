/**
 * @corum/corum-ui-distill-card test config.
 *
 * Minimal vitest config for the dock card / contract unit tests —
 * pure-function assertions only (same档位 as @corum/corum-ui-commit-card):
 * no jsdom, no React rendering, no new deps.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
  },
})
