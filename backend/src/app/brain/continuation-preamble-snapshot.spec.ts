import { describe, expect, it } from 'vitest';
import { CONTINUATION_PREAMBLE } from './agent-session-manager.service';

/**
 * Golden-snapshot baseline for `CONTINUATION_PREAMBLE` (the brain's compaction-continuation preamble),
 * colocated here rather than in `driver/prompt-prose-snapshots.spec.ts` to keep that spec's import graph
 * light — `agent-session-manager.service.ts` is a large NestJS service module.
 */
describe('agent-session-manager.service — CONTINUATION_PREAMBLE golden snapshot', () => {
  it('CONTINUATION_PREAMBLE', async () => {
    await expect(CONTINUATION_PREAMBLE).toMatchFileSnapshot(
      './__snapshots__/continuation-preamble.txt',
    );
  });
});
