/** Subagent progress-card payload shared between the Chat Node and its renderer. */

/** Turn-local subagent invocation encoded as a reference-stable Location-data scalar. */
export type SubagentTurnSignature = string

/** Static identity of one delegated subagent invocation, folded from the parent log. */
export interface SubagentInvocation {
  /** Parent-side `tool/call` identity of the delegation. */
  readonly callId: string
  /** Parent turn that issued the delegation. */
  readonly turn: number
  /** Parent event seq anchoring the card in the waterfall. */
  readonly anchorSeq: number
  /** Parent event time of the delegation call. */
  readonly time: number
  /** Delegation `description` (or recovered child label); may be absent on history cuts. */
  readonly description?: string
  /** Leading excerpt of the delegated `prompt`; absent when not in the loaded window. */
  readonly prompt?: string
  /** Matched child Session id (`origin: 'subagent'` + parent lineage + nearest start time). */
  readonly childSessionId?: string
}

/** One matched child Session's latest observed progress, folded from its event window. */
export interface SubagentProgress {
  /** Direct child Session id. */
  readonly sessionId: string
  /** Durable descriptor label when the child published one. */
  readonly label?: string
  /** Live activity of the child; absent until its own event window resolves. */
  readonly running?: boolean
  /** Latest turn opened in the child's loaded window. */
  readonly turn: number
  /** Steps closed in the current turn. */
  readonly step: number
  /** Free-form current action: latest tool call or open assistant generation. */
  readonly currentAction?: string
  /** Whether the child's event window was still cold at snapshot time. */
  readonly windowCold: boolean
}

/** Card payload keyed by parent delegation call. */
export interface SubagentChatData {
  readonly invocations: readonly SubagentInvocation[]
}

/** Leading-prompt excerpt length in Unicode code points. */
const PROMPT_EXCERPT_MAX = 120

/** Read one string field off a structurally narrowed payload. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Extract the delegation display fields from one raw `tool/call` arguments JSON.
 * @param argsRaw - raw arguments string exactly as the model produced it.
 * @returns short description and a leading prompt excerpt, when present.
 */
export function subagentDelegationFields(argsRaw: string): {
  readonly description?: string
  readonly prompt?: string
} {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as Readonly<Record<string, unknown>>
    const description = textOf(record.description)
    const promptValue = textOf(record.prompt)
    const prompt = promptValue === undefined
      ? undefined
      : [...promptValue].slice(0, PROMPT_EXCERPT_MAX).join('')
    return { ...description === undefined ? {} : { description }, ...prompt === undefined ? {} : { prompt } }
  } catch {
    return {}
  }
}

/**
 * Encode one turn's subagent invocations as a primitive Location-data value.
 * @param invocations - folded invocation list of one turn.
 * @returns reference-stable scalar for equal payloads.
 */
export function encodeSubagentTurn(invocations: readonly SubagentInvocation[]): SubagentTurnSignature {
  return invocations.map(invocation => [
    invocation.callId,
    invocation.anchorSeq,
    invocation.time,
    invocation.description ?? '',
    invocation.prompt ?? '',
    invocation.childSessionId ?? '',
  ].join('~')).join('|')
}

/**
 * Decode a same-process signature produced by {@link encodeSubagentTurn}.
 * @param signature - encoded turn value.
 * @returns decoded invocation list (turn is re-attached by the reader).
 */
export function decodeSubagentTurn(signature: SubagentTurnSignature): readonly SubagentInvocation[] {
  if (signature === '') return []
  return signature.split('|').map((entry) => {
    const [callId, anchorSeq, time, description, prompt, childSessionId] = entry.split('~')
    return {
      callId,
      turn: 0,
      anchorSeq: Number(anchorSeq),
      time: Number(time),
      ...description === '' ? {} : { description },
      ...prompt === '' ? {} : { prompt },
      ...childSessionId === '' ? {} : { childSessionId },
    }
  })
}
