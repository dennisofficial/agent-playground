'use client';

import { useState } from 'react';

/**
 * Tool-call rendering for the conversation — ported from the "Atlas Conversation View" handoff.
 *
 * Consecutive tool calls collapse into ONE group ("N tools called" + a preview of names). Each row is
 * type-aware: Bash/Read/Grep/Edit get their own icon + the key argument inline; everything else (the
 * host/MCP tools — get_pipeline_state, recall, submit_plan, …) renders as a blue "mcp · name" row.
 * Expanding a row reveals its output — a dark terminal block for shell/file tools, a light panel for the
 * structured MCP results.
 */

export interface ToolItem {
  key: string;
  name: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
  running?: boolean;
}

const Chevron = ({ size = 11, className = '' }: { size?: number; className?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`shrink-0 transition-transform ${className}`}
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

type IconKind = 'bash' | 'read' | 'edit' | 'grep' | 'mcp';

function ToolIcon({ kind, color }: { kind: IconKind; color: string }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    style: { flex: 'none' as const },
  };
  switch (kind) {
    case 'bash':
      return (
        <svg {...common}>
          <path d="M4 17l6-5-6-5" />
          <path d="M13 19h7" />
        </svg>
      );
    case 'read':
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
          <path d="M14 2v6h6" />
        </svg>
      );
    case 'edit':
      return (
        <svg {...common}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      );
    case 'grep':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
      );
    case 'mcp':
    default:
      return (
        <svg {...common}>
          <path d="M9 2v6" />
          <path d="M15 2v6" />
          <path d="M6 8h12v3a6 6 0 0 1-12 0Z" />
          <path d="M12 17v5" />
        </svg>
      );
  }
}

interface ToolVisual {
  /** Bold label for known tools; empty for MCP rows (the name takes the inline slot). */
  label: string;
  /** The key argument shown inline (command / path / pattern), or the MCP tool name. */
  arg: string;
  /** Short token for the group preview line. */
  preview: string;
  icon: IconKind;
  color: string;
  isMcp: boolean;
  /** Output renders as a dark terminal block (shell/file) vs. a light panel (structured MCP result). */
  terminal: boolean;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
}

function basename(path: string): string {
  const clean = path.split('?')[0].replace(/\/+$/, '');
  const parts = clean.split('/');
  return parts[parts.length - 1] || clean;
}

/** Pretty MCP name: `mcp__server__do_thing` / `do_thing` → `do_thing`. */
function mcpName(name: string): string {
  const segs = name.split('__').filter(Boolean);
  return segs[segs.length - 1] || name;
}

/** Map a tool name + input to its visual treatment. */
function describeTool(name: string, input: unknown): ToolVisual {
  const inp = asRecord(input);
  const base = (n: string) => n.toLowerCase();
  switch (base(name)) {
    case 'bash': {
      const cmd = str(inp.command);
      return { label: 'Bash', arg: cmd, preview: cmd, icon: 'bash', color: 'var(--accent)', isMcp: false, terminal: true };
    }
    case 'read': {
      const p = str(inp.file_path ?? inp.path ?? inp.notebook_path);
      return { label: 'Read', arg: p, preview: basename(p), icon: 'read', color: 'var(--dim)', isMcp: false, terminal: true };
    }
    case 'edit':
    case 'multiedit':
    case 'write':
    case 'notebookedit': {
      const p = str(inp.file_path ?? inp.path ?? inp.notebook_path);
      const label = base(name) === 'write' ? 'Write' : 'Edit';
      return { label, arg: p, preview: basename(p), icon: 'edit', color: 'var(--dim)', isMcp: false, terminal: false };
    }
    case 'grep': {
      const pat = str(inp.pattern);
      return { label: 'Grep', arg: pat, preview: pat, icon: 'grep', color: 'var(--accent)', isMcp: false, terminal: true };
    }
    case 'glob': {
      const pat = str(inp.pattern);
      return { label: 'Glob', arg: pat, preview: pat, icon: 'grep', color: 'var(--dim)', isMcp: false, terminal: true };
    }
    default: {
      const n = mcpName(name);
      return { label: '', arg: n, preview: n, icon: 'mcp', color: 'var(--blue)', isMcp: true, terminal: false };
    }
  }
}

/** Format a tool input/result for display (object → JSON, string → as-is), truncated. */
function formatPayload(value: unknown): string {
  if (value == null) return '';
  let out: string;
  if (typeof value === 'string') out = value;
  else {
    try {
      out = JSON.stringify(value, null, 2);
    } catch {
      out = String(value);
    }
  }
  return out.length > 4000 ? `${out.slice(0, 4000)}\n… (truncated)` : out;
}

