'use client';

import type { IconKind, ToolDescriptor, ToolHandler, ToolItem } from '../types';
import { asRecord, basename, formatPayload, resultLineCount, str } from '../util';
import { langFromPath } from '../highlight';
import { GrepView, PathListView, ReadFileView, TerminalBlock } from '../ui';

const SEARCH_TOOLS = new Set(['read', 'grep', 'glob']);

/** True when most lines look like ripgrep's single-file `<n>:match` / `<n>-context` output. */
function isNumberedGrep(result: string): boolean {
  const lines = result.split('\n').filter((l) => l.trim() && l !== '--');
  if (!lines.length) return false;
  return lines.filter((l) => /^\d+[:-]/.test(l)).length / lines.length >= 0.7;
}

/**
 * Read renders as a syntax-highlighted file listing (Claude Code returns `<n>\t<line>`). Grep in
 * single-file `-n` content mode (`<n>:match`) renders highlighted too; Glob renders as a path list;
 * everything else (grep files-with-matches / multi-file) stays a plain terminal block.
 */
function SearchBody({ tool }: { tool: ToolItem }) {
  const body = formatPayload(tool.result);
  if (!body) return <TerminalBlock body={tool.isError ? '(error)' : '(no output)'} />;
  if (tool.isError) return <TerminalBlock body={body} />;
  const name = tool.name.toLowerCase();
  const inp = asRecord(tool.input);
  if (name === 'read') {
    return <ReadFileView result={body} lang={langFromPath(str(inp.file_path ?? inp.path ?? inp.notebook_path))} />;
  }
  if (name === 'grep' && str(inp.output_mode) === 'content' && isNumberedGrep(body)) {
    return <GrepView result={body} lang={langFromPath(str(inp.path))} />;
  }
  if (name === 'glob') return <PathListView result={body} />;
  return <TerminalBlock body={body} />;
}

/** Read / Grep / Glob — file reads and content/path searches. Only Read carries a line-count pill. */
export const nativeSearchHandler: ToolHandler = {
  id: 'native-search',
  match: (name) => SEARCH_TOOLS.has(name.toLowerCase()),
  describe: (tool): ToolDescriptor => {
    const inp = asRecord(tool.input);
    const name = tool.name.toLowerCase();
    const errBadge: ToolDescriptor['badge'] = tool.isError ? { kind: 'error' } : null;

    if (name === 'read') {
      // Only Read carries the gray line-count pill — it's a genuine "N lines read from a file".
      const n = resultLineCount(tool.result);
      const badge: ToolDescriptor['badge'] = tool.isError ? { kind: 'error' } : n ? { kind: 'lines', n } : null;
      const p = str(inp.file_path ?? inp.path ?? inp.notebook_path);
      return { icon: 'read', label: 'Read', arg: p, pathArg: true, preview: basename(p), color: 'var(--dim)', isMcp: false, badge };
    }
    const pat = str(inp.pattern);
    const icon: IconKind = 'grep';
    const color = name === 'grep' ? 'var(--accent)' : 'var(--dim)';
    const label = name === 'grep' ? 'Grep' : 'Glob';
    return { icon, label, arg: pat, preview: pat, color, isMcp: false, badge: errBadge };
  },
  Body: SearchBody,
};
