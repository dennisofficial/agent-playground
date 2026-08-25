import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EPhaseKind, ETransitionStatus } from '../../generated/prisma/enums.js';
import type { Phase } from '../../generated/prisma/client.js';
import type { JobRepository } from '../../store/job.repository.js';
import type {
  TransitionRepository,
  TransitionRow,
} from '../../store/transition.repository.js';
import type { ContextEntry, ContextFolderService } from '../context-folder.service.js';
import { TransitionReviewService } from '../transition-review.service.js';

/**
 * What the confirm overlay is allowed to show.
 *
 * The claim under test is that the review is not a summary of the proposal but the proposal itself:
 * the files are gathered by the SAME function the confirmation will use, so what Dennis reads is
 * what the successor gets. A review that quoted the agent's declaration instead would let a plan be
 * approved on screen and delivered differently.
 */

const ROOTS: string[] = [];

afterAll(() => {
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LISTING: ContextEntry[] = (
  [
    { bucket: 'specs', path: 'plan.md' },
    { bucket: 'specs', path: '02-slice.md' },
    { bucket: 'charting', path: 'map.md' },
  ] satisfies Pick<ContextEntry, 'bucket' | 'path'>[]
).map((entry) => ({ ...entry, bytes: 1, modifiedAt: new Date(0), isDirectory: false }));

function world(args: { attach?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'atlas-review-'));
  mkdirSync(join(root, 'specs'), { recursive: true });
  mkdirSync(join(root, 'charting'), { recursive: true });
  writeFileSync(join(root, 'specs', 'plan.md'), '# The plan\n\nthree slices');
  writeFileSync(join(root, 'specs', '02-slice.md'), 'slice two');
  writeFileSync(join(root, 'charting', 'map.md'), 'the map');
  ROOTS.push(root);

  const transition = {
    id: 'transition-1',
    jobId: 'job-1',
    fromPhaseId: 'phase-1',
    raisedByThreadId: 'thread-1',
    to: EPhaseKind.build,
    reason: 'the plan is written',
    handoff: 'Slices are in specs/.',
    attach: args.attach ?? ['context/charting/map.md'],
    status: ETransitionStatus.pending,
  } as unknown as TransitionRow;

  const phases = [
    { id: 'phase-1', jobId: 'job-1', kind: EPhaseKind.planning, ordinal: 0 } as unknown as Phase,
  ];

  return new TransitionReviewService(
    {
      async findById(id: string): Promise<TransitionRow | null> {
        return id === transition.id ? transition : null;
      },
    } as unknown as TransitionRepository,
    {
      async listPhases(): Promise<Phase[]> {
        return phases;
      },
    } as unknown as JobRepository,
    {
      list: (): ContextEntry[] => LISTING,
      resolveInside: (ref: { relativePath: string }): string => join(root, ref.relativePath),
    } as unknown as ContextFolderService,
  );
}

describe('reviewing a proposal', () => {
  it('names the phase being left, so the overlay can draw the whole route', async () => {
    const review = await world().review('transition-1');
    expect(review?.from).toBe(EPhaseKind.planning);
    expect(review?.transition.to).toBe(EPhaseKind.build);
  });

  it('shows the DESTINATION’s floor, not just what the agent declared', async () => {
    const review = await world().review('transition-1');

    // `plan.md` is unnumbered in `specs/`, so it crosses into `build` whether or not the planner
    // remembered to attach it — and the review has to show it, or `y` approves an unread plan.
    // `02-slice.md` is numbered: one thread's, floored nowhere.
    expect(review?.attached.map((ref) => `${ref.bucket}/${ref.path}`)).toEqual([
      'specs/plan.md',
      'charting/map.md',
    ]);
    expect(review?.parts.find((part) => part.label.endsWith('plan.md'))?.body).toContain(
      'three slices',
    );
  });

  it('is a review when a spec crosses, and a menu otherwise', async () => {
    const review = await world().review('transition-1');
    expect(review?.attached.some((ref) => ref.bucket === 'specs')).toBe(true);
  });

  // The gather runs on Dennis's keypress, hours after the ask. A file tidied away in between must
  // reach him as a MISSING chip rather than sinking the overlay — the same policy the confirmation
  // itself uses, because they are the same call.
  it('reports a file that has gone rather than throwing', async () => {
    const review = await world({ attach: ['context/specs/vanished.md'] }).review('transition-1');
    const gone = review?.parts.find((part) => part.label.endsWith('vanished.md'));
    expect(gone?.body).toBeNull();
  });

  it('answers null for a proposal that is not there', async () => {
    expect(await world().review('transition-9')).toBeNull();
  });
});
