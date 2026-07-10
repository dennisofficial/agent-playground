import { describe, expect, it } from 'vitest';
import { decisionsBlock, shipOpenPrBody } from './ship-open-pr';
import {
  HANDOFF_SCHEMA,
  RECORD_LEG_HANDOFF_DESCRIPTION,
  RECORD_LEG_HANDOFF_STOP,
  ROTATION_PREAMBLE,
  ROTATION_REMINDER_NUDGE,
  ROTATION_SOFT_NUDGE,
} from './build-handoff';

/**
 * Golden-snapshot baseline for the pure `turns/` builders + consts — every snapshot captures CURRENT
 * output verbatim (a regression pass, not a spec of intent; behavioral assertions live in the sibling
 * `ship-open-pr.spec.ts`).
 */
describe('turns / golden snapshots', () => {
  it('shipOpenPrBody — no decisions block', async () => {
    const out = shipOpenPrBody({
      branch: 'atlas/feat-x',
      defaultBranch: 'main',
      title: 'Add the widget',
      decisionsBlock: '',
    });
    await expect(out).toMatchFileSnapshot('./__snapshots__/ship-open-pr-body.txt');
  });

  it('shipOpenPrBody — with a non-empty decisions block', async () => {
    const block = decisionsBlock([
      { title: 'Use pgvector', decisionClass: 'data_model', ruling: 'HNSW index on embeddings' },
      { title: 'Ship in-sandbox', decisionClass: 'mechanism', ruling: 'Atlas opens the PR itself' },
    ]);
    const out = shipOpenPrBody({
      branch: 'atlas/feat-x',
      defaultBranch: 'main',
      title: 'Add the widget',
      decisionsBlock: block,
    });
    await expect(out).toMatchFileSnapshot('./__snapshots__/ship-open-pr-body-with-decisions.txt');
  });

  it('ROTATION_PREAMBLE', async () => {
    await expect(ROTATION_PREAMBLE).toMatchFileSnapshot('./__snapshots__/rotation-preamble.txt');
  });

  it('ROTATION_SOFT_NUDGE', async () => {
    await expect(ROTATION_SOFT_NUDGE).toMatchFileSnapshot('./__snapshots__/rotation-soft-nudge.txt');
  });

  it('ROTATION_REMINDER_NUDGE', async () => {
    await expect(ROTATION_REMINDER_NUDGE).toMatchFileSnapshot(
      './__snapshots__/rotation-reminder-nudge.txt',
    );
  });

  it('RECORD_LEG_HANDOFF_DESCRIPTION', async () => {
    await expect(RECORD_LEG_HANDOFF_DESCRIPTION).toMatchFileSnapshot(
      './__snapshots__/record-leg-handoff-description.txt',
    );
  });

  it('RECORD_LEG_HANDOFF_STOP', async () => {
    await expect(RECORD_LEG_HANDOFF_STOP).toMatchFileSnapshot(
      './__snapshots__/record-leg-handoff-stop.txt',
    );
  });

  it('HANDOFF_SCHEMA', async () => {
    await expect(HANDOFF_SCHEMA.join('\n')).toMatchFileSnapshot('./__snapshots__/handoff-schema.txt');
  });
});
