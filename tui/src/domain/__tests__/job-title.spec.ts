import { describe, expect, it } from 'bun:test';
import { deriveJobTitle } from '../job-title.js';

/**
 * The name a job gets for free. Every case here is a first message somebody would actually type —
 * the point of deriving rather than asking is that the derivation has to survive real prose.
 */
describe('deriving a job title from its first message', () => {
  it('takes the first line as it stands', () => {
    expect(deriveJobTitle('fix the steering wheel wobble')).toBe('fix the steering wheel wobble');
  });

  it('names the job after the first line, not the whole message', () => {
    expect(deriveJobTitle('add avatar upload\n\nit should resize to 512px and strip exif')).toBe(
      'add avatar upload',
    );
  });

  it('keeps a question a question — one question is a legitimate job', () => {
    expect(deriveJobTitle('hey how does auth work?')).toBe('hey how does auth work?');
  });

  it('strips markdown furniture, which names the formatting rather than the job', () => {
    expect(deriveJobTitle('## the login page 404s')).toBe('the login page 404s');
    expect(deriveJobTitle('- rip out the old rotation code')).toBe('rip out the old rotation code');
    expect(deriveJobTitle('1. rename the phase table')).toBe('rename the phase table');
    expect(deriveJobTitle('> quoted from slack')).toBe('quoted from slack');
  });

  it('drops a trailing colon — a heading is not a title', () => {
    expect(deriveJobTitle('three things:\n- one\n- two')).toBe('three things');
  });

  it('skips lines that name nothing and takes the first that does', () => {
    expect(deriveJobTitle('```\nconst x = 1;\n```')).toBe('const x = 1;');
    expect(deriveJobTitle('\n\n   \n---\nwhy is the build red')).toBe('why is the build red');
  });

  it('collapses the whitespace a paste brings with it', () => {
    expect(deriveJobTitle('  fix   the    tabs\t\tplease  ')).toBe('fix the tabs please');
  });

  it('truncates at a word boundary rather than mid-word', () => {
    const long =
      'rewrite the account rotation so a usage wall moves the next turn to another account entirely';
    const title = deriveJobTitle(long);
    expect(title.length).toBeLessThanOrEqual(57); // 56 + the ellipsis
    expect(title.endsWith('…')).toBe(true);
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
    // A word boundary, not a cut through one.
    expect(long[title.length - 1]).toBe(' ');
  });

  it('hard-cuts one very long word, because there is no boundary to find', () => {
    const title = deriveJobTitle('x'.repeat(200));
    expect(title).toBe(`${'x'.repeat(55)}…`);
  });

  it('falls back rather than returning nothing a row cannot draw', () => {
    expect(deriveJobTitle('')).toBe('untitled job');
    expect(deriveJobTitle('   \n\n\t')).toBe('untitled job');
    expect(deriveJobTitle('###')).toBe('untitled job');
  });
});
