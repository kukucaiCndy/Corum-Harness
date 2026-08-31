# corum Agent OS — Development Conventions (auto-injected into every session)

> This file is auto-injected into every new session by dsh agent-instructions
> (project-root `AGENTS.md`; mechanism: `packages/context/agent-instructions`,
> which walks up from cwd to the `.git` marker to locate this root).
> It lists **red lines + entry points only**; the full conventions live in
> `docs/dev-conventions.md` (read it in full before touching cross-bundle state
> or adding a plugin).

## Red Lines (know these first)

1. **Cross-bundle shared state: always a cordis service, never a window global
   or module-level singleton.**
   dsh inlines `@corum/*` sources into every consumer bundle, so module-level /
   window-mounted state is split per bundle and never reconciled (the
   `__corumSidebarMode` case: it degraded into dead writes and broke the sidebar
   linkage). A cordis service instance's uniqueness is guaranteed by the root
   context `reflect.store` — **naturally singleton across bundles** (proven in
   `.dbg/cordis-singleton-probe.md`). Model shared state as a cordis service
   (provide + inject); no externalization needed.
   - Exceptions (legal window mounts — all "written once, read-only", not shared
     mutable state): `window.corumDesktop` (IPC bridge), `__corumNotify`,
     `__DSH_BOOT__` (the only client-side read path).
2. **Don't casually externalize `@corum/*`**: the dsh module table has only 8
   hardcoded seeds; a custom shared module via the `dsh.client` plugin path
   white-screens the app (proof in `.dbg/b1-boot-graph-findings.md`). Route
   around it with the cordis service from rule 1.
3. **Cross-bundle type-face mismatch → narrow with a local capability
   interface**: the service type a consumer injects may be the official
   baseline's narrow interface (the corum runtime is a superset). Don't couple
   to the implementation package — narrow with a capability interface + helper
   (e.g. conversation's `SidebarModeCapableLayout`, recorded in
   `.dbg/c3a-sidebar-mode-service.md`).
4. **Consume cordis services via `inject` declarations, never `ctx.get` on an
   unassembled service** (the `ctx.remote` pitfall).
5. **Host-plugin changes require an app restart**; only renderer changes hot-
   reload via HMR. Any cross-package state / shell / scheduler change must pass
   the three-layer on-device CDP verification (UI renders + behavior + zero
   console errors). "It compiles" is not "done".

## Key Documents (read as needed)

- `docs/dev-conventions.md` — **full development conventions** (decision tree,
  code do/don't examples, evidence index).
- `docs/audit/NEXT-PHASE-DEFERRED.md` — deferred/closed architecture items
  (sidebarMode service done, slot-registry service done).
- `docs/fork-delta.md` — diff ledger of the 6 session-domain fork packages +
  official-upgrade runbook (required reading before touching fork packages).
- `docs/plugin-template.md` — new-plugin package template and setup steps.
- `.dbg/cordis-singleton-probe.md`, `.dbg/c3a-sidebar-mode-service.md` — the
  cordis cross-bundle singleton proof + the sidebarMode service implementation
  record (the slot-registry service reuses the same pattern: provide + inject +
  uSES source + InjectFace).

## Repo Quick Reference

- Plugins live in `packages/plugins/<group>/<name>` (groups: ui/session/agent);
  the desktop shell is `packages/desktop`. A new plugin must be added to
  `packages/desktop/package.json` deps + linked via `pnpm install`.
- Build: `pnpm --filter <name> run build` (build dependency packages such as
  ui-base first). Typecheck uses the same package filter.
- On-device verification / CDP: see the `corum-cdp-verify` skill
  (`./scripts/cdp.sh start|status|stop`).
