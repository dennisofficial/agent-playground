import { describe, expect, it } from 'bun:test';
import { fitHeader, headerForms, type HeaderFacts } from '../conversation-header.js';

const facts = (over: Partial<HeaderFacts> = {}): HeaderFacts => ({
  jobTitle: 'fix steering on rotation',
  repo: 'atlas',
  role: 'builder',
  sessionOrdinal: 1,
  engine: 'claude',
  model: 'opus-5',
  branch: 'atlas/fix-steering',
  siblings: 0,
  closed: false,
  ...over,
});

const at = (width: number, over: Partial<HeaderFacts> = {}): string => {
  const form = fitHeader({ facts: facts(over), width, gutter: 2 });
  return `${form.left}|${form.right}`;
};

describe('what survives at width', () => {
  it('shows everything when there is room', () => {
    expect(at(120)).toBe('atlas › fix steering on rotation  ⑂ atlas/fix-steering|builder  claude opus-5');
  });

  it('drops the model and engine before anything else', () => {
    // They are fixed by the role and cannot be changed from here, so they are the least useful
    // characters on the line — see the role→engine binding table.
    expect(at(70)).not.toContain('opus-5');
    expect(at(70)).toContain('fix steering on rotation');
  });

  it('keeps the job title at a tile width, and drops the repo to do it', () => {
    // The inversion. One full-width terminal wanted the project first; six tiles of six unrelated
    // tickets want the only string that tells them apart.
    const narrow = at(48);
    expect(narrow).toContain('fix steering on rotation');
    expect(narrow).not.toContain('atlas ›');
  });

  it('never sheds the job title, even when nothing else fits', () => {
    expect(at(10)).toContain('fix steering on rotation');
  });
});

describe('the workspace glyph', () => {
  it('names the branch while there is room for it', () => {
    expect(at(120)).toContain('⑂ atlas/fix-steering');
  });

  it('keeps the glyph after the branch name has gone', () => {
    // Whether an agent is writing into the tree your editor has open survives longer than which
    // branch it is doing it on — one character, and it is the one that can hurt you.
    const narrow = at(44);
    expect(narrow).toContain('⑂');
    expect(narrow).not.toContain('atlas/fix-steering');
  });

  it('says in place when the job never took a worktree', () => {
    expect(at(120, { branch: null })).toContain('⌂');
  });
});

describe('siblings', () => {
  it('says nothing when this is the only live thread', () => {
    expect(at(120)).not.toContain('+');
  });

  it('counts other live threads of this job', () => {
    // Not other tiles. Six unrelated tickets means another tile's state is noise; another thread of
    // the job you are IN is the agent about to finish behind your back.
    expect(at(120, { siblings: 2 })).toContain('+2');
  });

  it('outlives the role', () => {
    const narrow = at(40, { siblings: 1, branch: null });
    expect(narrow).toContain('+1');
    expect(narrow).not.toContain('builder');
  });
});

describe('session ordinal', () => {
  it('is invisible until rotation has happened', () => {
    expect(at(120)).not.toContain('session');
  });

  it('appears once there is more than one leg', () => {
    expect(at(120, { sessionOrdinal: 2 })).toContain('session 2');
  });
});

describe('closed threads', () => {
  it('say so, and keep saying so when everything else has gone', () => {
    expect(at(120, { closed: true })).toContain('closed');
    expect(at(20, { closed: true })).toContain('closed');
  });
});

describe('headerForms', () => {
  it('is ordered longest-first, so the first that fits is the widest that fits', () => {
    const forms = headerForms(facts({ siblings: 1, sessionOrdinal: 3 }));
    const widths = forms.map((f) => f.left.length + f.right.length);
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
  });
});
