# corum Development Conventions

> Conventions for client/plugin development in corum Agent OS (the kkc-desktop
> repo). Every rule comes from a **real pitfall or audit finding**, with the
> evidence cited. Required reading before adding a plugin or changing
> cross-package state.
>
> Core theme this round: **all cross-bundle shared state goes through a cordis
> service — never a window global.** Evidence: the C3a effort
> (`.dbg/cordis-singleton-probe.md` + `.dbg/C3a-sidebar-mode-service.md`).

---

## 1. Cross-bundle shared state: always a cordis service, never a window global (core)

### Anti-pattern (forbidden)

Mounting runtime state that multiple plugins read/write onto a **window global**
or a **module-level variable**:

```ts
// ❌ Forbidden: window-global shared mutable state
const w = window as unknown as { __corumFoo?: { mode: string } }
w.__corumFoo ??= { mode: 'task' }
export function setFoo(m: string) { w.__corumFoo!.mode = m }

// ❌ Forbidden: module-level singleton (inlined per bundle, never reconciled)
let currentMode = 'task'
export const getMode = () => currentMode
```

**Why it's forbidden**: dsh's client bundling inlines `@corum/*` sources into
**every consumer bundle** (tsdown `noExternal`) — the same library becomes an
**independent module instance** in each bundle. Module-level / window-mounted
state looks "global" but is actually split per bundle and never reconciled.
`__corumSidebarMode` is the living example: the sidebar set the sidebar's
instance while the conversation area read the conversation's instance, so the
linkage silently broke (and worse — it degraded into dead writes with no reader).

### Correct pattern (required)

Model shared state as a **cordis service owned by the IDE shell (or a provider
plugin)**, registered via `ctx.reflect.provide`, and read by consumers through
`inject`. **A cordis service instance's uniqueness is guaranteed by the root
context `reflect.store` (keyed by service name, independent of each bundle's
module instances) — it is naturally a singleton across bundles (proven), with no
need to externalize ui-base.**

```ts
// ✅ Provider (e.g. corum-ide-ui shell's LayoutController)
class LayoutController {
  #sidebarMode: SidebarMode = 'task'
  #listeners = new Set<() => void>()
  setSidebarMode(m: SidebarMode) { /* idempotent + broadcast */ }
  getSidebarMode(): SidebarMode { return this.#sidebarMode }
  sidebarModeSnapshot() {   // uSES source: for component selector Hooks
    return { getSnapshot: () => this.getSidebarMode(),
             subscribe: (fn) => this.onSidebarModeChange(fn) }
  }
}
// In the shell's apply: ctx.reflect.provide('layout', layout)
```

```ts
// ✅ Consumer (sidebar / conversation): inject the existing service; no new declaration
const mode = useSidebarMode(s => s)          // component reads via InjectFace selector
ctx.layout.setSidebarMode('project')          // apply writes
```

### Decision tree (should you share, and how)

```
Is the state read/written by ≥2 independent bundles?
├─ No  → component useState / package-internal store; don't build a service
└─ Yes → a cordis service
        ├─ Does it belong to an existing service domain (layout/theme/session…)?
        │   → attach it to that service (e.g. ctx.layout), don't create a new one.
        │   sidebarMode on ctx.layout is exactly this: shell/sidebar/conversation
        │   all already inject it — zero new services, zero extra injects.
        └─ No owner → create a dedicated service, but first decide who provides
            and who injects
```

### Exceptions (legal window mounts)

Only two kinds of window mount are legal, and neither is "shared mutable
business state":
- **One-shot bridge / service object**: `window.corumDesktop` (IPC bridge
  injected by the desktop shell), `__corumNotify` (a notify function) — written
  once, then read-only; no cross-bundle write contention.
