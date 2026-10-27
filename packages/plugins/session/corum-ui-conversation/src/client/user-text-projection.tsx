/**
 * Display projection of reference forms in sent user text (bubble and queue
 * rows). The logged model text remains the single truth; this is presentation
 * only, and every part renders inline so a single-line message never breaks
 * across lines.
 *
 * This is a local fork replacement for the 0.1.5 `projectUserText` that was
 * removed from `@deepseek-ai/dsh-client-ui-primitives` in rc3. The official
 * rc3 ui-chat uses `UserTextRun` + `ReferenceChip` from ui-primitives instead,
 * but the fork's message rendering predates that and still uses the projection
 * function approach.
 */
import type { ReactNode } from 'react'
import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'

/** Token kind for slash-command decoration. */
type SlashKind = 'skill' | 'command'

/**
 * Split one sent text into inline plain runs and reference chips.
 * @param text - the logged model text of the message or queue row.
 * @param sessionLabels - exact session mention labels associated by an adjacent recall.
 * @param slashNames - names a `/name` token may decorate as.
 * @param slashKind - the chip kind those tokens render as.
 * @returns inline nodes covering the whole text.
 */
export function projectUserText(
  text: string,
  sessionLabels: readonly string[] = [],
  slashNames: readonly string[] = [],
  slashKind: SlashKind = 'skill',
): ReactNode {
  if (text === '') return null

  const parts: ReactNode[] = []
  let lastIndex = 0
  let key = 0

  // Regex matches: wire session form `@[label](dsh-session:...)`,
  // bare @label mentions, /name tokens.
  const tokenRe = /@\[([^\]]*)\]\(dsh-session:[^)]*\)|@(\S+)|(?:^|\s)(\/(\w[\w-]*))/g
  let match: RegExpExecArray | null

  while ((match = tokenRe.exec(text)) !== null) {
    // Push preceding plain text
    const plainEnd = match.index + (match[0].startsWith('@') || match[0].startsWith('/') ? 0 : match[0].indexOf(match[3] ?? match[0]))
    if (plainEnd > lastIndex) {
      parts.push(text.slice(lastIndex, plainEnd))
    }

    if (match[1] !== undefined) {
      // Wire session form `@[label](dsh-session:...)`
      parts.push(
        <ReferenceChip key={key++} appearance="session" label={match[1]} title={match[1]} />,
      )
      lastIndex = match.index + match[0].length
    } else if (match[2] !== undefined) {
      // Bare @label mention
      const label = match[2]
      parts.push(
        <ReferenceChip
          key={key++}
          appearance="session"
          label={label}
          title={label}
        />,
      )
      lastIndex = match.index + match[0].length
    } else if (match[3] !== undefined && match[4] !== undefined) {
      // /name token — only decorate if in slashNames
      const name = match[4]
      const leadingSpace = match[3].startsWith(' ') ? ' ' : ''
      if (leadingSpace) parts.push(leadingSpace)
      if (slashNames.includes(name)) {
        parts.push(
          <ReferenceChip key={key++} appearance={slashKind} label={name} title={name} />,
        )
      } else {
        parts.push(`/${name}`)
      }
      lastIndex = match.index + match[0].length
    }
  }

  // Push trailing plain text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  if (parts.length === 0) return text
  return parts
}
