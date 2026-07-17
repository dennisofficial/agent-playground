import { describe, expect, it } from 'vitest';
import { CONTINUATION_PREAMBLE } from '../agent-session-manager.service';

describe('agent-session-manager.service — CONTINUATION_PREAMBLE golden snapshot', () => {
  it('CONTINUATION_PREAMBLE', async () => {
    await expect(CONTINUATION_PREAMBLE).toMatchFileSnapshot(
      './__snapshots__/continuation-preamble.txt',
    );
  });
});
