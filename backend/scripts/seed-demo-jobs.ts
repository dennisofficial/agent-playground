import 'reflect-metadata';

import type { DataSource } from 'typeorm';
import { AppDataSource } from '../cli/data-source';
import {
  JobEntity,
  MessageEntity,
  RepoEntity,
  StepEntity,
  ThreadEntity,
} from '../src/app/persistence/entities';
import { DEV_SEED_IDS } from '../seeds/_shared/dev-seed-ids';

/**
 * Standalone demo-data seeder — idempotently upserts a spread of DUMMY jobs (+ one rich job's
 * threads/steps/messages) onto the already-seeded demo org/repo, so the responsive web console
 * renders content at every sidebar section and breakpoint. Every row uses a STABLE hardcoded uuid
 * (the `da700000-…` demo namespace) so re-running this script never creates duplicates — it's a
 * pure upsert-by-id.
 *
 *   pnpm seed:demo
 */

const ORG_ID = DEV_SEED_IDS.orgs.atlasTest;
const REPO_1_ID = DEV_SEED_IDS.repos.testRepo;

/** A second demo repo so the sidebar's org/repo tree is deep enough to test scroll + collapse. */
const REPO_2_ID = 'da700000-0000-4000-8000-000000000001';

/** The one job that also gets threads/steps/messages, for Navigator/Conversation/Detail content. */
export const RICH_JOB_ID = 'da700000-0000-4000-8000-000000000104';

