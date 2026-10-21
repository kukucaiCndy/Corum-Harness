/**
 * @corum/corum-ui-conversation test config.
 *
 * Pure-logic tests only: the submit machine, the draft scanner, the
 * submission policy and the small projection helpers. None of them touch
 * the DOM, React or a Lexical editor, so no jsdom environment and no
 * browser transform are wired here on purpose — the moment a test needs
 * one, that is the signal it belongs to the render/real-app layers
 * (jsdom component tests / CDP specs), not to this suite.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    pool: 'forks',
  },
})
