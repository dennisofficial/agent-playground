import { coherenceNote, echoesOwnName } from './coherence-check';

describe('echoesOwnName', () => {
  it('passes when text starts with the name', () => {
    expect(echoesOwnName('Alex — here is my report', 'Alex')).toBe(true);
    expect(echoesOwnName('Alex: done', 'Alex')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(echoesOwnName('alex: done', 'Alex')).toBe(true);
    expect(echoesOwnName('ALEX — done', 'Alex')).toBe(true);
  });

  it('tolerates leading whitespace', () => {
    expect(echoesOwnName('  Alex — report', 'Alex')).toBe(true);
    expect(echoesOwnName('\nAlex — report', 'Alex')).toBe(true);
    expect(echoesOwnName('\t Alex — report', 'Alex')).toBe(true);
  });

  it('tolerates common Markdown emphasis/quote/heading marks before the name', () => {
    expect(echoesOwnName('**Alex** — report', 'Alex')).toBe(true);
    expect(echoesOwnName('> Alex — report', 'Alex')).toBe(true);
    expect(echoesOwnName('# Alex — report', 'Alex')).toBe(true);
    expect(echoesOwnName('_Alex_ — report', 'Alex')).toBe(true);
    expect(echoesOwnName('`Alex`', 'Alex')).toBe(true);
    expect(echoesOwnName('~~Alex~~', 'Alex')).toBe(true);
  });

  it('fails when text does not start with the name', () => {
    expect(echoesOwnName('Here is my report', 'Alex')).toBe(false);
    expect(echoesOwnName('Done.', 'Alex')).toBe(false);
    expect(echoesOwnName('', 'Alex')).toBe(false);
  });

  it('does not false-positive on the name appearing only later in the text', () => {
    expect(echoesOwnName('The plan was written by Alex.', 'Alex')).toBe(false);
    expect(echoesOwnName('Found it — credit to Alex.', 'Alex')).toBe(false);
  });

  it('handles names with special regex characters safely via escapeRegExp', () => {
    expect(echoesOwnName('C++ — report', 'C++')).toBe(true);
    expect(echoesOwnName('Done.', 'C++')).toBe(false);
  });
});

describe('coherenceNote', () => {
  it('includes the employee name in the note', () => {
    expect(coherenceNote('Alex')).toContain('Alex');
    expect(coherenceNote('Riley')).toContain('Riley');
  });

  it('contains a horizontal rule separator and warning emoji', () => {
    const note = coherenceNote('Alex');
    expect(note).toContain('---');
    expect(note).toContain('⚠️');
  });

  it('mentions "fresh session" so the owner knows the remediation', () => {
    expect(coherenceNote('Alex')).toContain('fresh session');
  });

  it('starts with newlines so it appends cleanly after prose text', () => {
    const note = coherenceNote('Alex');
    expect(note.startsWith('\n\n')).toBe(true);
  });
});
