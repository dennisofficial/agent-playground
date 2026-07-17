/**
 * Live-Postgres proof of the `jobs_stamp_section_entered` trigger's first-entry-only semantics
 * (see `section-stamp.constants.ts` + `JobEntity.section_first_entered`): the anchor timestamp for a
 * status is stamped once, on first entry, and a later re-entry into the SAME status is a no-op — the
 * anchor never moves. Runs the exported `SECTION_STAMP_DDL` constant directly against the test DB
 * (rather than booting `SectionStampService`, which is leader-gated) so the test can't drift from the
 * real DDL.
 */

import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../../persistence/database.module';
import { ENTITIES } from '../../persistence/entities';
import { SECTION_STAMP_DDL } from '../section-stamp.constants';

const ORG_ID = '33333333-3333-4333-8333-333333333333';
const REPO_ID = '44444444-4444-4444-8444-444444444444';

function dbOpts() {
  return {
    name: DB_CONNECTION,
    type: 'postgres' as const,
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5433),
    username: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    database: process.env.POSTGRES_DB,
    entities: ENTITIES,
    namingStrategy: new CustomNamingStrategy(),
    synchronize: false,
    connectTimeoutMS: 10_000,
    ssl: false as const,
  };
}

async function purge(ds: DataSource): Promise<void> {
  await ds.query(`DELETE FROM jobs WHERE org_id = $1`, [ORG_ID]);
  await ds.query(`DELETE FROM repos WHERE org_id = $1`, [ORG_ID]);
  await ds.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID]);
}

describe('jobs_stamp_section_entered trigger (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dbOpts())],
    }).compile();
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    await purge(ds);
    await ds.query(SECTION_STAMP_DDL);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Section Stamp Org', 'section-stamp-org', 'active')`,
      [ORG_ID],
    );
    await ds.query(
      `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
       VALUES ($1, $2, 'section-stamp-repo', 'Section Stamp Repo', 'https://github.com/x/y.git', 'main', true)`,
      [REPO_ID, ORG_ID],
    );
  });

  afterAll(async () => {
    if (ds) await purge(ds).catch(() => undefined);
    await mod?.close();
  });

  it('stamps a status on first entry only — a re-entry into the same status leaves the anchor unchanged', async () => {
    const jobRows = await ds.query(
      `INSERT INTO jobs (org_id, repo_id, origin, status) VALUES ($1, $2, 'control', 'open') RETURNING id, section_first_entered`,
      [ORG_ID, REPO_ID],
    );
    const jobId = jobRows[0].id as string;
    expect(jobRows[0].section_first_entered).toEqual({
      open: expect.any(String),
    });

    // Enter 'planning' for the first time — a new anchor key is stamped.
    await ds.query(`UPDATE jobs SET status = 'planning' WHERE id = $1`, [jobId]);
    const afterPlanning = await ds.query(`SELECT section_first_entered FROM jobs WHERE id = $1`, [
      jobId,
    ]);
    const firstPlanningAnchor = afterPlanning[0].section_first_entered.planning as string;
    expect(firstPlanningAnchor).toEqual(expect.any(String));

    // Move on to 'running', then kick back to 'planning' — a RE-entry into a status already anchored.
    await ds.query(`UPDATE jobs SET status = 'running' WHERE id = $1`, [jobId]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ds.query(`UPDATE jobs SET status = 'planning' WHERE id = $1`, [jobId]);

    const afterReentry = await ds.query(`SELECT section_first_entered FROM jobs WHERE id = $1`, [
      jobId,
    ]);
    const map = afterReentry[0].section_first_entered as Record<string, string>;
    // The re-entry anchor must be UNCHANGED — first-entry-only, never overwritten.
    expect(map.planning).toBe(firstPlanningAnchor);
    // Every status the job passed through accumulates — the map only ever grows.
    expect(Object.keys(map).sort()).toEqual(['open', 'planning', 'running']);
  });
});
