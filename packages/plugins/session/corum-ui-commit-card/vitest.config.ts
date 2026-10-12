/**
 * @corum/corum-ui-commit-card test config.
 *
 * Minimal vitest config for the contract / conversation-node / locale unit
 * tests — pure-function and design-fidelity assertions only (same档位 as
 * @corum/corum-ui-chat): no jsdom, no React rendering, no new deps.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
  },
})
