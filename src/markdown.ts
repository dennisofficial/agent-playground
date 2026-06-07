import { marked, type MarkedExtension } from 'marked';
import { markedTerminal } from 'marked-terminal';

// Configure marked once to emit ANSI-styled terminal output.
// `@types/marked-terminal` (v6-era) mislabels markedTerminal()'s return as a Renderer;
// in v7 it returns a MarkedExtension for marked.use(). Cast to bridge the stale types.
marked.use(markedTerminal() as MarkedExtension);

/** Render a markdown string to ANSI-styled terminal text (trailing newlines trimmed). */
export function renderMarkdown(md: string): string {
  return (marked.parse(md) as string).replace(/\s+$/, '');
}
