import { describe, expect, it, vi } from 'vitest';
import type { BoardStore } from '../memory/board-store';
import type { TaskSuggestionPresenter } from './task-suggestion-presenter.port';
import { SuggestionService } from './suggestion.service';

/**
 * The task-suggestion core: capture (board.create) + present (the outbound chip). The capture is the
 * durable part and always stands — a missing presenter degrades to 'no-surface', a thrown present() to
 * 'failed', neither undoing the board row (the autonomous capture-zone model).
 */

const SUGGEST = {
  team: 'T1',
  project: 'proj',
  title: 'Add a save offer',
  why: 'reduce churn',
  proposedBy: 'atlas',
  surfaceId: 'slack:T1:C42',
};

function makeBoard(createId = 11) {
  const create = vi.fn(() =>
    Promise.resolve({ id: createId, title: 'Add a save offer' }),
  );
  return { create } as unknown as BoardStore & { create: ReturnType<typeof vi.fn> };
}

describe('SuggestionService', () => {
  it('captures an open board item (rationale in the description) and posts the chip', async () => {
    const board = makeBoard(11);
    const present = vi.fn(() => Promise.resolve());
    const presenter = { present } as TaskSuggestionPresenter;
    const svc = new SuggestionService(board as never, presenter);

    const out = await svc.suggest({ ...SUGGEST, description: 'detail' });

    expect(out).toEqual({ ok: true, taskId: 11, presented: 'posted' });
    expect(board.create).toHaveBeenCalledOnce();
    const createArg = (board.create.mock.calls[0] as unknown[])[0] as {
      team: string;
      project: string;
      title: string;
      createdBy: string;
      description: string;
    };
    expect(createArg).toMatchObject({
      team: 'T1',
      project: 'proj',
      title: 'Add a save offer',
      createdBy: 'atlas',
    });
    // why + description fold into the parked item's description so it's self-explanatory.
    expect(createArg.description).toContain('reduce churn');
    expect(createArg.description).toContain('detail');
    expect(present).toHaveBeenCalledOnce();
    expect(((present.mock.calls[0] as unknown[])[0] as { taskId: number }).taskId).toBe(11);
  });

  it("returns 'no-surface' (capture stands) when no presenter is bound", async () => {
    const board = makeBoard(12);
    const svc = new SuggestionService(board as never, undefined);

    const out = await svc.suggest(SUGGEST);

    expect(out).toEqual({ ok: true, taskId: 12, presented: 'no-surface' });
    expect(board.create).toHaveBeenCalledOnce();
  });

  it("returns 'failed' with the created task id when present() throws — the row is still created once", async () => {
    const board = makeBoard(13);
    const present = vi.fn(() => Promise.reject(new Error('non-Slack room')));
    const svc = new SuggestionService(board as never, { present } as never);

    const out = await svc.suggest(SUGGEST);

    expect(out).toMatchObject({ ok: true, taskId: 13, presented: 'failed' });
    expect((out as { error?: string }).error).toContain('non-Slack');
    expect(board.create).toHaveBeenCalledOnce(); // not retried / duplicated
  });

  it("returns 'create-failed' when the board reports unknown deps", async () => {
    const create = vi.fn(() => Promise.resolve({ unknownDeps: [99] }));
    const board = { create } as unknown as BoardStore;
    const svc = new SuggestionService(board, undefined);

    const out = await svc.suggest(SUGGEST);
    expect(out).toEqual({ ok: false, kind: 'create-failed' });
  });
});
