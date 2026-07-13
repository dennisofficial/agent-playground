import 'reflect-metadata';

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';

import { AppDataSource } from '../cli/data-source';

/**
 * Loads the committed scroll-regression transcript fixture into the demo "rich" job so the
 * virtualized-transcript e2e (`web/e2e/transcript-scroll.spec.ts`) has a long, variable-height
 * conversation to scroll through.
 *
 * The fixture (`scripts/fixtures/scroll-transcript.jsonl.gz`) is a curated ~500-message subset of the
 * longest real prod conversation — it keeps the mermaid diagram, several long code blocks and the tall
 * messages that make row-height estimates wrong (the re-measure churn that reproduces the bug), while
 * staying small enough to commit. A full-transcript loader for local stress testing lives alongside this
 * (see the thread's RESULTS.md); this script is the durable, CI-reproducible path.
 *
 * `created_at` is preserved verbatim from the fixture because the transcript renders in `created_at ASC`
 * order (see web-surface.controller `messageHistory`) — a plain entity insert would stamp `now()` and
 * scramble the order.
 *
 *   pnpm seed:scroll-fixture
 */

const RICH_JOB_ID = 'da700000-0000-4000-8000-000000000104';
const FIXTURE = join(__dirname, 'fixtures', 'scroll-transcript.jsonl.gz');

type FixtureRow = {
  id: string;
  author: string;
  author_id: string;
  author_bot_id: string | null;
  text: string;
  ts: string | null;
  kind: string | null;
  card: unknown;
  meta: unknown;
  idem_key: string | null;
  created_at: string | null;
  updated_at: string | null;
};

const COLS = [
  'id',
  'job_id',
  'author',
  'author_id',
  'author_bot_id',
  'text',
  'ts',
  'kind',
  'card',
  'meta',
  'idem_key',
  'created_at',
  'updated_at',
] as const;

async function readFixture(): Promise<FixtureRow[]> {
  const rows: FixtureRow[] = [];
  const rl = createInterface({
    input: createReadStream(FIXTURE).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) rows.push(JSON.parse(trimmed) as FixtureRow);
  }
  return rows;
}

async function main(): Promise<void> {
  const ds = await AppDataSource.initialize();
  try {
    const rows = await readFixture();
    await ds.transaction(async (tx) => {
      await tx.query('DELETE FROM messages WHERE job_id = $1', [RICH_JOB_ID]);
      const BATCH = 200;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const values: unknown[] = [];
        const tuples = batch.map((r, b) => {
          const base = b * COLS.length;
          const cells = COLS.map((_, c) => `$${base + c + 1}`);
          values.push(
            r.id,
            RICH_JOB_ID,
            r.author,
            r.author_id,
            r.author_bot_id,
            r.text,
            r.ts,
            r.kind ?? 'chat',
            r.card == null ? null : JSON.stringify(r.card),
            r.meta == null ? null : JSON.stringify(r.meta),
            r.idem_key,
            r.created_at,
            r.updated_at,
          );
          return `(${cells.join(', ')})`;
        });
        await tx.query(
          `INSERT INTO messages (${COLS.join(', ')}) VALUES ${tuples.join(', ')}`,
          values,
        );
      }
    });
    console.log(
      `load-scroll-fixture: loaded ${rows.length} messages into rich job ${RICH_JOB_ID}`,
    );
  } finally {
    await ds.destroy();
  }
}

void main();