const jobId = (n: number): string =>
  `da700000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const threadId = (n: number): string =>
  `da700000-0000-4000-8000-000000002${String(n).padStart(3, '0')}`;
const stepId = (n: number): string =>
  `da700000-0000-4000-8000-000000003${String(n).padStart(3, '0')}`;
const messageId = (n: number): string =>
  `da700000-0000-4000-8000-000000004${String(n).padStart(3, '0')}`;

type DemoJob = {
  id: string;
  repo_id: string;
  kind: 'feature' | 'bugfix';
  title: string;
  status: string;
  ship_review_approved_at?: Date;
  pr_state?: 'open' | 'merged';
  pr_url?: string;
  pr_number?: number;
  halted?: boolean;
  halt?: { at: string; kind: 'failed'; reason: string };
  section: string;
};

// Do not seed unhalted `running` rows here: the real backend boot sweep treats those as resumable
// build work. A halted `running` row is safe because the driver only retries it after explicit operator
// re-engagement, while still giving the responsive UI a phase-preserving halt fixture.
const DEMO_JOBS: DemoJob[] = [
  {
    id: jobId(1),
    repo_id: REPO_1_ID,
    kind: 'feature',
    title: 'Add CSV export to reports',
    status: 'planning',
    section: 'planning',
  },
  {
    id: jobId(2),
    repo_id: REPO_2_ID,
    kind: 'bugfix',
    title: 'Fix flaky sandbox teardown',
    status: 'planning',
    section: 'planning',
  },
  {
    id: jobId(3),
    repo_id: REPO_1_ID,
    kind: 'feature',
    title:
      'Investigate and fix the intermittent race condition where the ship-review approval click can fire twice in rapid succession under slow network conditions, double-posting the approval event',
    status: 'awaiting_approval',
    section: 'awaiting',
  },
  {
    id: jobId(4),
    repo_id: REPO_1_ID,
    kind: 'feature',
    title:
      'Implement real-time collaborative cursor presence in the job workspace conversation view',
    status: 'awaiting_ship_review',
    section: 'ready_to_ship (rich job)',
  },
  {
    id: jobId(5),
    repo_id: REPO_1_ID,
    kind: 'bugfix',
    title: 'Retry webhook delivery on 5xx',
    status: 'running',
    halted: true,
    halt: {
      at: new Date('2026-07-09T18:42:00.000Z').toISOString(),
      kind: 'failed',
      reason:
        'Verification command exited 1: `pnpm test:e2e` — 3 failing specs in webhook-delivery.spec.ts',
    },
    section: 'building (halted)',
  },
  {
    id: jobId(6),
    repo_id: REPO_1_ID,
    kind: 'feature',
    title: 'Polish onboarding empty states',
    status: 'awaiting_ship_review',
    section: 'ready_to_ship',
  },
  {
    id: jobId(7),
    repo_id: REPO_2_ID,
    kind: 'feature',
    title: 'Add repo webhook re-validation button',
    status: 'awaiting_ship_review',
    section: 'ready_to_ship (awaiting_ship_review)',
  },
  {
    id: jobId(8),
    repo_id: REPO_1_ID,
    kind: 'feature',
    title: 'Spike: evaluate pgvector index tuning',
    status: 'done',
    section: 'done',
  },
  {
    id: jobId(9),
    repo_id: REPO_1_ID,
    kind: 'feature',
    title: 'Add dark mode toggle to settings',
    status: 'done',
    pr_state: 'open',
    pr_url: 'https://github.com/dennisofficial/test-repo/pull/42',
    pr_number: 42,
    section: 'pr_open',
  },
  {
    id: jobId(10),
    repo_id: REPO_2_ID,
    kind: 'bugfix',
    title: 'Migrate steps table index to include leg_ordinal',
    status: 'done',
    pr_state: 'merged',
    pr_url: 'https://github.com/dennisofficial/demo-repo-2/pull/7',
    pr_number: 7,
    section: 'merged',
  },
  {
    id: jobId(11),
    repo_id: REPO_2_ID,
    kind: 'bugfix',
    title: 'Bug: flaky test',
    status: 'awaiting_approval',
    section: 'awaiting',
  },
  {
    id: jobId(12),
    repo_id: REPO_2_ID,
    kind: 'feature',
    title: 'Explore incremental adoption of streaming diffs',
    status: 'planning',
    section: 'planning',
  },
  {
    id: jobId(13),
    repo_id: REPO_2_ID,
    kind: 'feature',
    title: 'Update README',
    status: 'done',
    section: 'done',
  },
  {
    id: jobId(14),
    repo_id: REPO_1_ID,
    kind: 'bugfix',
    title: 'Cleanup dead code',
    status: 'planning',
    section: 'planning',
  },
];

type DemoThread = {
  id: string;
  ordinal: number;
  kind: 'main' | 'builder' | 'master_review';
  brief: string;
};

const RICH_THREADS: DemoThread[] = [
  { id: threadId(1), ordinal: 100, kind: 'main', brief: 'Main conversation' },
  {
    id: threadId(2),
    ordinal: 200,
    kind: 'builder',
    brief: 'Wire up presence websocket channel',
  },
  {
    id: threadId(3),
    ordinal: 300,
    kind: 'builder',
    brief: 'Render remote cursors in the editor',
  },
  {
    id: threadId(4),
    ordinal: 400,
    kind: 'master_review',
    brief: 'Master review of the full diff',
  },
];

type DemoStep = {
  id: string;
  thread_id: string;
  ordinal: number;
  brief: string;
};

const RICH_STEPS: DemoStep[] = [
  {
    id: stepId(1),
    thread_id: threadId(2),
    ordinal: 100,
    brief: 'Add presence channel to the realtime gateway',
  },
  {
    id: stepId(2),
    thread_id: threadId(2),
    ordinal: 200,
    brief: 'Broadcast cursor position on pointermove',
  },
  {
    id: stepId(3),
    thread_id: threadId(3),
    ordinal: 100,
    brief: 'Subscribe to peer cursor events client-side',
  },
  {
    id: stepId(4),
    thread_id: threadId(3),
    ordinal: 200,
    brief: 'Paint remote cursors with author color + label',
  },
];

type DemoMessage = {
  id: string;
  author: string;
  author_id: string;
  author_bot_id: string | null;
  text: string;
  kind?: string;
  meta?: Record<string, unknown> | null;
};

const RICH_MESSAGES: DemoMessage[] = [
  {
    id: messageId(1),
    author: 'Dennis',
    author_id: 'dennis',
    author_bot_id: null,
    text: 'Can we show a little colored cursor for teammates viewing the same job, like Figma?',
  },
  {
    id: messageId(2),
    author: 'Atlas',
    author_id: 'atlas',
    author_bot_id: 'atlas',
    text: "Yes — I'll add a presence channel to the realtime gateway and render remote cursors in the conversation view. Starting on the plan now.",
  },
  {
    id: messageId(3),
    author: 'Dennis',
    author_id: 'dennis',
    author_bot_id: null,
    text: 'Sounds good, go ahead.',
  },
  {
    id: messageId(4),
    author: 'Atlas',
    author_id: 'atlas',
    author_bot_id: 'atlas',
    text: [
      '```diff',
      '--- a/src/app/realtime/presence.gateway.ts',
      '+++ b/src/app/realtime/presence.gateway.ts',
      '@@ -12,6 +12,18 @@ export class PresenceGateway {',
      "   @SubscribeMessage('cursor:move')",
      '   onCursorMove(client: Socket, payload: CursorMovePayload) {',
      '+    const room = `job:${payload.jobId}`;',
      "+    client.to(room).emit('cursor:moved', {",
      '+      userId: client.data.userId,',
      '+      x: payload.x,',
      '+      y: payload.y,',
      '+    });',
      '   }',
      '```',
      '',
      'Ran `pnpm test src/app/realtime/presence.gateway.spec.ts` — 6 passed, 0 failed.',
    ].join('\n'),
  },
  {
    id: messageId(5),
    author: 'Dennis',
    author_id: 'dennis',
    author_bot_id: null,
    text: 'Nice, looks great in the preview. One nit: can the cursor label fade out after a couple seconds of inactivity?',
  },
  {
    id: messageId(6),
    author: 'Atlas',
    author_id: 'atlas',
    author_bot_id: 'atlas',
    text: 'Done — the label now fades after 2s idle and the cursor dot fades after 10s. Pushed to the branch.',
  },
  // A calm System-notice approval ack (Q2): rendered as a muted system pill, NOT in Atlas's voice.
  {
    id: messageId(7),
    author: 'System',
    author_id: 'system',
    author_bot_id: null,
    text: 'Back to planning — this plan was sent back for changes. Noted: fade the label sooner.',
    kind: 'chat',
    meta: { source: 'system_notice' },
  },
  // An `untrusted` thread-done wake row (Q1): the TRUSTED harness framing rides in `meta.framing` (its own
  // block); only the build lane's own self-report stays inside the amber fence (`text`).
  {
    id: messageId(8),
    author: 'System',
    author_id: 'system',
    author_bot_id: null,
    text: [
      'summary: presence gateway + remote-cursor rendering landed; 6 gateway tests passing.',
      'gaps:',
      '- cursor label fade timing not yet covered by an e2e test',
      'transcript: session 9f3c1a20 (Leg 2) — inspect with: atlas-tx show 9f3c1a20 --errors' +
        '  (also --thinking / --tools / cat | jq)',
    ].join('\n'),
    kind: 'chat',
    meta: {
      source: 'untrusted',
      untrustedSource: 'thread-done:presence-gateway',
      severity: 'final',
      framing: [
        'An AUTONOMOUS wake — no human sent this; the build driver woke you.',
        'You may investigate (read transcripts/code), post a diagnosis, request a missing secret, and' +
          ' retry_thread within budget — but you may NOT edit/push code or ship without the operator.',
        'Use `atlas-tx` to inspect any lane\'s raw transcript.',
        '',
        'The whole build finished and is parked at the ship gate — nothing is pushed yet. Review the',
        'integrated result (the diff; any lane\'s transcript via `atlas-tx`), then post the operator a crisp',
        'summary of what shipped and any risks. You may investigate/report/request-secret/retry a lane; you',
        'may NOT ship — the **Ship it** gate is the operator\'s.',
        'master review outcome: all three threads merged clean; typecheck + vitest green.',
      ].join('\n'),
    },
  },
];

