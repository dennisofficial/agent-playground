'use client';

import type { ToolHandler, ToolItem } from '../types';
import { asRecord, formatPayload, str } from '../util';
import { TerminalBlock } from '../ui';

function ShellBody({ tool }: { tool: ToolItem }) {
  const command = str(asRecord(tool.input).command);
  const body = formatPayload(tool.result) || (tool.isError ? '(error)' : '(no output)');
  return <TerminalBlock body={body} chrome label="bash" command={command} />;
}

/** Bash — shell command + terminal output, rendered as a macOS terminal with the command as a prompt. */
export const nativeShellHandler: ToolHandler = {
  id: 'native-shell',
  match: (name) => name.toLowerCase() === 'bash',
  describe: (tool) => {
    const cmd = str(asRecord(tool.input).command);
    // No line-count pill — shell output isn't a file read, so the count isn't meaningful to thread.
    return {
      icon: 'bash',
      label: 'Bash',
      arg: cmd,
      preview: cmd,
      color: 'var(--accent)',
      isMcp: false,
      badge: tool.isError ? { kind: 'error' } : null,
    };
  },
  Body: ShellBody,
};