/** Count badge from a result string ("8 ln") — omitted when single-line / empty. */
function lineBadge(result: unknown): string {
  const s = typeof result === 'string' ? result : '';
  if (!s.trim()) return '';
  const n = s.replace(/\n$/, '').split('\n').length;
  return n > 1 ? `${n} ln` : '';
}

function ToolRow({ tool }: { tool: ToolItem }) {
  const [open, setOpen] = useState(false);
  const v = describeTool(tool.name, tool.input);
  const inputStr = formatPayload(tool.input);
  const resultStr = formatPayload(tool.result);
  const hasBody = Boolean((v.isMcp && inputStr) || resultStr || tool.isError);
  const badge = tool.isError ? 'error' : lineBadge(tool.result);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[12.5px] text-dim transition hover:bg-surface-3"
      >
        <ToolIcon kind={v.icon} color={v.color} />
        {v.isMcp ? (
          <span className="flex-1 truncate font-mono text-[11.5px]" style={{ color: 'var(--blue)' }}>
            <span className="text-faint">mcp · </span>
            {v.arg}
          </span>
        ) : (
          <>
            <span className="shrink-0 font-semibold text-text">{v.label}</span>
            <span className="flex-1 truncate font-mono text-[11.5px]">{v.arg}</span>
          </>
        )}
        {badge ? (
          <span className="shrink-0 font-mono text-[10px]" style={{ color: tool.isError ? 'var(--red)' : 'var(--faint)' }}>
            {badge}
          </span>
        ) : null}
        {tool.running ? (
          <span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--accent)' }} />
        ) : null}
        <Chevron className={`text-faint ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && hasBody ? (
        <ToolOutput terminal={v.terminal} isMcp={v.isMcp} input={inputStr} result={resultStr} isError={tool.isError} />
      ) : null}
    </div>
  );
}

function ToolOutput({
  terminal,
  isMcp,
  input,
  result,
  isError,
}: {
  terminal: boolean;
  isMcp: boolean;
  input: string;
  result: string;
  isError?: boolean;
}) {
  const body = result || (isError ? '(error)' : '(no output)');
  if (terminal && !isError) {
    return (
      <pre
        className="my-[3px] ml-0 overflow-x-auto whitespace-pre-wrap break-words rounded-[7px] px-[11px] py-[9px] font-mono text-[10.5px] leading-[1.8]"
        style={{ background: 'var(--term)', color: 'var(--term-dim)' }}
      >
        {body}
      </pre>
    );
  }
  return (
    <div
      className="my-[3px] space-y-1.5 rounded-[7px] border border-border px-[11px] py-[9px] font-mono text-[11px] leading-relaxed text-dim"
      style={{ background: 'var(--panel)' }}
    >
      {isMcp && input ? (
        <div>
          <span className="text-faint">input</span>
          <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-words">{input}</pre>
        </div>
      ) : null}
      <div>
        <span className="text-faint">{isError ? 'error' : 'result'}</span>
        <pre
          className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-words"
          style={isError ? { color: 'var(--red)' } : undefined}
        >
          {body}
        </pre>
      </div>
    </div>
  );
}

/** A run of consecutive tool calls, collapsed into one group. Open by default while any tool is running. */
export function ToolGroup({ tools }: { tools: ToolItem[] }) {
  const anyRunning = tools.some((t) => t.running);
  const [open, setOpen] = useState(anyRunning);
  const preview = tools.map((t) => describeTool(t.name, t.input).preview).filter(Boolean).join(' · ');
  const count = tools.length;

  return (
    <div className="anim-fadeUp my-px">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-[7px] px-0.5 py-[5px] text-left text-[12.5px]"
      >
        <Chevron size={12} className={`text-faint ${open ? 'rotate-90' : ''}`} />
        <span className="shrink-0 font-semibold text-dim transition group-hover:text-text">
          {count} {count === 1 ? 'tool' : 'tools'} called
        </span>
        <span className="flex-1 truncate font-mono text-[11px] text-faint">{preview}</span>
        {anyRunning ? (
          <span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--accent)' }} />
        ) : null}
      </button>
      {open ? (
        <div
          className="ml-[5px] flex flex-col gap-px pl-[13px]"
          style={{ borderLeft: '1.5px solid var(--border)' }}
        >
          {tools.map((t) => (
            <ToolRow key={t.key} tool={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
}