- **Framework-level read-only manifest**: `__DSH_BOOT__` (the only client-side
  read path; `parseBootManifest` is loader-internal and not exposed, so plugins
  can only read it raw — proven by the C1 sub-item; don't propose "switch to
  parseBootManifest" again).

Red line: **state written by multiple bundles never goes on window; "written
once, read-only" may.**

---

## 2. cordis service usage rules

1. **Provide once, at a fixed site**: the service instance is `new`ed in the
   provider plugin's `apply` and registered with `ctx.reflect.provide(name,
   instance)`. Only one provide site per service name across the whole
   composition (cordis throws on duplicate registration).
2. **Consumers declare via `inject`; don't `ctx.get` an unassembled service**:
   declare dependencies in `inject: [...]` and cordis guarantees they are ready
   at activation. Use `ctx.get(name)` only for genuinely *optional* dependencies
   (with a fallback) — not to bypass `inject`. The fork's `ctx.remote` pitfall
   (see the apply.ts comment) is what reading an unassembled service looks like.
3. **Module-top-level writes vs apply timing (the C1 lesson)**: a cordis plugin's
   **module top level runs at graph-load time** (the shell's apply has not run,
   the service is not yet provided), while **apply runs at activation**. Any
   state that is *written at module top level* (e.g. ide-layout.ts's built-in
   slot registrations) and *read through a service* must NOT use "bind the
   backend once at apply" — the top-level writes get locked into the fallback
   before the bind. Resolve the backend **on every call** + drain the early
   writes into the service at apply (`resolveBackend()` + `drainPendingSlots`
   in grid.ts; the runtime trace proof is in `.dbg/C1-slot-registry-service.md`).
4. **Cross-bundle type-face mismatch → narrow with a local capability
   interface**: the service type a consumer injects may come from the **official
   baseline's narrow interface** (e.g. conversation sees `ctx.layout: ILayout`
   with only 3 methods), while the corum runtime is a superset. **Don't couple
   to the implementation package** — narrow with a capability interface + helper
   (the C3b contract pattern):
   ```ts
   interface SidebarModeCapableLayout { setSidebarMode(m: SidebarMode): void }
   const layout = ctx.layout as unknown as SidebarModeCapableLayout
   ```
   Compile-time safety, zero runtime change, no dependency bloat.
5. **Component subscribes to service state → uSES source + InjectFace**: the
   service exposes a `{ getSnapshot, subscribe }` source, delivered through the
   slots inject face, and the component consumes it with a `useXxx(selector)`
   Hook (same pattern as `useProjectOccupied`). `getSnapshot` must return a
   stable reference while the value is unchanged.

---

## 3. Bundling / module-table discipline (lessons from B1-pre)

1. **Don't casually externalize `@corum/*`**: the dsh module table has only 8
   hardcoded seeds (react/cordis/store/ui-slots/ui-primitives, …). A custom
   shared module via the `dsh.client` plugin path **white-screens the app**
   (round 36 proof; reverting restores it). Prefer the §1 cordis service to
   route around sharing needs; revisit externalization (B1-pre) only once the
   official module-table mechanism is clarified.
2. **A client bundle entering the boot graph must have an apply**: even a pure
   library acting as a shared module needs
   `export function apply(): void {}` + `export const inject: string[] = []`,
   otherwise cordis `create()` throws `invalid plugin` and the whole web boot
   fails (loud).
3. **On-device regression must run on a renderable baseline**: when touching
   ui-base / shell core (GridView/grid/slot), first confirm the shell renders
   before externalizing/refactoring — otherwise you can't isolate "my change"
   from "someone else's half-done change" at runtime (the round-36 lesson).
4. **A new plugin must be resolvable by desktop**: add it to
   `packages/desktop/package.json` deps + `pnpm install` to link, otherwise the
   loader fails with `Cannot find package` (hit by this repo's probe plugin).
5. **The shell's client bundle can't be statically value-imported by a sibling
   plugin**: dsh inlines each consumer bundle its own copy, so a static
   `import { X } from '@corum/corum-ide-ui/client'` fails at tsdown
   (`MISSING_EXPORT` resolving `lib/client.js`) — the same B1-pre wall. Two
   sanctioned routes, both zero-runtime-coupling:
   - **cordis service** for anything callable/subscribable: consume
     `ctx.layout` / `ctx.slotRegistry` and narrow with a local capability
     interface (§2.4) — never `import { LayoutController }` for its methods.
   - **A mirrored string literal + an anchor comment** for a pure signal name
     (e.g. the `corum:open-plugin-manager` event): declare the literal locally
     with a comment pinning it to the shell's source of truth; only
     `import type {}` from the shell package (pulls the Context merge, erased
     at build). The plugin-manager split (`.dbg` record in
     `NEXT-PHASE-DEFERRED.md` §3) is the reference implementation.

---

## 4. Fork-package discipline (the 6 session-domain forks)

1. **Register every deviation from official**: a substantive change in a fork
   package gets a `// fork（corum）：reason` comment and an entry in
   `docs/fork-delta.md` — official upgrades follow the §5 runbook there, not
   archaeology.
2. **Preserve the official shape where possible**: don't touch what doesn't
   need touching (inject faces, official `ILayout` semantics). For the known
   "officially impossible" points (raw `__DSH_BOOT__` reads, the disabled
   uiWorkspace), use the established fallbacks; don't reopen misjudged items the
   audit already closed (see `NEXT-PHASE-DEFERRED.md` §4).

---

## 5. In-package large-file split discipline (the C5 low-risk alternative)

Splitting a 700+-line file into same-package modules (readability without the
RPC-namespace risk of splitting the *package*). Four named files were split this
way (`agent-service` / `runtime` / `project-data-service` / `AgentTestPanel` /
`McpManagerPanel`); the pattern below is what kept each one zero-risk.

1. **`@Remote` endpoints never move**: the Typert `@Remote('m')` methods stay on
   the original class — the `/api/<ns>/<method>` namespace is the stable contract
   other domains call (conversation / ide-sidebar / agent-ui-dev). Only class-free
   helpers, types, pure functions, and React sub-components move out.
2. **Re-export to hold the import face**: the original file re-exports every
   symbol it still owns for consumers (`export { X } from './new-module.ts'`),
   so existing consumers (`index` / sibling services / contract) need **zero
   changes**. After splitting, typecheck **every consumer package** (`pnpm
   --filter <consumer> exec tsc --noEmit`), not just the edited one — a missed
   re-export surfaces as the consumer's TS2304, not the edited file's.
3. **Extract only true leaves**: a candidate module must not need `this` (service
   state) — state machine edges, zod validators, event/project DTO projections,
   factory/ensure functions, draft converters, dialog/presentational components.
   If a "helper" reads service maps or calls sibling methods, it stays in the class.
4. **RPC smoke on the session domain too**: after a host split, restart
   (`./scripts/cdp.sh stop && start`) and probe not only the edited service's
   endpoints but the **session-domain** ones that reuse the same code path —
   e.g. `corumProjectData/*` reuses the same domain/event-log as `corumRuntime/*`.
   Endpoint envelope for probes: `{ type:'client-request', rpcId, method:'<ns>/<m>',
   payload:{ args } }` posted to `/api/<ns>/<m>`.

---

## 6. On-device verification discipline (CDP)

1. **Compiling is not finishing**: for cross-package state / shell / scheduler
   changes, run the on-device CDP three-layer check — UI renders + behavior +
   zero console errors (see the `corum-cdp-verify` skill).
2. **Real clicks via MCP click / the Input domain**: don't fake React controlled
   components with `el.value=` or a bare `dispatchEvent` — use MCP `click`/`fill`
   or CDP `Input.dispatchMouseEvent` to trigger the full event chain.
3. **Host-plugin changes require an app restart**: renderer changes hot-reload
   via HMR, but host changes (corum-agent-dev etc.) need
   `./scripts/cdp.sh stop && start` to take effect.

---

## Appendix: rule ↔ evidence index

| Rule | Evidence |
|---|---|
| §1 no window-global shared state | C3a effort: `__corumSidebarMode` split per bundle into dead writes, breaking linkage |
| §1 cordis service is a cross-bundle singleton | `.dbg/cordis-singleton-probe.md` (on-device `===` PASS) |
| §1 exceptions (corumDesktop/__DSH_BOOT__) | C1 sub-item proof (`NEXT-PHASE-DEFERRED.md` §4) |
| §2.4 capability-interface narrowing | C3b contract + C3a conversation `SidebarModeCapableLayout` |
| §2.2 no reading unassembled services | conversation `ctx.remote` pitfall (apply.ts comment) |
| §2.3 module-top-level vs apply timing | C1: 5 built-in slot registrations traced `backend=NULL` (locked into fallback) until resolveBackend + drainPendingSlots (`.dbg/C1-slot-registry-service.md`) |
| §5.1 @Remote endpoints never move | C5 alternative: all 5 splits kept `/api/corumAgent/*` `/api/corumRuntime/*` `/api/corumProjectData/*` unchanged (RPC smoke `ok:true` after each) |
| §5.2 re-export + consumer-wide typecheck | agent-service split: consumer TS2304 (`runtime.ts` simplifyEventData, `project-service.ts` ensurePmProfile) surfaced only when typechecking consumers, not the edited file |
| §5.4 session-domain RPC smoke | project-data split verified via `corumProjectData/listRequirements` + `corumProject/listProjects` (same domain/event-log path as `corumRuntime`) |
| §3.1 externalization white-screen | B1-pre round 36 (`.dbg/B1-boot-graph-findings.md`) |
| §3.5 shell bundle no static value import | plugin-manager split: `import { OPEN_PLUGIN_MANAGER_EVENT }` → tsdown `MISSING_EXPORT`; fixed via capability-interface narrowing (ctx.layout) + mirrored event literal |
| §3.2 pure library needs a no-op apply | cordis `resolve()` validity check + no official pure-client precedent |
