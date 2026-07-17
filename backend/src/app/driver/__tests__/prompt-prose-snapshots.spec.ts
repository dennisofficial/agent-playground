import { SVC_NUDGE_TEXT } from '@shared/engine/engine-core';
import { BG_TASK_CAP_NOTICE, SANDBOX_RESET_NOTICE } from '@shared/engine/engine.types';
import { describe, expect, it } from 'vitest';


describe('driver/engine prose golden snapshots', () => {
  it('SANDBOX_RESET_NOTICE', async () => {
    await expect(SANDBOX_RESET_NOTICE).toMatchFileSnapshot(
      './__snapshots__/sandbox-reset-notice.txt',
    );
  });

  it('BG_TASK_CAP_NOTICE', async () => {
    await expect(BG_TASK_CAP_NOTICE).toMatchFileSnapshot('./__snapshots__/bg-task-cap-notice.txt');
  });

  it('SVC_NUDGE_TEXT', async () => {
    await expect(SVC_NUDGE_TEXT).toMatchFileSnapshot('./__snapshots__/svc-nudge-text.txt');
  });
});
