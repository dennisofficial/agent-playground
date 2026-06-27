'use client';

import type { ToolHandler, ToolItem } from '../types';
import { asRecord, basename, str } from '../util';
import { editDiffstat } from '../diffstat';
import { langFromPath } from '../highlight';
import { DiffView, TerminalBlock, WriteFileView } from '../ui';

const FILE_TOOLS = new Set(['edit', 'multiedit', 'write', 'notebookedit']);
const isWriteName = (name: string) => ['write', 'notebookedit'].includes(name.toLowerCase());

/** True for a file-creating/editing tool — used to gather these into a "N files changed" group. */
export function isFileEditTool(name: string): boolean {
  return FILE_TOOLS.has(name.toLowerCase());
}

function filePath(input: unknown): string {
  const inp = asRecord(input);
  return str(inp.file_path ?? inp.path ?? inp.notebook_path);
}

/** Expanded body: a created-file listing for a Write, or a unified diff (per edit) for an Edit. */
function FileBody({ tool }: { tool: ToolItem }) {
  const inp = asRecord(tool.input);
  const lang = langFromPath(filePath(tool.input));

  if (isWriteName(tool.name)) {
    const content = str(inp.content ?? inp.new_string);
    return content ? <WriteFileView content={content} lang={lang} /> : <TerminalBlock body="(no content)" />;
  }

  const edits = Array.isArray(inp.edits)
    ? (inp.edits as unknown[])
    : [{ old_string: inp.old_string, new_string: inp.new_string }];

  return (
    <div className="flex flex-col gap-1">
      {edits.map((e, i) => {
        const rec = asRecord(e);
        return <DiffView key={i} before={str(rec.old_string)} after={str(rec.new_string)} lang={lang} />;
      })}
    </div>
  );
}

/** Native file-editing tools: Edit / MultiEdit / Write / NotebookEdit — with a +/- diffstat badge. */
export const nativeFileHandler: ToolHandler = {
  id: 'native-file',
  match: (name) => FILE_TOOLS.has(name.toLowerCase()),
  describe: (tool) => {
    const path = filePath(tool.input);
    const isWrite = isWriteName(tool.name);
    const stat = tool.isError ? null : editDiffstat(tool.name, tool.input, tool.result);
    return {
      // Write = green file-plus; Edit = orange pencil (handoff color semantics).
      icon: isWrite ? 'write' : 'edit',
      label: isWrite ? 'Write' : 'Edit',
      arg: path,
      pathArg: true,
      preview: basename(path),
      color: isWrite ? 'var(--add)' : 'var(--accent)',
      isMcp: false,
      pill: isWrite ? 'NEW' : undefined,
      badge: tool.isError ? { kind: 'error' } : stat ? { kind: 'diffstat', ...stat } : null,
    };
  },
  Body: FileBody,
};
