import { inlinable, type SaidImage } from '@dltech/atlas-core'
import { generateText, type LanguageModel, type ModelMessage } from 'ai'

const TITLE_INSTRUCTION = [
  'You name coding sessions.',
  "You are given the developer's opening message, or an excerpt of the session so far.",
  'The opening message may come with files excerpted or pictures attached to it. Name the work they show, never the fact that something was attached.',
  'An excerpt opens at the start of the session and ends with what was said most recently.',
  'Sessions drift, so when the end disagrees with the beginning, name what the session is about now.',
  'Two to five words. Name the task, never the developer.',
  'Reply with the name alone — no quotes, no trailing punctuation, no preamble.',
].join(' ')

const PROMPT_CHARACTER_LIMIT = 2000
const TITLE_OUTPUT_TOKEN_LIMIT = 32
const TITLE_WORD_LIMIT = 6
const TITLE_CHARACTER_LIMIT = 48

const WRAPPING_QUOTES = /^["'“”‘’`]+|["'“”‘’`]+$/g
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

const withinCharacterLimit = (title: string): string => {
  if (title.length <= TITLE_CHARACTER_LIMIT) return title

  const cut = title.slice(0, TITLE_CHARACTER_LIMIT)
  const lastSpace = cut.lastIndexOf(' ')
  return lastSpace === -1 ? cut : cut.slice(0, lastSpace)
}

export function sanitizedTitle(generated: string): string | null {
  const collapsed = generated.replace(/\s+/g, ' ').trim()
  const unquoted = collapsed.replace(WRAPPING_QUOTES, '').trim()
  const unpunctuated = unquoted.replace(TRAILING_PUNCTUATION, '').trim()
  if (unpunctuated.length === 0) return null

  const words = unpunctuated.split(' ').slice(0, TITLE_WORD_LIMIT).join(' ')
  const title = withinCharacterLimit(words).trim()

  return title.length === 0 ? null : title
}

const askWithImages = (args: { asked: string; images: readonly SaidImage[] }): ModelMessage[] => [
  {
    role: 'user',
    content: [
      ...(args.asked.length === 0 ? [] : [{ type: 'text' as const, text: args.asked }]),
      ...args.images.map((image) => ({
        type: 'file' as const,
        data: image.data,
        mediaType: image.mediaType,
      })),
    ],
  },
]

export async function titleFor(args: {
  model: LanguageModel
  text: string
  images?: readonly SaidImage[] | undefined
  signal?: AbortSignal | undefined
}): Promise<string | null> {
  const asked = args.text.trim().slice(0, PROMPT_CHARACTER_LIMIT)
  const shown = (args.images ?? []).filter((image) => inlinable(image))
  if (asked.length === 0 && shown.length === 0) return null

  try {
    const generated = await generateText({
      model: args.model,
      system: TITLE_INSTRUCTION,
      ...(shown.length === 0 ? { prompt: asked } : { messages: askWithImages({ asked, images: shown }) }),
      maxOutputTokens: TITLE_OUTPUT_TOKEN_LIMIT,
      ...(args.signal === undefined ? {} : { abortSignal: args.signal }),
    })

    return sanitizedTitle(generated.text)
  } catch {
    return null
  }
}
