import { describe, expect, it } from 'vitest';
import { columnsOf, renderRows } from '../format';
import { redactSecrets } from '../redact';

describe('columnsOf', () => {
  it('unions keys in first-seen order across rows with differing/overlapping keys', () => {
    const rows = [{ b: 1, a: 2 }, { a: 3, c: 4 }, { d: 5 }];
    expect(columnsOf(rows)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('returns an empty array for no rows', () => {
    expect(columnsOf([])).toEqual([]);
  });
});

describe('renderRows jsonl', () => {
  it('renders one JSON object per line', () => {
    const rows = [{ a: 1 }, { a: 2, b: 'x' }];
    const text = renderRows(rows, 'jsonl');
    expect(text).toBe('{"a":1}\n{"a":2,"b":"x"}');
  });
});

describe('renderRows csv', () => {
  it('renders a header followed by one line per row', () => {
    const rows = [
      { id: 1, name: 'alice' },
      { id: 2, name: 'bob' },
    ];
    expect(renderRows(rows, 'csv')).toBe('id,name\n1,alice\n2,bob');
  });

  it('quotes a cell containing a comma', () => {
    const rows = [{ a: 'x,y' }];
    expect(renderRows(rows, 'csv')).toBe('a\n"x,y"');
  });

  it('doubles an embedded double-quote and wraps the cell', () => {
    const rows = [{ a: 'say "hi"' }];
    expect(renderRows(rows, 'csv')).toBe('a\n"say ""hi"""');
  });

  it('quotes a cell containing a newline', () => {
    const rows = [{ a: 'line1\nline2' }];
    expect(renderRows(rows, 'csv')).toBe('a\n"line1\nline2"');
  });

  it('renders null/undefined as empty', () => {
    const rows = [{ a: null, b: undefined }];
    expect(renderRows(rows, 'csv')).toBe('a,b\n,');
  });

  it('renders a nested object as a quoted JSON string', () => {
    const rows = [{ a: { x: 1, y: 'z' } }];
    expect(renderRows(rows, 'csv')).toBe('a\n"{""x"":1,""y"":""z""}"');
  });

  it('quotes a header cell that itself contains a comma', () => {
    const rows = [{ 'col,name': 1 }];
    expect(renderRows(rows, 'csv')).toBe('"col,name"\n1');
  });
});

describe('renderRows tsv', () => {
  it('renders tab-delimited header and rows', () => {
    const rows = [
      { id: 1, name: 'alice' },
      { id: 2, name: 'bob' },
    ];
    expect(renderRows(rows, 'tsv')).toBe('id\tname\n1\talice\n2\tbob');
  });

  it('quotes a cell containing a tab', () => {
    const rows = [{ a: 'x\ty' }];
    expect(renderRows(rows, 'tsv')).toBe('a\n"x\ty"');
  });
});

describe('renderRows + redaction', () => {
  it('masks a secret-shaped value rendered into csv text', () => {
    const secret = `sk-${'a'.repeat(30)}`;
    const rows = [{ apiSecret: secret, note: 'hello, world' }];
    const text = renderRows(rows, 'csv');
    expect(text).toContain(secret);

    const redacted = redactSecrets(text) as string;
    expect(redacted).toContain('***REDACTED***');
    expect(redacted).not.toContain(secret);
  });

  it('masks an AWS access key id rendered into a handler-shaped result object', () => {
    const secret = `AKIA${'B'.repeat(16)}`;
    const rows = [{ accessKeyId: secret }];
    const text = renderRows(rows, 'csv');
    const handlerResult = {
      format: 'csv' as const,
      rowCount: rows.length,
      truncated: false,
      text,
    };

    const redacted = redactSecrets(handlerResult) as typeof handlerResult;
    expect(redacted.text).toContain('***REDACTED***');
    expect(redacted.text).not.toContain(secret);
  });
});