async function upsertRepo2(ds: DataSource): Promise<void> {
  const repos = ds.getRepository(RepoEntity);
  const row =
    (await repos.findOne({ where: { id: REPO_2_ID } })) ??
    repos.create({ id: REPO_2_ID, org_id: ORG_ID, slug: 'demo-repo-2' });
  row.name = 'demo-repo-2';
  row.git_url = 'https://github.com/dennisofficial/demo-repo-2';
  row.default_branch = 'main';
  row.access_ok = true;
  row.access_checked_at = new Date();
  await repos.save(row);
  console.log(`  seeded repo demo-repo-2 (${REPO_2_ID})`);
}

async function upsertJob(ds: DataSource, demo: DemoJob): Promise<void> {
  const jobs = ds.getRepository(JobEntity);
  const row =
    (await jobs.findOne({ where: { id: demo.id } })) ??
    jobs.create({ id: demo.id });
  row.org_id = ORG_ID;
  row.repo_id = demo.repo_id;
  row.origin = 'chat';
  row.kind = demo.kind;
  row.title = demo.title;
  row.status = demo.status;
  row.ship_review_approved_at = demo.ship_review_approved_at ?? null;
  row.pr_state = demo.pr_state ?? null;
  row.pr_url = demo.pr_url ?? null;
  row.pr_number = demo.pr_number ?? null;
  // These PRs are fixtures, not real GitHub PRs. Park the reconciler's durable poll clock far in the
  // future so GitStateReconciler never marks them DUE and re-latches pr_state to 'closed' after a 404.
  row.next_poll_at =
    demo.pr_number != null ? new Date('2999-01-01T00:00:00Z') : null;
  row.halted = demo.halted ?? false;
  row.halt = demo.halt ?? null;
  await jobs.save(row);
  console.log(
    `  seeded job "${demo.title.slice(0, 60)}${demo.title.length > 60 ? '…' : ''}" [${demo.section}] (${demo.id})`,
  );
}

