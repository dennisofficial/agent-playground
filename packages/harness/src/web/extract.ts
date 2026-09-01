import { Parser } from 'htmlparser2'
import TurndownService from 'turndown'

const STRIPPED = [
  'head',
  'title',
  'script',
  'style',
  'meta',
  'link',
  'noscript',
  'iframe',
  'object',
  'embed',
]

const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
})

turndown.remove(STRIPPED as TurndownService.TagName[])

export const htmlToMarkdown = (html: string): string => turndown.turndown(html).trim()

/**
 * Plain text without a DOM: a depth counter rather than a stack, because the only question being
 * asked of the tree is whether the cursor is currently inside something whose text is not prose.
 */
export function htmlToText(html: string): string {
  const chunks: string[] = []
  let skipDepth = 0

  const parser = new Parser({
    onopentag(name) {
      if (STRIPPED.includes(name)) skipDepth += 1
    },
    ontext(text) {
      if (skipDepth === 0) chunks.push(text)
    },
    onclosetag(name) {
      if (STRIPPED.includes(name) && skipDepth > 0) skipDepth -= 1
    },
  })

  parser.write(html)
  parser.end()

  return chunks
    .join('')
    .replaceAll(/[ \t]+/g, ' ')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()
}

export function titleOf(html: string): string | undefined {
  let found: string | undefined
  let inTitle = false

  const parser = new Parser({
    onopentag(name) {
      if (name === 'title' && found === undefined) inTitle = true
    },
    ontext(text) {
      if (inTitle) found = `${found ?? ''}${text}`
    },
    onclosetag(name) {
      if (name === 'title') inTitle = false
    },
  })

  parser.write(html)
  parser.end()

  const trimmed = found?.replaceAll(/\s+/g, ' ').trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}
