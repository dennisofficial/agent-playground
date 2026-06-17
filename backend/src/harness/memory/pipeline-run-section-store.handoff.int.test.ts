import {
  ENTITIES,
  PipelineCodingSession as PipelineCodingSessionEntity,
  PipelineRun as PipelineRunEntity,
  PipelineRunSection as PipelineRunSectionEntity,
} from '@workspace/shared/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { PipelineRunStore } from './pipeline-run-store';
import {
  PipelineRunSectionStore,
  phaseGroups,
} from './pipeline-run-section-store';
import { PipelineCodingSessionStore } from './pipeline-coding-session-store';

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

// Live-Postgres round-trips for Phase 4's grouped execution: the per-phase `group` number persists
// through the section's `phases_json` jsonb (and folds via phaseGroups), and the inter-group handoff
// persists through the coding session's `handoff_in`/`handoff_out` columns (the Phase-2 storage we
// reuse instead of a redundant section-level handoff column). The rows ARE the cursor, so a bad cast
// or a dropped field must fail here, not mid-run in production.
describe('Pipeline grouping + handoff round-trip (live Postgres)', () => {
  let ds: DataSource;
  let runs: PipelineRunStore;
  let sections: PipelineRunSectionStore;
  let coding: PipelineCodingSessionStore;

  beforeAll(async () => {
    ds = makeDataSource();
    await ds.initialize();
    runs = new PipelineRunStore(ds.getRepository(PipelineRunEntity));
    sections = new PipelineRunSectionStore(
      ds.getRepository(PipelineRunSectionEntity),
    );
    coding = new PipelineCodingSessionStore(
      ds.getRepository(PipelineCodingSessionEntity),
    );
  });
  afterAll(async () => {
    await ds?.destroy();
  });
  beforeEach(async () => {
    await ds.query(
      'TRUNCATE pipeline_runs, pipeline_run_sections, pipeline_coding_sessions',
    );
  });

  const newRun = () => runs.create({ team: 'T1', taskId: 7, pipeline: 'dynamic' });

  it('persists per-phase `group` through phases_json and folds it into coding-session groups', async () => {
    const run = await newRun();
    const [section] = await sections.createMany(run.id, 'T1', [
      { ordinal: 10, name: 'backend', phaseRole: 'phase_backend' },
    ]);
    // A [1,1,2] grouping: phases 1 & 2 share a coding session, phase 3 is its own.
    await sections.update(section.id, {
      phaseCount: 3,
      phases: [
        { id: 1, title: 'schema', group: 1 },
        { id: 2, title: 'service', group: 1 },
        { id: 3, title: 'frontend', group: 2 },
      ],
    });
    const reread = await sections.get(section.id);
    expect(reread?.phases?.map((p) => p.group)).toEqual([1, 1, 2]);
    // The store-side fold matches the grouping.
    const groups = phaseGroups(reread!.phases!);
    expect(groups.map((g) => g.phases.map((p) => p.id))).toEqual([[1, 2], [3]]);
  });

  it('persists the inter-group handoff through coding-session handoff_in/handoff_out', async () => {
    const run = await newRun();
    const [section] = await sections.createMany(run.id, 'T1', [
      { ordinal: 10, name: 'backend', phaseRole: 'phase_backend' },
    ]);
    const made = await coding.createMany(run.id, 'T1', section.id, [
      { ordinal: 10 },
      { ordinal: 20 },
    ]);
    // Group 1 leaves a handoff; group 2 inherits it.
    await coding.update(made[0].id, {
      status: 'done',
      handoffOut: 'Exposed POST /api/upload (multipart). Stubbed the virus scan.',
    });
    await coding.update(made[1].id, {
      status: 'building',
      handoffIn: 'Exposed POST /api/upload (multipart). Stubbed the virus scan.',
    });
    const g1 = await coding.get(made[0].id);
    const g2 = await coding.get(made[1].id);
    expect(g1?.handoffOut).toContain('POST /api/upload');
    expect(g1?.handoffIn).toBeUndefined();
    expect(g2?.handoffIn).toContain('POST /api/upload');
    expect(g2?.status).toBe('building');
  });

  it('navigates groups by status: activeCodingSession / nextPending / deletePending', async () => {
    const run = await newRun();
    const [section] = await sections.createMany(run.id, 'T1', [
      { ordinal: 10, name: 'backend', phaseRole: 'phase_backend' },
    ]);
    const made = await coding.createMany(run.id, 'T1', section.id, [
      { ordinal: 10 },
      { ordinal: 20 },
      { ordinal: 30 },
    ]);
    expect(await coding.activeCodingSession(section.id)).toBeUndefined();
    expect((await coding.nextPending(section.id))?.ordinal).toBe(10);

    await coding.update(made[0].id, { status: 'building' });
    expect((await coding.activeCodingSession(section.id))?.ordinal).toBe(10);
    expect((await coding.nextPending(section.id))?.ordinal).toBe(20);

    // Drop the still-pending tail (groups 2 & 3) — the building group survives (renegotiable grouping).
    const removed = await coding.deletePending(section.id);
    expect(removed).toBe(2);
    expect((await coding.listForSection(section.id)).map((c) => c.ordinal)).toEqual([
      10,
    ]);
  });
});