async function upsertRichThreads(ds: DataSource): Promise<void> {
  const threads = ds.getRepository(ThreadEntity);
  for (const t of RICH_THREADS) {
    const row =
      (await threads.findOne({ where: { id: t.id } })) ??
      threads.create({ id: t.id });
    row.job_id = RICH_JOB_ID;
    row.org_id = ORG_ID;
    row.ordinal = t.ordinal;
    row.brief = t.brief;
    row.kind = t.kind;
    row.config = {};
    await threads.save(row);
  }
  console.log(`  seeded ${RICH_THREADS.length} threads on rich job`);
}

async function upsertRichSteps(ds: DataSource): Promise<void> {
  const steps = ds.getRepository(StepEntity);
  for (const s of RICH_STEPS) {
    const row =
      (await steps.findOne({ where: { id: s.id } })) ??
      steps.create({ id: s.id });
    row.thread_id = s.thread_id;
    row.job_id = RICH_JOB_ID;
    row.org_id = ORG_ID;
    row.ordinal = s.ordinal;
    row.brief = s.brief;
    await steps.save(row);
  }
  console.log(
    `  seeded ${RICH_STEPS.length} steps on rich job's builder threads`,
  );
}

async function upsertRichMessages(ds: DataSource): Promise<void> {
  const messages = ds.getRepository(MessageEntity);
  const fixtureIds = RICH_MESSAGES.map((m) => m.id);
  await messages
    .createQueryBuilder()
    .delete()
    .where('job_id = :jobId', { jobId: RICH_JOB_ID })
    .andWhere('id NOT IN (:...fixtureIds)', { fixtureIds })
    .execute();
  for (const m of RICH_MESSAGES) {
    const row =
      (await messages.findOne({ where: { id: m.id } })) ??
      messages.create({ id: m.id });
    row.job_id = RICH_JOB_ID;
    row.author = m.author;
    row.author_id = m.author_id;
    row.author_bot_id = m.author_bot_id;
    row.text = m.text;
    row.kind = m.kind ?? 'chat';
    row.meta = m.meta ?? null;
    await messages.save(row);
  }
  console.log(`  seeded ${RICH_MESSAGES.length} messages on rich job`);
}

async function main(): Promise<void> {
  const ds = await AppDataSource.initialize();
  try {
    await upsertRepo2(ds);
    for (const demo of DEMO_JOBS) {
      await upsertJob(ds, demo);
    }
    await upsertRichThreads(ds);
    await upsertRichSteps(ds);
    await upsertRichMessages(ds);
    console.log(
      `seed-demo-jobs: done — ${DEMO_JOBS.length} jobs, rich job = ${RICH_JOB_ID}`,
    );
  } finally {
    await ds.destroy();
  }
}

void main();
