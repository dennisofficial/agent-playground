import { describe, expect, it } from 'bun:test';
import { EMessageType } from '../../generated/prisma/enums.js';
import type { ToolResultPayload } from '../message.js';
import {
  EElide,
  EToolShape,
  displayToolName,
  groupHeading,
  presentTool,
  toolShape,
  type ToolCall,
} from '../tool-view.js';

/**
 * The grouping rule and the row grammar.
 *
 * These are the assertions that stop the transcript from lying: a row's measure is re-derived at draw
 * time from the STORED result, so it has to arrive at the same number the persisted summary already
 * claims — and the `gathering`/`standalone` axis decides whether a diff can end up inside a fold,
 * which is the one outcome the whole design exists to prevent.
 */

const CWD = '/Users/dennis/Developer/atlas';

function result(fields: Partial<ToolResultPayload>): ToolResultPayload {
  return {
    type: EMessageType.tool_result,
    toolUseId: 't-1',
    ok: true,
    summary: '',
    detail: [],
    ...fields,
  };
}

function call(fields: Partial<ToolCall> & { name: string }): ToolCall {
  return { input: {}, cwd: CWD, ...fields };
}

describe('EToolShape — what groups and what does not', () => {
  it('groups the tools that only gather', () => {
    for (const name of ['Read', 'NotebookRead', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch']) {
      expect(toolShape(name)).toBe(EToolShape.gathering);
    }
  });

  it('keeps every tool that changes or spawns something standalone', () => {
    // A diff draws unasked, so an edit must never end up inside a group's expansion. That property
    // comes from this list, which is why the list is asserted rather than assumed.
    for (const name of [
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Agent',
      'Task',
      'TodoWrite',
      'Skill',
    ]) {
      expect(toolShape(name)).toBe(EToolShape.standalone);
    }
  });

  it('treats a tool it has never heard of as standalone', () => {
    // Silent absorption into a group is the wrong way to discover a tool nobody classified.
    expect(toolShape('mcp__atlas__advance_phase')).toBe(EToolShape.standalone);
    expect(toolShape('SomeFutureTool')).toBe(EToolShape.standalone);
  });
});

describe('rows', () => {
  it('relativises a read against the cwd and clips a path from the FRONT', () => {
    const view = presentTool(
      call({
        name: 'Read',
        input: { file_path: `${CWD}/tui/src/domain/tool-view.ts` },
        result: result({ detail: ['a', 'b', 'c'] }),
      }),
    );
    expect(view.row.label).toBe('tui/src/domain/tool-view.ts');
    // The meaning of a path is at its end, so that end is what survives a narrow column.
    expect(view.row.elide).toBe(EElide.head);
    expect(view.row.note).toBe('3 l');
    expect(view.row.metric).toBe(3);
  });

  it('counts a read the same way the persisted summary counted it', () => {
    // `summariseToolResult` drops the empty element a trailing newline leaves behind. A row that says
    // `2 l` under a summary saying `Read 3 lines` is a contradiction the reader can see.
    const view = presentTool(
      call({ name: 'Read', input: {}, result: result({ detail: ['a', 'b', 'c', ''] }) }),
    );
    expect(view.row.note).toBe('3 l');
  });

  it('shows a bash call by its description and keeps the command for the body', () => {
    const view = presentTool(
      call({
        name: 'Bash',
        input: { command: 'ls -la\nwc -l *.ts', description: 'List and count sources' },
        result: result({ detail: ['one', 'two'] }),
      }),
    );
    expect(view.target).toBe('List and count sources');
    expect(view.row.label).toBe('List and count sources');
    // The command is not lost — it is what the opened body shows, and what gets highlighted.
    expect(view.command).toEqual(['ls -la', 'wc -l *.ts']);
  });

  it('falls back to the first line of a command when the model wrote no description', () => {
    const view = presentTool(
      call({ name: 'Bash', input: { command: 'ls -la\nwc -l' } }),
    );
    expect(view.target).toBe('ls -la …');
  });

  it('does not repeat a one-line command the header already shows verbatim', () => {
    const view = presentTool(call({ name: 'Bash', input: { command: 'ls -la' } }));
    expect(view.target).toBe('ls -la');
    expect(view.command).toEqual([]);
  });

  it('reports a failure as `failed` and reports no measure at all', () => {
    // `0 l` beside a path reads as "an empty file", which is a different and wrong fact.
    const view = presentTool(
      call({
        name: 'Read',
        input: { file_path: '/gone.ts' },
        result: result({ ok: false, summary: 'File does not exist.', detail: [] }),
      }),
    );
    expect(view.row.ok).toBe(false);
    expect(view.row.note).toBe('failed');
    expect(view.row.metric).toBeUndefined();
  });

  it('treats a call with no result yet as running, not as failed', () => {
    // Red until the result lands would flash every tool block through an error on its way to success.
    const view = presentTool(call({ name: 'Read', input: { file_path: '/a.ts' } }));
    expect(view.row.ok).toBe(true);
    expect(view.row.note).toBeUndefined();
  });

  it('borrows the engine summary for a tool with no arithmetic of its own', () => {
    const view = presentTool(
      call({
        name: 'Write',
        input: { file_path: `${CWD}/a.ts` },
        result: result({ summary: 'Wrote 129 lines' }),
      }),
    );
    expect(view.row.note).toBe('Wrote 129 lines');
  });
});

describe('groupHeading', () => {
  const rows = (...calls: ToolCall[]) =>
    calls.map((c) => ({ name: c.name, row: presentTool(c).row }));

  it('uses one tool’s own sentence when the group holds only that tool', () => {
    // Never a list of one: `read 3 files` as a clause list would read worse than the sentence.
    expect(
      groupHeading(
        rows(
          call({ name: 'Read', input: {}, result: result({ detail: ['a'] }) }),
          call({ name: 'Read', input: {}, result: result({ detail: ['a', 'b'] }) }),
        ),
      ),
    ).toBe('Read 2 files · 3 lines');
  });

  it('lists a clause per tool when the group is mixed', () => {
    expect(
      groupHeading(
        rows(
          call({ name: 'Read', input: {}, result: result({ detail: ['a', 'b'] }) }),
          call({ name: 'Bash', input: { command: 'ls' }, result: result({ detail: ['x'] }) }),
          call({ name: 'Grep', input: { pattern: 'z' }, result: result({ detail: ['1', '2'] }) }),
        ),
      ),
    ).toBe('Read 1 file, ran 1 command, searched 1 pattern · 2 lines');
  });

  it('counts only READ rows toward the line total', () => {
    // A Grep's metric counts MATCHES. Adding the two prints a number that is not a count of anything.
    const heading = groupHeading(
      rows(
        call({ name: 'Read', input: {}, result: result({ detail: ['a', 'b'] }) }),
        call({
          name: 'Grep',
          input: { pattern: 'z' },
          result: result({ detail: Array.from({ length: 90 }, () => 'hit') }),
        }),
      ),
    );
    expect(heading).toBe('Read 1 file, searched 1 pattern · 2 lines');
    expect(heading).not.toContain('92');
  });

  it('surfaces failures, which may be many rows below the heading', () => {
    expect(
      groupHeading(
        rows(
          call({ name: 'Read', input: {}, result: result({ ok: false, summary: 'gone' }) }),
          call({ name: 'Read', input: {}, result: result({ ok: false, summary: 'gone' }) }),
          call({ name: 'Read', input: {}, result: result({ detail: ['a'] }) }),
        ),
      ),
    ).toBe('Read 3 files · 1 line · 2 failed');
  });

  it('omits a measure nobody reported rather than printing a zero', () => {
    expect(groupHeading(rows(call({ name: 'Bash', input: { command: 'ls' } })))).toBe(
      'Ran 1 command',
    );
  });

  it('says nothing for no members', () => {
    expect(groupHeading([])).toBe('');
  });
});

describe('displayToolName', () => {
  it('strips the mcp bridge prefix, which is noise in a transcript', () => {
    expect(displayToolName('mcp__atlas__advance_phase')).toBe('advance_phase');
    expect(displayToolName('Read')).toBe('Read');
  });
});
