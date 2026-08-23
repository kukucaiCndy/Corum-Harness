/**
 * Monaco language-worker dispatch for the desktop renderer.
 *
 * Monaco loads its editor core and per-language analysis in web workers. Each
 * worker is a self-contained script the desktop shell stages into its frontend
 * dist (build/dist/monaco/*.worker.js) and serves over the existing
 * `corumapp://` custom protocol — no new protocol path, and no bundler "new URL"
 * rewriting. `MonacoEnvironment.getWorker` is assigned once, before any editor
 * is created, and answers each worker label with a Worker constructed against
 * that protocol URL.
 *
 * Worker labels are Monaco's own vocabulary: `editorWorkerService` is the
 * editor core (text model sync, diff, etc.); `typescript`, `json`, `css`, and
 * `html` are the language services that opt into their dedicated workers.
 * @module corum-desktop/client/editor/worker
 */

/** Protocol base the dist index loads under (see protocol.ts). */
const MONACO_WORKER_BASE = 'corumapp://app/monaco'

/** The language labels Monaco dispatches to a dedicated worker script. */
const WORKER_SCRIPTS: Readonly<Record<string, string>> = {
  editorWorkerService: 'editor.worker.js',
  typescript: 'ts.worker.js',
  javascript: 'ts.worker.js',
  json: 'json.worker.js',
  css: 'css.worker.js',
  scss: 'css.worker.js',
  less: 'css.worker.js',
  html: 'html.worker.js',
  handlebars: 'html.worker.js',
  razor: 'html.worker.js',
}

/** Worker labels that reuse Monaco's core editor worker (no dedicated script). */
const CORE_WORKER_LABELS = new Set(['editorWorkerService'])

/** The sameWorker-shared worker kinds Monaco reuses across some languages. */
const SHARED_WORKER_LABELS = new Set([
  'handlebars', 'razor', 'less', 'scss', 'html', 'json', 'css',
])

/**
 * The one Monaco environment hook: answer every worker request with a Worker
 * pointed at the staged worker script over `corumapp://`.
 * @param workerId - `workerMain.js` (Monaco's fixed worker entry id).
 * @param label - the worker descriptor label (see {@link WORKER_SCRIPTS}).
 * @returns a Worker for the label, or undefined when the label needs no worker.
 */
export function getWorker(workerId: string, label: string): Worker | undefined {
  // Core editor service always gets the core worker.
  if (label === 'editorWorkerService') {
    return new Worker(`${MONACO_WORKER_BASE}/${WORKER_SCRIPTS.editorWorkerService}`, {
      type: 'classic',
      name: 'monaco-editor-worker',
    })
  }
  const script = WORKER_SCRIPTS[label]
  if (script === undefined) return undefined
  return new Worker(`${MONACO_WORKER_BASE}/${script}`, {
    type: 'classic',
    name: `monaco-${label}-worker`,
  })
}

/**
 * Install the Monaco worker environment. Idempotent; call once before the
 * first editor model is created.
 */
export function installMonacoWorkerEnvironment(): void {
  // Monaco reads the environment from its own module-scoped singleton; the
  // editor.api re-exports `Environment` only on some bundles, so assign the
  // global hook monaco expects. This is the documented standalone contract.
  const existing = (globalThis as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment
  if (existing !== undefined) return
  ;(globalThis as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
    getWorker,
  }
}
