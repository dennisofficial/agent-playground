import {
  detectLineEnding,
  endingOfRegion,
  lineEndingAgnosticPattern,
  toLf,
  withLineEnding,
} from './file-text'

export type Replacement = { ok: true; content: string } | { ok: false; reason: string }

/**
 * The edit tool's match-and-replace, on a string rather than a file, so a multi-edit pass can run
 * the same rules several times before anything is written.
 */
export function replaceInContent(args: {
  content: string
  oldString: string
  newString: string
  replaceAll: boolean
}): Replacement {
  const pattern = lineEndingAgnosticPattern(args.oldString)

  const matches = [...args.content.matchAll(new RegExp(pattern, 'g'))].length
  if (matches === 0) {
    return { ok: false, reason: `String to replace not found in file.\nString: ${args.oldString}` }
  }
  if (matches > 1 && !args.replaceAll) {
    return {
      ok: false,
      reason: `Found ${matches} matches of the string to replace, but replaceAll is false. To replace all occurrences, set replaceAll to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${args.oldString}`,
    }
  }

  const fallback = detectLineEnding(args.content)
  const replacement = toLf(args.newString)
  const rewritten = args.content.replace(
    new RegExp(pattern, args.replaceAll ? 'g' : ''),
    (region) => withLineEnding({ content: replacement, ending: endingOfRegion({ region, fallback }) }),
  )

  if (rewritten === args.content) {
    return { ok: false, reason: 'oldString and newString are identical; the file would not change.' }
  }

  return { ok: true, content: rewritten }
}
