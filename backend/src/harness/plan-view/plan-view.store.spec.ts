import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { TeamTask as TeamTaskEntity } from '@workspace/shared/schemas';
import { PlanViewStore } from './plan-view.store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISO = '2026-06-19T00:00:00.000Z';

/**
 * Build a PlanViewStore whose `repo.manager.query` is a vi.fn() returning the supplied results in
 * sequence (one per successive query call). The store issues a deterministic query order:
 *   getPlan → [task, plan, run, sections, phases]   (sections/phases skipped when no run)
 *   getBoard → [tasks]
 */
function buildStore(queryResults: unknown[]) {
  let call = 0;
  const query = vi.fn((_sql: string, _params?: unknown[]) =>
    Promise.resolve(queryResults[call++] ?? []),
  );
  const repo = { manager: { query } } as unknown as Repository<TeamTaskEntity>;
  return { store: new PlanViewStore(repo), query };
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    project: 'backend',
    title: 'Add the widget',
    description: 'Do the work',
    status: 'planning',
    assignee: 'atlas',
    created_by: 'atlas',
    depends_on: [3, 4],
    shared_slug: null,
    created_at: ISO,
    updated_at: ISO,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getPlan
// ---------------------------------------------------------------------------

describe('PlanViewStore.getPlan', () => {
  it('returns null when the task does not exist for the tenant', async () => {
    const { store, query } = buildStore([[]]);
    expect(await store.getPlan('team', 99)).toBeNull();
    // short-circuits: no plan / pipeline queries issued
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns the task with null plan + null pipeline when neither exists', async () => {
    const { store } = buildStore([
      [taskRow()], // task
      [], // plan
      [], // run
    ]);
    const result = await store.getPlan('team', 7);
    expect(result).not.toBeNull();
    expect(result!.task.id).toBe(7);
    expect(result!.task.dependsOn).toEqual([3, 4]);
    expect(result!.currentPlan).toBeNull();
    expect(result!.pipeline).toBeNull();
  });

  it('merges the current plan and the pipeline sections/phases', async () => {
    const { store } = buildStore([
      [taskRow()],
      [
        {
          id: 11,
          task_id: 7,
          employee: 'phase_backend',
          plan_md: '# current\n```mermaid\ngraph TD;A-->B\n```',
          lead_status: 'approved',
          owner_status: 'executing',
          pr_url: null,
          created_at: ISO,
          updated_at: ISO,
        },
      ],
      [
        {
          id: 'run-1',
          task_id: 7,
          pipeline: 'feature',
          kind: 'feature',
          status: 'paused',
          planning_substep: 'gate',
          overview: 'the whole feature',
          active_section_id: 'sec-1',
          section_index: 0,
          phase_index: 0,
          created_at: ISO,
          updated_at: ISO,
        },
      ],
      [
        {
          id: 'sec-1',
          ordinal: 10,
          name: 'backend',
          brief: 'api work',
          phase_role: 'phase_backend',
          status: 'building',
          plan_md: '## backend plan',
          depends_on: [],
        },
        {
          id: 'sec-2',
          ordinal: 20,
          name: 'frontend',
          brief: 'ui work',
          phase_role: 'phase_frontend',
          status: 'pending',
          plan_md: null,
          depends_on: [10],
        },
      ],
      [
        { id: 'ph-1', section_id: 'sec-1', ordinal: 10, plan_phase_id: 1, title: 'setup', status: 'done' },
        { id: 'ph-2', section_id: 'sec-1', ordinal: 20, plan_phase_id: 2, title: 'code', status: 'building' },
        { id: 'ph-3', section_id: 'sec-2', ordinal: 10, plan_phase_id: 1, title: 'ui', status: 'pending' },
      ],
    ]);

    const result = await store.getPlan('team', 7);
    expect(result!.currentPlan).toMatchObject({
      id: 11,
      taskId: 7,
      leadStatus: 'approved',
      ownerStatus: 'executing',
    });
    expect(result!.currentPlan!.planMd).toContain('```mermaid');

    const pipe = result!.pipeline!;
    expect(pipe.id).toBe('run-1');
    expect(pipe.status).toBe('paused');
    expect(pipe.sections).toHaveLength(2);

    // phases are grouped under the correct section, in order
    expect(pipe.sections[0].phases.map((p) => p.id)).toEqual(['ph-1', 'ph-2']);
    expect(pipe.sections[1].phases.map((p) => p.id)).toEqual(['ph-3']);

    // each section carries its own archived plan + dependency edges
    expect(pipe.sections[0].planMd).toBe('## backend plan');
    expect(pipe.sections[1].planMd).toBeNull();
    expect(pipe.sections[1].dependsOn).toEqual([10]);
  });

  it('coerces string ids/ordinals from the pg driver to numbers', async () => {
    const { store } = buildStore([
      [taskRow({ id: '7', depends_on: null })],
      [],
      [],
    ]);
    const result = await store.getPlan('team', 7);
    expect(result!.task.id).toBe(7);
    // null depends_on normalizes to an empty array
    expect(result!.task.dependsOn).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getBoard
// ---------------------------------------------------------------------------

describe('PlanViewStore.getBoard', () => {
  it('maps every board row to a BoardTaskView', async () => {
    const { store } = buildStore([
      [taskRow({ id: 1, title: 'A' }), taskRow({ id: 2, title: 'B', depends_on: null })],
    ]);
    const board = await store.getBoard('team');
    expect(board).toHaveLength(2);
    expect(board[0]).toMatchObject({ id: 1, title: 'A', dependsOn: [3, 4] });
    expect(board[1]).toMatchObject({ id: 2, title: 'B', dependsOn: [] });
  });
});
