const SNIFFED_CHARACTERS = 240

const ASKS_ON_THE_LAST_LINE = /[:?>$#\]]$/

const ASKS_IN_WORDS: readonly RegExp[] = [
  /\((?:y(?:es)?\/n(?:o)?|[yn]\/[yn])\)/i,
  /\bpass(?:word|phrase)\b/i,
  /\bpress\s+(?:enter|return|any\s+key)\b/i,
  /\b(?:proceed|continue|overwrite|are\s+you\s+sure)\b[^\n]*\?/i,
  /\bselect\s+(?:an?\s+)?option\b/i,
]

/**
 * A process waiting on stdin leaves the cursor on the prompt line, so its output ends without a
 * newline. That is the load-bearing signal; the wording tests only narrow it further.
 */
export function looksLikePrompt(text: string): boolean {
  if (text === '' || text.endsWith('\n')) return false

  const sniffed = text.slice(-SNIFFED_CHARACTERS)
  const lastLine = sniffed.slice(sniffed.lastIndexOf('\n') + 1).trimEnd()
  if (lastLine === '') return false

  if (ASKS_IN_WORDS.some((asks) => asks.test(lastLine))) return true
  return ASKS_ON_THE_LAST_LINE.test(lastLine)
}
