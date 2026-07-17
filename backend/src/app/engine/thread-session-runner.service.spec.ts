import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import { EngineSessionLimitError } from '@shared/engine';
import type { ThreadEntity } from '../persistence/entities';
import { ThreadSessionRunnerService } from './thread-session-runner.service';

function makeRunner(
  update = vi.fn().mockResolvedValue(undefined),
): { runner: ThreadSessionRunnerService; update: ReturnType<typeof vi.fn> } {
  const threads = { update } as unknown as Repository<ThreadEntity>;
  return { runner: new ThreadSessionRunnerService(threads), update };
}

describe('ThreadSessionRunnerService.classifyThrownHalt', () => {
  it('labels a clean session/usage-limit end as session_limit', () => {
    const { runner } = makeRunner();
    expect(
      runner.classifyThrownHalt(new EngineSessionLimitError('limit')),
    ).toBe('session_limit');
    // Any error carrying the structural `isSessionLimit` flag counts too (not only the concrete class).
    expect(runner.classifyThrownHalt({ isSessionLimit: true })).toBe(
      'session_limit',
    );
  });

  it('labels every other thrown end as error', () => {
    const { runner } = makeRunner();
    expect(runner.classifyThrownHalt(new Error('boom'))).toBe('error');
    expect(runner.classifyThrownHalt('transport blip')).toBe('error');
  });
});

describe('ThreadSessionRunnerService.markHalt', () => {
  it('writes the halt_reason (set and clear) onto the thread row', async () => {
    const { runner, update } = makeRunner();
    await runner.markHalt('t1', 'incomplete');
    expect(update).toHaveBeenCalledWith({ id: 't1' }, { halt_reason: 'incomplete' });
    await runner.markHalt('t1', null);
    expect(update).toHaveBeenLastCalledWith({ id: 't1' }, { halt_reason: null });
  });

  it('swallows a persistence failure (display-only — never blocks a turn)', async () => {
    const { runner } = makeRunner(vi.fn().mockRejectedValue(new Error('db down')));
    await expect(runner.markHalt('t1', 'error')).resolves.toBeUndefined();
  });
});

describe('ThreadSessionRunnerService.noteThrownHalt', () => {
  it('classifies then persists in one step, returning the reason', async () => {
    const { runner, update } = makeRunner();
    const reason = await runner.noteThrownHalt(
      't1',
      new EngineSessionLimitError('limit'),
    );
    expect(reason).toBe('session_limit');
    expect(update).toHaveBeenCalledWith(
      { id: 't1' },
      { halt_reason: 'session_limit' },
    );
  });
});
