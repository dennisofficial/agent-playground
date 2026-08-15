import { describe, expect, it } from 'bun:test';
import { EAttentionCourt } from '../attention.js';
import {
  DETACHED,
  EHeaderChip,
  ELSEWHERE_GLYPH,
  IN_PLACE_GLYPH,
  chipsWidth,
  fitHeaderChips,
  headerChipForms,
  headerPlace,
  headerStatusText,
  type HeaderFacts,
  type HeaderGit,
} from '../conversation-header.js';

const facts = (over: Partial<HeaderFacts> = {}): HeaderFacts => ({
  jobTitle: 'fix steering on rotation',
  repo: 'atlas',
  role: 'builder',
  siblings: 0,
  closed: false,
  status: { label: 'reply', court: EAttentionCourt.yours, spinner: false },
  git: { cwdLabel: null, checkoutBranch: 'main' },
  ...over,
});

const git = (over: Partial<HeaderGit> = {}): HeaderGit => ({
  cwdLabel: null,
  checkoutBranch: 'main',
  ...over,
});

describe('where the agent is standing', () => {
  it('says the branch out loud when turns run in the repository root', () => {
    // The case worth flinching at: this is the tree the human has an editor open on, and `main` is
    // what a commit is about to land on.
    const place = headerPlace(git());
    expect(place.glyph).toBe(IN_PLACE_GLYPH);
    expect(place.branch).toBe('main');
    expect(place.path).toBeNull();
  });

  it('marks a directory that is not the root, whoever created it', () => {
    const place = headerPlace(
      git({ cwdLabel: '.worktrees/eng-203', checkoutBranch: 'dennis/eng-203' }),
    );
    expect(place.glyph).toBe(ELSEWHERE_GLYPH);
  });

  it('drops the path when it only repeats the branch', () => {
    // An Atlas-minted worktree is `.worktrees/<slug>-<id8>` on branch `atlas/<slug>-<id8>`. Printing
    // both is printing it twice, and the pair is nearly a hundred columns.
    const place = headerPlace(
      git({
        cwdLabel: '.worktrees/fix-steering-a1b2c3d4',
        checkoutBranch: 'atlas/fix-steering-a1b2c3d4',
      }),
    );
    expect(place.path).toBeNull();
    expect(place.branch).toBe('atlas/fix-steering-a1b2c3d4');
  });

  it('keeps the path when the directory and the branch genuinely differ', () => {
    const place = headerPlace(
      git({ cwdLabel: '.worktrees/eng-203', checkoutBranch: 'dennis/eng-203-header' }),
    );
    expect(place.path).toBe('.worktrees/eng-203');
  });

  it('says detached rather than inventing a branch', () => {
    expect(headerPlace(git({ checkoutBranch: null })).branch).toBe(DETACHED);
  });
});

describe('what is happening', () => {
  it('carries the clock only while a turn is actually running', () => {
    const running = facts({
      status: { label: 'working…', court: EAttentionCourt.agent, spinner: true },
    });
    expect(headerStatusText({ facts: running, elapsed: '1m 12s' })).toBe('working… 1m 12s');
    expect(headerStatusText({ facts: facts(), elapsed: '1m 12s' })).toBe('reply');
  });

  it('lets closed outrank whose turn it is', () => {
    // A closed thread cannot be acted on at all — the composer will not send — which is a different
    // kind of fact from whose move it is.
    const shut = facts({ closed: true });
    expect(headerStatusText({ facts: shut, elapsed: null })).toBe('closed');
  });

  it('speaks whatever word attentionFor chose, rather than a second vocabulary', () => {
    const waiting = facts({
      status: { label: 'confirm', court: EAttentionCourt.yours, spinner: false },
    });
    expect(headerStatusText({ facts: waiting, elapsed: null })).toBe('confirm');
  });
});

describe('row two, on the right', () => {
  it('says nothing about siblings when this is the only live thread', () => {
    expect(headerChipForms(facts())).toEqual([[{ kind: EHeaderChip.role, text: 'builder' }]]);
  });

  it('is ordered longest-first, so the first that fits is the widest that fits', () => {
    const widths = headerChipForms(facts({ siblings: 2 })).map((form) => chipsWidth(form));
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
  });

  it('sheds the sibling count’s word before its number', () => {
    const mid = fitHeaderChips({ facts: facts({ siblings: 2 }), room: 14 });
    expect(mid.map((chip) => chip.text)).toEqual(['builder', '+2']);
  });

  it('never sheds the role, even when nothing fits', () => {
    // What this agent will DO. A thread whose role you cannot see is one you have to guess about,
    // so this is clipped by the renderer rather than dropped here.
    const squeezed = fitHeaderChips({ facts: facts({ siblings: 9 }), room: 1 });
    expect(squeezed).toEqual([{ kind: EHeaderChip.role, text: 'builder' }]);
  });

  it('keeps the sibling count while there is room for all of it', () => {
    const roomy = fitHeaderChips({ facts: facts({ siblings: 2 }), room: 40 });
    expect(roomy.map((chip) => chip.text)).toEqual(['builder', '+2 threads']);
  });
});
