import { marked, type Tokens } from 'marked'

export type MarkdownSegment =
  | { readonly kind: 'prose'; readonly text: string }
  | { readonly kind: 'fence'; readonly language: string; readonly source: string }
  | { readonly kind: 'table'; readonly markdown: string }

export function segmentMarkdown(source: string): readonly MarkdownSegment[] {
  const segments: MarkdownSegment[] = []
  let prose = ''

  for (const token of marked.lexer(source)) {
    if (token.type === 'table') {
      if (prose) {
        segments.push({ kind: 'prose', text: prose })
        prose = ''
      }
      segments.push({ kind: 'table', markdown: token.raw })
      continue
    }

    if (token.type === 'code') {
      if (prose) {
        segments.push({ kind: 'prose', text: prose })
        prose = ''
      }
      segments.push(fenceSegment(token as Tokens.Code))
    } else {
      prose += token.raw
    }
  }
  if (prose) segments.push({ kind: 'prose', text: prose })

  return segments
}

function fenceSegment(token: Tokens.Code): MarkdownSegment {
  return {
    kind: 'fence',
    language: token.lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? '',
    // marked leaves a trailing newline on 4-space-indented blocks but not on backtick fences.
    source: token.text.replace(/\n$/, ''),
  }
}
