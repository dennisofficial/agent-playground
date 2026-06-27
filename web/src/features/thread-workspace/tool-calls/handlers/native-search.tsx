'use client';

import type { IconKind, ToolDescriptor, ToolHandler, ToolItem } from '../types';
import { asRecord, basename, formatPayload, resultLineCount, str } from '../util';
import { TerminalBlock } from '../ui';

const SEARCH_TOOLS = new Set(['read', 'grep', 'glob']);

function SearchBody({ tool }: { tool: ToolItem }) {
  const body = formatPayload(tool.result) || (tool.isError ? '(error)' : '(no output)');
  return <TerminalBlock body={body} />;
}

/** Read / Grep / Glob — file reads and content/path searches. */
export const nativeSearchHandler: ToolHandler = {
  id: 'native-search',
  match: (name) => SEARCH_TOOLS.has(name.toLowerCase()),
  describe: (tool): ToolDescriptor => {
    const inp = asRecord(tool.input);
    const name = tool.name.toLowerCase();
    const n = resultLineCount(tool.result);
    const badge: ToolDescriptor['badge'] = tool.isError ? { kind: 'error' } : n ? { kind: 'lines', n } : null;

    if (name === 'read') {
      const p = str(inp.file_path ?? inp.path ?? inp.notebook_path);
      return { icon: 'read', label: 'Read', arg: p, preview: basename(p), color: 'var(--dim)', isMcp: false, badge };
    }
    const pat = str(inp.pattern);
    const icon: IconKind = 'grep';
    const color = name === 'grep' ? 'var(--accent)' : 'var(--dim)';
    const label = name === 'grep' ? 'Grep' : 'Glob';
    return { icon, label, arg: pat, preview: pat, color, isMcp: false, badge };
  },
  Body: SearchBody,
};
