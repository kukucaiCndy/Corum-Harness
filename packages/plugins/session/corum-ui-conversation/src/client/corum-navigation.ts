/**
 * corum session navigation — type-only re-export shim.
 *
 * **Single source of truth**: the implementation lives in
 * `@corum/corum-ui-navigation` (`packages/plugins/session/corum-ui-navigation`).
 * This file exists solely for backward-compatible type imports within
 * `@corum/corum-ui-conversation` (its `index.ts` re-exports types from here).
 * There are no runtime exports — the bundler externalizes workspace packages
 * and cannot resolve a cross-package runtime re-export, so this file is
 * type-only.
 *
 * The Context augmentation (`corumNavigation` on `Context`) is declared
 * authoritatively in the navigation package's `corum-navigation.ts`.
 *
 * `applyCorumSessionNavigation` is not re-exported from here — consumers
 * that need it import it from `@corum/corum-ui-navigation/client` directly.
 */
export type { CorumMainSelection, CorumSessionNavigation } from '@corum/corum-ui-navigation/client'
