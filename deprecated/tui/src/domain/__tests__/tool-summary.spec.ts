import { describe, expect, it } from 'bun:test';
import { relativise, summariseToolResult, toolTarget } from '../tool-summary.js';

describe('toolTarget', () => {
  it.each([
    ['Read', { file_path: '/repo/src/a.ts' }, 'src/a.ts'],
    ['Bash', { command: 'pnpm test steer' }, 'pnpm test steer'],
    ['Grep', { pattern: 'drain' }, 'drain'],
    ['Glob', { pattern: '**/*.ts' }, '**/*.ts'],
    ['WebFetch', { url: 'https://example.com' }, 'https://example.com'],
    ['Task', { description: 'find flaky tests' }, 'find flaky tests'],
  ])('%s renders its defining argument', (name, input, expected) => {
    expect(toolTarget(name, input, '/repo')).toBe(expected);
  });

  it('returns undefined when a tool has no self-describing argument', () => {
    expect(toolTarget('Unknown', {}, '/repo')).toBeUndefined();
  });

  it('leaves paths outside the project root absolute', () => {
    expect(relativise('/elsewhere/a.ts', '/repo')).toBe('/elsewhere/a.ts');
  });
});

describe('summariseToolResult', () => {
  it('claims what happened rather than echoing the first line of output', () => {
    expect(
      summariseToolResult({ name: 'Read', input: {}, lines: ['a', 'b', 'c'], ok: true }).summary,
    ).toBe('Read 3 lines');
  });

  it('does not count a trailing newline as a line of content', () => {
    expect(
      summariseToolResult({ name: 'Read', input: {}, lines: ['a', 'b', ''], ok: true }).summary,
    ).toBe('Read 2 lines');
  });

  it('pulls the addition/removal counts out of an edit confirmation', () => {
    const result = summariseToolResult({
      name: 'Edit',
      input: {},
      lines: ['Applied 6 additions and 2 removals to a.ts'],
      ok: true,
    });
    expect(result.summary).toBe('Updated with 6 additions and 2 removals');
  });

  it('falls back to a plain label when the edit output has no counts', () => {
    expect(
      summariseToolResult({ name: 'Edit', input: {}, lines: ['done'], ok: true }).summary,
    ).toBe('Updated file');
  });

  it('uses the tool’s own first line for Bash', () => {
    const result = summariseToolResult({
      name: 'Bash',
      input: {},
      lines: ['PASS steer.spec.ts (4)', 'extra', 'more'],
      ok: true,
    });
    expect(result).toEqual({ summary: 'PASS steer.spec.ts (4)', detail: ['extra', 'more'] });
  });

  it('keeps failure output whatever the tool was — the first line is the reason', () => {
    const result = summariseToolResult({
      name: 'Read',
      input: {},
      lines: ['ENOENT: no such file', 'stack…'],
      ok: false,
    });
    expect(result).toEqual({ summary: 'ENOENT: no such file', detail: ['stack…'] });
  });

  it('never returns an empty summary', () => {
    expect(summariseToolResult({ name: 'Bash', input: {}, lines: [], ok: true }).summary).toBe('Done');
    expect(summariseToolResult({ name: 'Bash', input: {}, lines: [], ok: false }).summary).toBe('Failed');
  });
});
