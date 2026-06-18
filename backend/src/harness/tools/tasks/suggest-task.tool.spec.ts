import { describe, expect, it, vi } from 'vitest';
import type { Identity } from '../../domain/identity';
import type { SuggestOutcome } from '../../approvals/suggestion.service';
import { SuggestTaskTool } from './suggest-task.tool';

/**
 * The lead-only proactive work-proposal tool. EmployeeRegistry + SuggestionService mocked — the
 * subject is the authority gate and the outcome→chat-words mapping (posted / no-surface / failed).
 */

const identity = (selfAgent: string): { identity: Identity } => ({
  identity: {
    selfAgent,
    team: 'T1',
    project: 'proj',
    participants: ['dennis'],
    speaker: 'dennis',
    surface: 'slack:T1:C42',
    isChannel: true,
  },
});

function makeTool(opts: { isLead?: boolean; outcome?: SuggestOutcome }) {
  const employees = {
    byId: (id: string) =>
      id === 'atlas' ? { id: 'atlas', teamLead: opts.isLead ?? true } : undefined,
  };
  const suggest = vi.fn(() =>
    Promise.resolve(
      opts.outcome ??
        ({ ok: true, taskId: 5, presented: 'posted' } as SuggestOutcome),
    ),
  );
  const suggestions = { suggest };
  const tool = new SuggestTaskTool(employees as never, suggestions as never);
  return { tool, suggest };
}

describe('SuggestTaskTool', () => {
  it('refuses a non-lead caller without touching the service', async () => {
    const { tool, suggest } = makeTool({ isLead: false });
    const out = await tool.execute(
      { title: 'Do X', why: 'because' },
      identity('alex'),
    );
    expect(out).toMatch(/team lead's call/);
    expect(suggest).not.toHaveBeenCalled();
  });

  it('captures + posts the chip and reports the parked task id', async () => {
    const { tool, suggest } = makeTool({
      outcome: { ok: true, taskId: 42, presented: 'posted' },
    });
    const out = await tool.execute(
      { title: 'Add save offer', why: 'reduce churn', suggested_disposition: 'run' },
      identity('atlas'),
    );
    expect(suggest).toHaveBeenCalledOnce();
    expect((suggest.mock.calls[0] as unknown[])[0]).toMatchObject({
      team: 'T1',
      project: 'proj',
      title: 'Add save offer',
      why: 'reduce churn',
      suggestedDisposition: 'run',
      proposedBy: 'atlas',
      surfaceId: 'slack:T1:C42',
    });
    expect(out).toMatch(/Suggested #42/);
    expect(out).toMatch(/chip posted/);
  });

  it('degrades to chat-words when no chip surface is bound (still parked)', async () => {
    const { tool } = makeTool({
      outcome: { ok: true, taskId: 7, presented: 'no-surface' },
    });
    const out = await tool.execute(
      { title: 'Do X', why: 'because' },
      identity('atlas'),
    );
    expect(out).toMatch(/No chip surface/);
    expect(out).toMatch(/#7/);
  });

  it('reports the parked task + the failure on a chip-post error, warning against a re-suggest', async () => {
    const { tool } = makeTool({
      outcome: { ok: true, taskId: 8, presented: 'failed', error: 'boom' },
    });
    const out = await tool.execute(
      { title: 'Do X', why: 'because' },
      identity('atlas'),
    );
    expect(out).toMatch(/#8/);
    expect(out).toMatch(/boom/);
    expect(out).toMatch(/duplicate the board item/);
  });

  it('surfaces a capture failure', async () => {
    const { tool } = makeTool({ outcome: { ok: false, kind: 'create-failed' } });
    const out = await tool.execute(
      { title: 'Do X', why: 'because' },
      identity('atlas'),
    );
    expect(out).toMatch(/Couldn't capture/);
  });
});
