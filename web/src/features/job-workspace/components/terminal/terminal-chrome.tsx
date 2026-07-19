'use client';

import { Check, Copy, WrapText } from 'lucide-react';
import { useState, type ReactNode } from 'react';

/**
 * Shared chrome for the dark "terminal" frame used across the job workspace — the conversation-prose code
 * fences ({@link CodeBlock} in `markdown.tsx`) and the tool-call result blocks ({@link TerminalBlock} et al.
 * in `tool-calls/ui.tsx`) both build the same macOS-window shell (traffic-light dots + lowercase label) and
 * the same copy-to-clipboard affordance, so it lives here once instead of being re-typed per renderer.
 */

/** Copy-to-clipboard with a 1.5s "copied" confirmation flash. */
export function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return [copied, copy];
}

/** A header-bar action button styled for the dark terminal frame (light-frame chrome uses `FrameBtn`). */
export function TermBtn({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex shrink-0 items-center gap-1 rounded-[5px] px-1.5 py-0.5 font-mono text-[10px] lowercase transition-colors hover:bg-[rgba(255,255,255,0.08)]"
      style={{ color: 'var(--term-dim)' }}
    >
      {children}
    </button>
  );
}

/** The Copy action for a terminal frame — writes `text` and flips to a ✓ flash. */
export function CopyButton({ text }: { text: string }) {
  const [copied, copy] = useCopied();
  return (
    <TermBtn title="Copy to clipboard" onClick={() => copy(text)}>
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? 'copied' : 'copy'}
    </TermBtn>
  );
}

/** The Wrap toggle — flips a body between horizontal-scroll and line-wrapping. */
export function WrapButton({ wrapped, onToggle }: { wrapped: boolean; onToggle: () => void }) {
  return (
    <TermBtn title={wrapped ? 'Disable line wrapping' : 'Wrap long lines'} onClick={onToggle}>
      <WrapText size={10} />
      {wrapped ? 'nowrap' : 'wrap'}
    </TermBtn>
  );
}

/**
 * The macOS-window title bar shared by every dark terminal frame: three traffic-light dots, an optional
 * lowercase `label` (left, next to the dots), and a right-aligned `actions` slot (Copy / Wrap / …).
 */
export function TerminalChromeBar({ label, actions }: { label?: string; actions?: ReactNode }) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.75"
      style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: '#ff5f57' }} />
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: '#febc2e' }} />
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: '#28c840' }} />
      {label ? (
        <span className="font-mono text-[10px] lowercase" style={{ color: 'var(--term-dim)' }}>
          {label}
        </span>
      ) : null}
      <span className="flex-1" />
      {actions}
    </div>
  );
}
