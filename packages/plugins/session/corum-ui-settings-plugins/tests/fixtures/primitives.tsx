/**
 * `@deepseek-ai/dsh-client-ui-primitives` test stand-in.
 *
 * Only the chrome this package renders is needed; the real package pulls an
 * uninstalled `simple-icons` dependency at import time (official packaging
 * defect), which has nothing to do with what these tests assert.
 * @module tests/fixtures/primitives
 */

/** Stand-in for the card's chevron: renders no markup. */
export function IconChevronDownOutlineMedium(): null {
  return null
}