import { describe, expect, it } from 'bun:test';
import { EPhaseKind } from '../../generated/prisma/enums.js';
import type { ContextFileRef } from '../phase-spec.js';
import {
  DECLINED_NOTICE,
  opensAsReview,
  opensProposal,
  proposalKeyHints,
  proposalView,
  reviewSummary,
} from '../transition-review.js';

const PLAN: ContextFileRef = { bucket: 'specs', path: 'plan.md' };
const MAP: ContextFileRef = { bucket: 'charting', path: 'map.md' };

describe('proposalView', () => {
  it('draws the route both phases wide', () => {
    const view = proposalView({
      transition: { to: EPhaseKind.build, reason: 'the plan is written', handoff: 'go' },
      from: EPhaseKind.planning,
      attached: [PLAN],
    });
    expect(view.route).toBe('planning → build');
    expect(view.reason).toBe('the plan is written');
    expect(view.handoff).toBe('go');
    expect(view.files).toEqual(['context/specs/plan.md']);
  });

  it('names only the destination for a job with nothing behind it', () => {
    const view = proposalView({
      transition: { to: EPhaseKind.charting, reason: 'bigger than a chat', handoff: null },
      from: null,
      attached: [],
    });
    expect(view.route).toBe('charting');
    // Never `null` on the way out: the overlay renders it, and a null would draw the word.
    expect(view.handoff).toBe('');
  });

  it('spells a multi-word phase without its underscore', () => {
    const view = proposalView({
      transition: { to: EPhaseKind.direct_build, reason: 'small', handoff: null },
      from: EPhaseKind.post_build,
      attached: [],
    });
    expect(view.route).toBe('post build → direct build');
  });
});

describe('opensAsReview', () => {
  it('is a review when a spec crosses the boundary', () => {
    expect(opensAsReview([MAP, PLAN])).toBe(true);
  });

  it('is a menu when nothing from specs/ does', () => {
    expect(opensAsReview([MAP])).toBe(false);
    expect(opensAsReview([])).toBe(false);
  });
});

describe('opensProposal', () => {
  const base = { pendingId: 't1', requestedId: null, deferredId: null, draftLength: 0 };

  it('stays shut with nothing pending', () => {
    expect(opensProposal({ ...base, pendingId: null })).toBe(false);
  });

  it('opens itself on an empty composer', () => {
    expect(opensProposal(base)).toBe(true);
  });

  // The safety rule: every listener sees every key, so an overlay that opened mid-sentence would
  // take `y` out of a half-typed word.
  it('never takes the keyboard from a draft', () => {
    expect(opensProposal({ ...base, draftLength: 4 })).toBe(false);
  });

  it('opens on request even mid-draft', () => {
    expect(opensProposal({ ...base, requestedId: 't1', draftLength: 4 })).toBe(true);
  });

  it('stays shut once deferred', () => {
    expect(opensProposal({ ...base, deferredId: 't1' })).toBe(false);
  });

  it('opens again for a different proposal', () => {
    expect(opensProposal({ ...base, deferredId: 't0' })).toBe(true);
  });
});

describe('proposalKeyHints', () => {
  it('offers the documents only where there are some', () => {
    const [widest] = proposalKeyHints({ expanded: false, hasDocuments: true });
    expect(widest).toBe('y confirm · n decline · x read the hand-off · esc decide later');
    expect(proposalKeyHints({ expanded: true, hasDocuments: true })[0]).toContain('x hide');
    expect(proposalKeyHints({ expanded: false, hasDocuments: false })[0]).not.toContain('x ');
  });

  it('narrows to the two keys that decide', () => {
    const forms = proposalKeyHints({ expanded: false, hasDocuments: true });
    expect(forms[forms.length - 1]).toBe('y · n');
  });
});

describe('reviewSummary', () => {
  it('counts what is carried', () => {
    expect(reviewSummary({ handoff: 'a\nb\nc', files: ['x', 'y'] })).toBe(
      'hand-off 3 lines · 2 files',
    );
    expect(reviewSummary({ handoff: 'a', files: ['x'] })).toBe('hand-off 1 line · 1 file');
  });

  it('says so when a proposal carries nothing at all', () => {
    expect(reviewSummary({ handoff: '', files: [] })).toBe('nothing carried');
  });
});

describe('DECLINED_NOTICE', () => {
  // The whole of what declining does is write the row. This line is what stops `n` looking inert.
  it('sends the human back to the composer of a thread that is still open', () => {
    expect(DECLINED_NOTICE).toContain('still open');
    expect(DECLINED_NOTICE).toContain('composer');
  });
});
