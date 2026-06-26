'use client';

import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Markdown renderer for assistant prose in the conversation — ported from the "Atlas Conversation View"
 * handoff. Component overrides (not the typography plugin) so headings use the display font, code blocks
 * get the dark terminal treatment, and tables/blockquotes/lists match the mock pixel-for-pixel.
 */

function CodeBlock({ lang, children }: { lang?: string; children: ReactNode }) {
  return (
    <div className="my-3 overflow-hidden rounded-[9px] border border-border" style={{ background: 'var(--term)' }}>
      <div
        className="flex items-center gap-2 px-3 py-[7px]"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: '#ff5f57' }} />
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: '#febc2e' }} />
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: '#28c840' }} />
        <span className="flex-1" />
        {lang ? (
          <span className="font-mono text-[10px] lowercase" style={{ color: 'var(--term-dim)' }}>
            {lang}
          </span>
        ) : null}
      </div>
      <pre
        className="m-0 overflow-x-auto px-[14px] py-3 font-mono text-[11.5px] leading-[1.7]"
        style={{ color: 'var(--term-fg)' }}
      >
        {children}
      </pre>
    </div>
  );
}

const COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mb-1 mt-1 font-disp text-[21px] font-bold leading-tight tracking-[-0.02em] text-text">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-[18px] font-disp text-[16.5px] font-bold tracking-[-0.01em] text-text">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-3.5 font-disp text-[14px] font-bold tracking-[-0.01em] text-text">{children}</h3>
  ),
  p: ({ children }) => <p className="my-2 text-[14px] leading-[1.62] text-text first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent"
      style={{ textDecoration: 'none', borderBottom: '1px solid var(--accent-line)' }}
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-2 flex list-disc flex-col gap-1.5 pl-5 text-[14px] leading-[1.5]">{children}</ul>,
  ol: ({ children }) => (
    <ol className="my-2 flex list-decimal flex-col gap-1.5 pl-5 text-[14px] leading-[1.5]">{children}</ol>
  ),
  li: ({ children }) => <li className="marker:text-accent">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote
      className="my-3 rounded-r-[7px] px-3.5 py-2 text-[13px] italic leading-[1.55] text-dim"
      style={{ borderLeft: '3px solid var(--accent-line)', background: 'var(--accent-soft)' }}
    >
      {children}
    </blockquote>
  ),
  hr: () => <div className="my-4 h-px" style={{ background: 'var(--border)' }} />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  th: ({ children }) => (
    <th
      className="px-3 py-1.5 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-faint"
      style={{ borderBottom: '1.5px solid var(--border-2)' }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-2 align-top text-dim" style={{ borderBottom: '1px solid var(--border)' }}>
      {children}
    </td>
  ),
  code: ({ className, children }) => {
    const text = String(children ?? '');
    const match = /language-(\w+)/.exec(className ?? '');
    const isBlock = Boolean(match) || text.includes('\n');
    if (isBlock) return <CodeBlock lang={match?.[1]}>{children}</CodeBlock>;
    return (
      <code
        className="rounded-[3px] px-[5px] py-px font-mono text-[12px]"
        style={{ background: 'var(--surface-3)' }}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => <>{children}</>,
};

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="text-[14px] leading-[1.62] text-text">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
