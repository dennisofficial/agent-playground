import { marked, type MarkedExtension, type Token } from 'marked';
import { markedTerminal } from 'marked-terminal';

// Configure marked once to emit ANSI-styled terminal output.
// `@types/marked-terminal` (v6-era) mislabels markedTerminal()'s return as a Renderer;
// in v7 it returns a MarkedExtension for marked.use(). Cast to bridge the stale types.
marked.use(markedTerminal() as MarkedExtension);

/**
 * Return true when the marked lexer sees the input as nothing but plain prose —
 * i.e. every block-level token is either a paragraph (whose inline tokens are
 * all plain `text` or `space`) or a top-level `space` (blank lines between
 * paragraphs).
 *
 * This catches the class of inputs where marked-terminal would mangle the text:
 *   • "4."  → parsed as an ordered list  → rendered as "    *"
 *   • "---" → parsed as an <hr>          → rendered as ""
 * while correctly passing through strings that genuinely contain markdown so
 * they still get styled.
 */
function isPlainText(md: string): boolean {
  const tokens = marked.lexer(md);
  return tokens.every((token: Token) => {
    // Top-level blank lines between paragraphs are harmless.
    if (token.type === 'space') return true;
    // Any non-paragraph block (heading, list, hr, blockquote, code…) → has markdown.
    if (token.type !== 'paragraph') return false;
    // Paragraph is plain only when every inline token is bare text (no strong,
    // em, codespan, link, image, html, …).
    const para = token as Extract<Token, { type: 'paragraph' }>;
    return para.tokens.every(
      (t: Token) => t.type === 'text' || t.type === 'space',
    );
  });
}

/** Render a markdown string to ANSI-styled terminal text (trailing newlines trimmed).
 *
 * Short-circuit: if the input is plain prose (no markdown syntax recognised by
 * the marked lexer) return it as-is.  This prevents marked-terminal from
 * misinterpreting things like "4." as a bullet point or "---" as a horizontal
 * rule and mangling the output.
 */
export function renderMarkdown(md: string): string {
  if (isPlainText(md)) return md;
  return (marked.parse(md) as string).replace(/\s+$/, '');
}
