import {
  ENTITIES,
  PipelineRun as PipelineRunEntity,
  PipelineRunSection as PipelineRunSectionEntity,
} from '@workspace/shared/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { PipelineRunStore } from './pipeline-run-store';
import { PipelineRunSectionStore } from './pipeline-run-section-store';

function makeDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    username: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
    entities: ENTITIES,
    synchronize: false,
  });
}

// This suite exists because NO test previously round-tripped pipeline_runs through real Postgres —
// the gap that let the `current_role` reserved-word bug ship. It exercises the raw SQL against a live
// DB so a reserved-word column or a bad jsonb cast fails loudly here, not in production.
describe('PipelineRunStore + PipelineRunSectionStore (live Postgres)', () => {
  let ds: DataSource;
  let runs: PipelineRunStore;
  let sections: PipelineRunSectionStore;

  beforeAll(async () => {
    ds = makeDataSource();
    await ds.initialize();
    runs = new PipelineRunStore(ds.getRepository(PipelineRunEntity));
    sections = new PipelineRunSectionStore(
      ds.getRepository(PipelineRunSectionEntity),
    );
  });
  afterAll(async () => {
    await ds?.destroy();
  });
  beforeEach(async () => {
    await ds.query('TRUNCATE pipeline_runs, pipeline_run_sections');
  });

  it('round-trips a run through create/get/update incl. the reserved-word current_role + cursor', async () => {
    const created = await runs.create({
      team: 'T1',
      taskId: 7,
      pipeline: 'feature',
      worktreeId: 'wt-1',
      notifyThread: 'slack:T1:C1',
      project: 'proj',
      currentRole: 'phase_backend', // the reserved-word column
    });
    expect(created.kind).toBe('feature'); // default
    expect(created.sectionIndex).toBe(0);
    expect(created.phaseIndex).toBe(0);
    expect(created.planningSubstep).toBeUndefined();
    expect(created.currentRole).toBe('phase_backend');

    const updated = await runs.update('T1', created.id, {
      status: 'paused',
      sectionIndex: 1,
      phaseIndex: 2,
      planningSubstep: 'gate',
      currentRole: null,
    });
    expect(updated?.status).toBe('paused');
    expect(updated?.sectionIndex).toBe(1);
    expect(updated?.phaseIndex).toBe(2);
    expect(updated?.planningSubstep).toBe('gate');
    expect(updated?.currentRole).toBeUndefined();

    const fetched = await runs.getByTask('T1', 7);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.planningSubstep).toBe('gate');
  });

  it('persists a bugfix run kind', async () => {
    const bug = await runs.create({
      team: 'T1',
      taskId: 9,
      pipeline: 'bugfix',
      kind: 'bugfix',
      worktreeId: 'wt-2',
    });
    expect(bug.kind).toBe('bugfix');
    expect((await runs.getByTask('T1', 9))?.kind).toBe('bugfix');
  });

  it('round-trips sections incl. the jsonb phases manifest', async () => {
    const run = await runs.create({ team: 'T1', taskId: 7, pipeline: 'feature' });
    const made = await sections.createMany(run.id, 'T1', [
      { ordinal: 10, name: 'backend', phaseRole: 'phase_backend', brief: 'API' },
      { ordinal: 20, name: 'frontend', phaseRole: 'phase_frontend' },
    ]);
    expect(made.map((s) => s.name)).toEqual(['backend', 'frontend']);

    const listed = await sections.listForRun(run.id);
    expect(listed.map((s) => s.ordinal)).toEqual([10, 20]); // ordinal-ordered
    expect(listed[0].status).toBe('pending');

    const archived = await sections.update(listed[0].id, {
      status: 'building',
      planMd: '# Backend plan\n\n```phases\n[]\n```',
      phases: [
        { id: 1, title: 'schema', reviewed: true },
        { id: 2, title: 'api' },
      ],
      phaseCount: 2,
    });
    expect(archived?.status).toBe('building');
    expect(archived?.phaseCount).toBe(2);
    expect(archived?.phases).toEqual([
      { id: 1, title: 'schema', reviewed: true },
      { id: 2, title: 'api' },
    ]);
    expect(archived?.planMd).toContain('Backend plan');
  });
});
