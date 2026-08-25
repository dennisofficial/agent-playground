import { marked, type Tokens } from 'marked';

/**
 * A markdown document, cut along fence boundaries. This exists so a transcript renderer can hand
 * each half to a different component — prose to the markdown renderer, fenced code to a
 * per-language code view (with its own scroll/copy affordances) — without either side having to
 * know how to render the other's content.
 */
export type MarkdownSegment =
  | { readonly kind: 'prose'; readonly text: string }
  | { readonly kind: 'fence'; readonly language: string; readonly source: string }
  /**
   * A table, kept whole and separate for the same reason a fence is: it has a natural width and
   * reflowing it to the viewport destroys it. Squeezing columns to fit turns `Engine` into `Engin`
   * over `e`, so a wide table scrolls sideways instead — which needs it out of the prose stream.
   *
   * `markdown` is the table's original source, because the renderer that draws it is the same one
   * that draws prose; only its width constraint differs.
   */
  | { readonly kind: 'table'; readonly markdown: string };

/**
 * Splits on `marked`'s top-level token stream rather than regexing for ``` fences, so nesting
 * (fences inside blockquotes/lists) and edge cases (unterminated fences, 4-space-indented code)
 * are marked's problem, not ours — it already has to get those right to lex correctly.
 *
 * Only LEXES, never renders: a `code` token becomes a `fence` segment carrying its own
 * language/source, and every other top-level token is reassembled from `raw` text and coalesced
 * into a single `prose` segment, so a renderer downstream (`renderMarkdown`) still sees the exact
 * source it would have gotten directly — round-tripping through this split cannot lose or reflow
 * anything.
 */
export function segmentMarkdown(source: string): readonly MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let prose = '';

  for (const token of marked.lexer(source)) {
    if (token.type === 'table') {
      if (prose) {
        segments.push({ kind: 'prose', text: prose });
        prose = '';
      }
      segments.push({ kind: 'table', markdown: token.raw });
      continue;
    }

    if (token.type === 'code') {
      if (prose) {
        segments.push({ kind: 'prose', text: prose });
        prose = '';
      }
      segments.push(fenceSegment(token as Tokens.Code));
    } else {
      prose += token.raw;
    }
  }
  if (prose) segments.push({ kind: 'prose', text: prose });

  return segments;
}

function fenceSegment(token: Tokens.Code): MarkdownSegment {
  return {
    kind: 'fence',
    language: token.lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? '',
    // Backtick-fenced bodies come pre-trimmed, but marked leaves a trailing newline on
    // 4-space-indented blocks — strip it so both fence flavours yield the same shape.
    source: token.text.replace(/\n$/, ''),
  };
}
