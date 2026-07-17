import { describe, expect, it } from 'vitest';
import { shipOpenPrBody } from '../ship-open-pr';
import { postBuildGateSeed } from '../post-build-gate';
import {
  HANDOFF_SCHEMA,
  RECORD_LEG_HANDOFF_DESCRIPTION,
  RECORD_LEG_HANDOFF_STOP,
  ROTATION_PREAMBLE,
  ROTATION_REMINDER_NUDGE,
  ROTATION_RESUME_TAIL,
  ROTATION_SOFT_NUDGE,
} from '@shared/prompt-kit/messages/build-handoff';

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
    });
    await expect(out).toMatchFileSnapshot(
      './__snapshots__/ship-open-pr-body.txt',
    );
  });

  it('postBuildGateSeed', async () => {
    await expect(postBuildGateSeed()).toMatchFileSnapshot(
      './__snapshots__/post-build-gate-body.txt',
    );
  });

  it('ROTATION_PREAMBLE', async () => {
    await expect(ROTATION_PREAMBLE).toMatchFileSnapshot(
      './__snapshots__/rotation-preamble.txt',
    );
  });

  it('ROTATION_RESUME_TAIL', async () => {
    await expect(ROTATION_RESUME_TAIL).toMatchFileSnapshot(
      './__snapshots__/rotation-resume-tail.txt',
    );
  });

  it('ROTATION_SOFT_NUDGE', async () => {
    await expect(ROTATION_SOFT_NUDGE).toMatchFileSnapshot(
      './__snapshots__/rotation-soft-nudge.txt',
    );
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
    await expect(HANDOFF_SCHEMA.join('\n')).toMatchFileSnapshot(
      './__snapshots__/handoff-schema.txt',
    );
  });
});
