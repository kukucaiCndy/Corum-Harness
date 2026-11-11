/**
 * Model-facing rendering of the user's subagent model candidates.
 *
 * The user keeps one global candidate set (`subagentModelSelection`) and tags
 * each route with free-form capability labels. Nothing here interprets those
 * labels — this module only renders them where a model reads them: the
 * `list_subagent_models` output and one system-prompt section.
 *
 * @module @corum/corum-tool-subagent/model-candidates
 */

import type { AllowedModelRoute } from './model-selection.ts'

/**
 * Render one route's capability tags as a trailing ` [a, b]` marker.
 * @param route - Candidate route that may carry tags.
 * @returns The marker, or an empty string for an untagged route.
 */
export function routeTagMarker(route: Pick<AllowedModelRoute, 'tags'>): string {
  const tags = route.tags ?? []
  return tags.length === 0 ? '' : ` [${tags.join(', ')}]`
}

/**
 * Render one route's note as a trailing ` — note` segment.
 * @param route - Candidate route that may carry a note.
 * @returns The segment, or an empty string when the note is absent or blank.
 */
export function routeNoteSuffix(route: Pick<AllowedModelRoute, 'note'>): string {
  const note = route.note?.trim() ?? ''
  return note === '' ? '' : ` — ${note}`
}

/**
 * Render one configured candidate as a model-facing bullet body.
 * @param route - Candidate route.
 * @returns `provider/model [tags] — note`, with absent annotations omitted.
 */
export function routeCandidateLine(route: AllowedModelRoute): string {
  return `${route.provider}/${route.model}${routeTagMarker(route)}${routeNoteSuffix(route)}`
}

/**
 * System-prompt section advertising the candidate set and its capability tags.
 *
 * An empty candidate list yields an empty string: the mechanism omits empty
 * sections, so a session without candidates never sees a model-picker prompt.
 * @param routes - Routes captured for this Session (already validated).
 * @returns The section text, or an empty string when nothing is configured.
 */
export function corumSubagentModelCandidatesSection(routes: readonly AllowedModelRoute[]): string {
  if (routes.length === 0) return ''
  return [
    '**Subagent model candidates — YOU choose the child route per task.** The user authorized these exact routes and tagged each with what it is good at:',
    ...routes.map(route => `- \`${routeCandidateLine(route)}\``),
    'Pick the route by the shape of the work, not by habit:',
    '- Long, deep coding (large refactors, whole-module rewrites) → the route tagged for long context / strong coding.',
    '- Work that must LOOK at images or screenshots (UI verification, diagram or photo input) → a multimodal-tagged route.',
    '- Small mechanical or high-volume work (renames, formatting, quick lookups) → a fast/flash-tagged route.',
    '- Tags are advisory, not exhaustive: an untagged route is still a valid choice, and the mechanism never rejects a listed route because of its tags.',
    'How to select: pass `provider` and `model` (plus optional `reasoning_effort`) exactly as listed on the delegation call. A route outside this list is REJECTED by the mechanism. Omit all three fields to inherit the configured child route.',
    'Call `list_subagent_models` (with `provider`, then `model`) to read the exact advertised ids and reasoning efforts of a candidate.',
  ].join('\n')
}