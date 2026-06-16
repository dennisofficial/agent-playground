import { describe, expect, it, vi } from 'vitest';
import type { BoardStore } from '../../memory/board-store';
import type { EmployeeRegistry } from '../../employees/employee.registry';
import type { HarnessToolContext } from '../tool.types';
import { AddBoardTaskTool, UpdateBoardTaskTool } from './board.tools';

/** shared_slug (the feature-grouping slug) is the team lead's call on both add and update. */

const ctx = (selfAgent: string): HarnessToolContext =>
  ({ identity: { team: 'T1', selfAgent, project: 'p', surface: 'c' } }) as never;

const employees = () =>
  ({ byId: (id: string) => ({ id, teamLead: id === 'sam' }) }) as unknown as EmployeeRegistry;

describe('add_board_task × shared_slug', () => {
  it('refuses a non-lead and never creates', async () => {
    const create = vi.fn();
    const tool = new AddBoardTaskTool({ create } as unknown as BoardStore, employees());
    const out = await tool.execute({ title: 'X', shared_slug: 'feat' }, ctx('alex'));
    expect(out).toContain("team lead's call");
    expect(create).not.toHaveBeenCalled();
  });

  it('lets the lead set it (lowercased, threaded to create)', async () => {
    const create = vi.fn(async () => ({ id: 5, dependsOn: [] }));
    const tool = new AddBoardTaskTool({ create } as unknown as BoardStore, employees());
    await tool.execute({ title: 'X', shared_slug: 'Payment-Flow' }, ctx('sam'));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ sharedSlug: 'payment-flow' }),
    );
  });
});

describe('update_board_task × shared_slug', () => {
  const boardWith = (update: ReturnType<typeof vi.fn>) =>
    ({
      get: async () => ({ id: 5, status: 'executing', assignee: 'alex', title: 't' }),
      update,
    }) as unknown as BoardStore;

  it('refuses a non-lead and never updates', async () => {
    const update = vi.fn();
    const tool = new UpdateBoardTaskTool(boardWith(update), employees());
    const out = await tool.execute({ id: 5, shared_slug: 'feat' }, ctx('alex'));
    expect(out).toContain("team lead's call");
    expect(update).not.toHaveBeenCalled();
  });

  it('lets the lead clear it (empty string → null)', async () => {
    const update = vi.fn(async () => ({
      id: 5,
      status: 'executing',
      assignee: 'alex',
      title: 't',
    }));
    const tool = new UpdateBoardTaskTool(boardWith(update), employees());
    await tool.execute({ id: 5, shared_slug: '' }, ctx('sam'));
    expect(update).toHaveBeenCalledWith(
      'T1',
      5,
      expect.objectContaining({ sharedSlug: null }),
    );
  });
});
