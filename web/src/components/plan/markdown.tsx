'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Mermaid } from './mermaid';

// Matches a fenced ```mermaid block, capturing its body. Global + multiline.
const MERMAID_FENCE = /```mermaid[^\n]*\n([\s\S]*?)```/g;

type Part = { type: 'md' | 'mermaid'; content: string };

/** Split markdown into prose runs and mermaid-fence runs (predictable: no code/pre wrapping games). */
function splitMermaid(markdown: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  const re = new RegExp(MERMAID_FENCE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    if (m.index > last) {
      parts.push({ type: 'md', content: markdown.slice(last, m.index) });
    }
    parts.push({ type: 'mermaid', content: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < markdown.length) {
    parts.push({ type: 'md', content: markdown.slice(last) });
  }
  return parts;
}

/**
 * Renders plan markdown as a readable document. Any ```mermaid fence the planner authored is pulled
 * out and rendered as a real diagram; everything else renders as GitHub-flavored markdown (Tailwind
 * Typography prose).
 */
export function PlanMarkdown({ markdown }: { markdown: string }) {
  const parts = splitMermaid(markdown);
  return (
    <div className="prose prose-sm prose-zinc max-w-none dark:prose-invert">
      {parts.map((p, i) =>
        p.type === 'mermaid' ? (
          <Mermaid key={i} chart={p.content} />
        ) : (
          <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>
            {p.content}
          </ReactMarkdown>
        ),
      )}
    </div>
  );
}
