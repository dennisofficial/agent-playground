'use client';

import type { ToolHandler, ToolItem } from '../types';
import { asRecord, formatPayload, resultLineCount, str } from '../util';
import { TerminalBlock } from '../ui';

function ShellBody({ tool }: { tool: ToolItem }) {
  const body = formatPayload(tool.result) || (tool.isError ? '(error)' : '(no output)');
  return <TerminalBlock body={body} />;
}

/** Bash — shell command + terminal output. */
export const nativeShellHandler: ToolHandler = {
  id: 'native-shell',
  match: (name) => name.toLowerCase() === 'bash',
  describe: (tool) => {
    const cmd = str(asRecord(tool.input).command);
    const n = resultLineCount(tool.result);
    return {
      icon: 'bash',
      label: 'Bash',
      arg: cmd,
      preview: cmd,
      color: 'var(--accent)',
      isMcp: false,
      badge: tool.isError ? { kind: 'error' } : n ? { kind: 'lines', n } : null,
    };
  },
  Body: ShellBody,
};
