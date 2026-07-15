import { describe, expect, it } from 'vitest';
import {
  SANDBOX_RESET_NOTICE,
  BG_TASK_CAP_NOTICE,
} from '../engine/engine.types';
import { SVC_NUDGE_TEXT } from '../engine/engine-core';

/**
 * Golden-snapshot baseline for the driver/engine PROSE strings NOT relocated to `prompt-kit`. Every
 * snapshot captures CURRENT output verbatim — a regression pass, not a spec of intent (see the sibling
 * `prompt-kit` snapshot specs, including `prompt-kit/messages/prose-snapshots.spec.ts` for the driver-run
 * turn bodies). `CONTINUATION_PREAMBLE` is colocated in `../brain` instead (see
 * `continuation-preamble-snapshot.spec.ts`) to keep this file's import graph light.
 */

describe('driver/engine prose golden snapshots', () => {
  it('SANDBOX_RESET_NOTICE', async () => {
    await expect(SANDBOX_RESET_NOTICE).toMatchFileSnapshot(
      './__snapshots__/sandbox-reset-notice.txt',
    );
  });

  it('BG_TASK_CAP_NOTICE', async () => {
    await expect(BG_TASK_CAP_NOTICE).toMatchFileSnapshot(
      './__snapshots__/bg-task-cap-notice.txt',
    );
  });

  it('SVC_NUDGE_TEXT', async () => {
    await expect(SVC_NUDGE_TEXT).toMatchFileSnapshot(
      './__snapshots__/svc-nudge-text.txt',
    );
  });
});
