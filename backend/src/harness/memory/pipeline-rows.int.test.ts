import {
  ENTITIES,
  PipelineCodingSession as PipelineCodingSessionEntity,
  PipelinePhaseReview as PipelinePhaseReviewEntity,
  PipelineRun as PipelineRunEntity,
  PipelineRunPhase as PipelineRunPhaseEntity,
  PipelineRunSection as PipelineRunSectionEntity,
} from '@workspace/shared/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { PipelineRunStore } from './pipeline-run-store';
import { PipelineRunSectionStore } from './pipeline-run-section-store';
import { PipelineRunPhaseStore } from './pipeline-run-phase-store';
import { PipelineCodingSessionStore } from './pipeline-coding-session-store';
import { PipelinePhaseReviewStore } from './pipeline-phase-review-store';

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

// Live-Postgres round-trips for the explicit-row state model (Phase 2): phase / coding-session /
// review rows, and the SectionStore living-section navigation (depends_on int[], nextPending topo,
// frozen-wedge guard, atomic reorder). These exist because the rows ARE the cursor now — a bad cast
// or a broken array column must fail loudly here, not mid-run in production.
describe('Pipeline explicit-row stores (live Postgres)', () => {
  let ds: DataSource;
  let runs: PipelineRunStore;
  let sections: PipelineRunSectionStore;
  let phases: PipelineRunPhaseStore;
  let coding: PipelineCodingSessionStore;
  let reviews: PipelinePhaseReviewStore;

  beforeAll(async () => {
    ds = makeDataSource();
    await ds.initialize();
    runs = new PipelineRunStore(ds.getRepository(PipelineRunEntity));
    sections = new PipelineRunSectionStore(
      ds.getRepository(PipelineRunSectionEntity),
    );
    phases = new PipelineRunPhaseStore(ds.getRepository(PipelineRunPhaseEntity));
    coding = new PipelineCodingSessionStore(
      ds.getRepository(PipelineCodingSessionEntity),
    );
    reviews = new PipelinePhaseReviewStore(
      ds.getRepository(PipelinePhaseReviewEntity),
    );
  });
  afterAll(async () => {
    await ds?.destroy();
  });
  beforeEach(async () => {
    await ds.query(
      'TRUNCATE pipeline_runs, pipeline_run_sections, pipeline_run_phases, pipeline_coding_sessions, pipeline_phase_reviews',
    );
  });

  const newRun = () => runs.create({ team: 'T1', taskId: 7, pipeline: 'dynamic' });

  it('round-trips phase rows + coding-session link + active/next navigation', async () => {
    const run = await newRun();
    const [section] = await sections.createMany(run.id, 'T1', [
      { ordinal: 10, name: 'backend', phaseRole: 'phase_backend' },
    ]);
    const cs = await coding.createMany(run.id, 'T1', section.id, [
      { ordinal: 10 },
      { ordinal: 20 },
    ]);
    const made = await phases.createMany(run.id, 'T1', section.id, [
      { ordinal: 10, planPhaseId: 1, title: 'schema', codingSessionId: cs[0].id },
      { ordinal: 20, planPhaseId: 2, title: 'api', codingSessionId: cs[1].id },
    ]);
    expect(made.map((p) => p.planPhaseId)).toEqual([1, 2]);
    expect(made[0].codingSessionId).toBe(cs[0].id);

    // No phase live yet.
    expect(await phases.activePhase(section.id)).toBeUndefined();
    expect((await phases.nextPending(section.id))?.ordinal).toBe(10);

    await phases.update(made[0].id, { status: 'building' });
    expect((await phases.activePhase(section.id))?.ordinal).toBe(10);
    await phases.update(made[0].id, { status: 'reviewing' });
    expect((await phases.activePhase(section.id))?.status).toBe('reviewing');
    await phases.update(made[0].id, { status: 'done' });
    expect(await phases.activePhase(section.id)).toBeUndefined();
    expect((await phases.nextPending(section.id))?.ordinal).toBe(20); // first done → next pending
  });

  it('round-trips coding sessions incl. engine handle + handoff', async () => {
    const run = await newRun();
    const [section] = await sections.createMany(run.id, 'T1', [
      { ordinal: 10, name: 'backend', phaseRole: 'phase_backend' },
    ]);
    const [cs] = await coding.createMany(run.id, 'T1', section.id, [{ ordinal: 10 }]);
    expect(cs.status).toBe('pending');
    const updated = await coding.update(cs.id, {
      status: 'building',
      engineSessionId: 'sess-99',
      handoffOut: 'left the API stub for the FE group',
    });
    expect(updated?.engineSessionId).toBe('sess-99');
    expect(updated?.handoffOut).toContain('API stub');
    expect((await coding.get(cs.id))?.status).toBe('building');
  });

  it('round-trips phase reviews incl. attempt + verdict', async () => {
    const run = await newRun();
    const [section] = await sections.createMany(run.id, 'T1', [
      { ordinal: 10, name: 'backend', phaseRole: 'phase_backend' },
    ]);
    const [phase] = await phases.createMany(run.id, 'T1', section.id, [
      { ordinal: 10, planPhaseId: 1 },
    ]);
    const r1 = await reviews.create(run.id, 'T1', {
      phaseId: phase.id,
      attempt: 1,
      engineSessionId: 'rev-1',
    });
    expect(r1.status).toBe('running');
    expect(r1.blocker).toBeUndefined();
    await reviews.update(r1.id, { status: 'done', blocker: false, summary: 'ok' });
    const r2 = await reviews.create(run.id, 'T1', {
      phaseId: phase.id,
      attempt: 2,
    });
    expect((await reviews.listForPhase(phase.id)).map((r) => r.attempt)).toEqual([
      1, 2,
    ]);
    expect((await reviews.latestForPhase(phase.id))?.attempt).toBe(2);
    void r2;
    const done = (await reviews.listForPhase(phase.id))[0];
    expect(done.blocker).toBe(false);
    expect(done.summary).toBe('ok');
  });

  it('deleteForSection clears a section\'s phases, coding sessions, and reviews (reopen path)', async () => {
    const run = await newRun();
    const [section] = await sections.createMany(run.id, 'T1', [
      { ordinal: 10, name: 'backend', phaseRole: 'phase_backend' },
    ]);
    const [cs] = await coding.createMany(run.id, 'T1', section.id, [
      { ordinal: 10 },
    ]);
    const [phase] = await phases.createMany(run.id, 'T1', section.id, [
      { ordinal: 10, planPhaseId: 1, codingSessionId: cs.id },
    ]);
    await reviews.create(run.id, 'T1', { phaseId: phase.id, attempt: 1 });
    // Sanity: everything is present.
    expect((await phases.listForSection(section.id)).length).toBe(1);
    expect((await coding.listForSection(section.id)).length).toBe(1);
    expect((await reviews.listForPhase(phase.id)).length).toBe(1);

    // Reviews delete via a phase-id subquery, so run that BEFORE the phase rows are dropped.
    expect(await reviews.deleteForSection(section.id)).toBe(1);
    expect(await phases.deleteForSection(section.id)).toBe(1);
    expect(await coding.deleteForSection(section.id)).toBe(1);
    expect((await phases.listForSection(section.id)).length).toBe(0);
    expect((await coding.listForSection(section.id)).length).toBe(0);
    expect((await reviews.listForPhase(phase.id)).length).toBe(0);
    // The section row itself survives (it's reset to planning, not deleted).
    expect((await sections.listForRun(run.id)).length).toBe(1);
  });

  it('round-trips depends_on int[] + frozen + active_session_id; nextPending is topological', async () => {
    const run = await newRun();
    await sections.createMany(run.id, 'T1', [
      { ordinal: 10, name: 'backend', phaseRole: 'phase_backend' },
      // frontend depends on a LATER ordinal (the prompt-eng section at 30) — so it isn't runnable until
      // that one lands, even though it sorts earlier.
      { ordinal: 20, name: 'frontend', phaseRole: 'phase_frontend', dependsOn: [30] },
      { ordinal: 30, name: 'prompt-eng', phaseRole: 'phase_backend' },
    ]);
    const listed = await sections.listForRun(run.id);
    expect(listed[1].dependsOn).toEqual([30]);
    expect(listed[0].frozen).toBe(false);

    // backend (10) has no deps → picked first.
    expect((await sections.nextPending(run.id))?.name).toBe('backend');
    await sections.update(listed[0].id, { status: 'done', frozen: true });
    // frontend (20) still blocked on prompt-eng (30); prompt-eng is runnable → picked despite ordinal.
    expect((await sections.nextPending(run.id))?.name).toBe('prompt-eng');
    await sections.update(listed[2].id, { status: 'done' });
    // now frontend's dep is satisfied.
    expect((await sections.nextPending(run.id))?.name).toBe('frontend');

    const withSess = await sections.update(listed[0].id, {
      activeSessionId: 'sess-7',
    });
    expect(withSess?.activeSessionId).toBe('sess-7');
    expect((await sections.get(listed[0].id))?.frozen).toBe(true);
  });

  it('activeSection returns the live (planning/building/awaiting_design) section', async () => {
    const run = await newRun();
    const [s1, s2] = await sections.createMany(run.id, 'T1', [
      { ordinal: 10, name: 'backend', phaseRole: 'phase_backend' },
      { ordinal: 20, name: 'frontend', phaseRole: 'phase_frontend' },
    ]);
    expect(await sections.activeSection(run.id)).toBeUndefined();
    await sections.update(s1.id, { status: 'building' });
    expect((await sections.activeSection(run.id))?.name).toBe('backend');
    await sections.update(s1.id, { status: 'done' });
    await sections.update(s2.id, { status: 'planning' });
    expect((await sections.activeSection(run.id))?.name).toBe('frontend');
  });

  it('insertSection wedges at the midpoint, refuses before frozen work, refuses forward deps', async () => {
    const run = await newRun();
    const [backend, frontend, analytics] = await sections.createMany(run.id, 'T1', [
      { ordinal: 10, name: 'backend', phaseRole: 'phase_backend' },
      { ordinal: 20, name: 'frontend', phaseRole: 'phase_frontend' },
      { ordinal: 30, name: 'analytics', phaseRole: 'phase_backend' },
    ]);
    // backend + frontend have committed work → frozen; analytics is the pending tail.
    await sections.update(backend.id, { status: 'building', frozen: true });
    await sections.update(frontend.id, { status: 'building', frozen: true });

    // Wedge after analytics (pending) → midpoint after 30 = 40 (no next), depends on the anchor.
    const after = await sections.insertSection(run.id, 'T1', analytics.ordinal, {
      name: 'docs',
      phaseRole: 'phase_backend',
    });
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.section.ordinal).toBe(40);
      expect(after.section.dependsOn).toEqual([30]); // defaults to the anchor
      expect(after.section.status).toBe('pending');
    }

    // Wedging BETWEEN the two frozen sections (after backend → midpoint 15, before frozen frontend 20)
    // is refused: you can never land a section before committed work.
    const wedge = await sections.insertSection(run.id, 'T1', backend.ordinal, {
      name: 'nope',
      phaseRole: 'phase_backend',
    });
    expect(wedge.ok).toBe(false);

    // A non-existent anchor is refused.
    const noAnchor = await sections.insertSection(run.id, 'T1', 999, {
      name: 'nope',
      phaseRole: 'phase_backend',
    });
    expect(noAnchor.ok).toBe(false);

    // A forward dependency (on a section that isn't strictly earlier) is rejected.
    const forward = await sections.insertSection(run.id, 'T1', analytics.ordinal, {
      name: 'bad',
      phaseRole: 'phase_backend',
      dependsOn: [9999],
    });
    expect(forward.ok).toBe(false);
  });

  it('appendSection always adds after the last section (legal after committed work)', async () => {
    const run = await newRun();
    const [backend] = await sections.createMany(run.id, 'T1', [
      { ordinal: 10, name: 'backend', phaseRole: 'phase_backend' },
    ]);
    await sections.update(backend.id, { status: 'building', frozen: true });
    const appended = await sections.appendSection(run.id, 'T1', {
      name: 'docs',
      phaseRole: 'phase_backend',
    });
    expect(appended.ok).toBe(true);
    if (appended.ok) {
      expect(appended.section.ordinal).toBe(20); // max(10) + 10
      expect(appended.section.status).toBe('pending');
      expect(appended.section.dependsOn).toEqual([]);
    }
  });

  it('reorderSections moves only pending sections, atomically, and refuses a building section', async () => {
    const run = await newRun();
    const [backend, frontend, analytics] = await sections.createMany(run.id, 'T1', [
      { ordinal: 10, name: 'backend', phaseRole: 'phase_backend' },
      { ordinal: 20, name: 'frontend', phaseRole: 'phase_frontend' },
      { ordinal: 30, name: 'analytics', phaseRole: 'phase_backend' },
    ]);
    // backend is building (committed); frontend + analytics are pending.
    await sections.update(backend.id, { status: 'building', frozen: true });

    // Swap the two pending sections.
    const ok = await sections.reorderSections(run.id, 'T1', ['analytics', 'frontend']);
    expect(ok.ok).toBe(true);
    const after = await sections.listForRun(run.id);
    // backend keeps ordinal 10; the pending pair is rewritten after it, in the new order.
    expect(after.map((s) => s.name)).toEqual(['backend', 'analytics', 'frontend']);
    expect(after.find((s) => s.name === 'backend')?.ordinal).toBe(10);

    // Listing a non-pending (building) section is refused — nothing changes.
    const refused = await sections.reorderSections(run.id, 'T1', [
      'backend',
      'analytics',
      'frontend',
    ]);
    expect(refused.ok).toBe(false);
    void frontend;
    void analytics;
    const unchanged = await sections.listForRun(run.id);
    expect(unchanged.map((s) => s.name)).toEqual([
      'backend',
      'analytics',
      'frontend',
    ]);
  });

  it('reorderSections remaps depends_on so the dependency graph survives the rewrite', async () => {
    const run = await newRun();
    const [, frontend] = await sections.createMany(run.id, 'T1', [
      { ordinal: 10, name: 'api', phaseRole: 'phase_backend' },
      // frontend depends on analytics (ordinal 30).
      { ordinal: 20, name: 'frontend', phaseRole: 'phase_frontend', dependsOn: [30] },
      { ordinal: 30, name: 'analytics', phaseRole: 'phase_backend' },
    ]);
    void frontend;
    // Requesting frontend BEFORE analytics breaks the dependency → rejected.
    const bad = await sections.reorderSections(run.id, 'T1', [
      'frontend',
      'analytics',
      'api',
    ]);
    expect(bad.ok).toBe(false);

    // Valid reorder (analytics first, then frontend) → deps remapped to the new ordinals.
    const good = await sections.reorderSections(run.id, 'T1', [
      'api',
      'analytics',
      'frontend',
    ]);
    expect(good.ok).toBe(true);
    const after = await sections.listForRun(run.id);
    const fe = after.find((s) => s.name === 'frontend')!;
    const an = after.find((s) => s.name === 'analytics')!;
    expect(fe.dependsOn).toEqual([an.ordinal]); // remapped to analytics' new ordinal
    expect(an.ordinal).toBeLessThan(fe.ordinal); // dep still points backward
  });
});
