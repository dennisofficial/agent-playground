import { getDb } from './db.js';
import { dedupJudge } from './dedup.js';
import { cosine } from './embeddings.js';
import { DEDUP_THRESHOLD, GRAY_FLOOR } from './semantic.js';

/**
 * One-time (and reusable) hygiene pass: merge the near-duplicate facts already living in the store —
 * the ones the new write-path dedup (semantic.ts + dedup.ts) only prevents going forward. Per scope,
 * greedily cluster facts by cosine, confirm gray-band pairs with the same `dedupJudge` the live path
 * uses, keep the freshest wording as canonical, and soft-delete (tombstone) the rest.
 *
 * Run it via the `consolidate-memory` package script (loads keys through dotenvx). Pass `--dry-run`
 * (or `-n`) to preview the merges without writing. Needs ANTHROPIC_API_KEY for the judge; reads the
 * embeddings already stored on each fact (no embedding calls).
 */

const DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('-n');

interface FactRow {
  id: number;
  fact: string;
  embedding: string;
  updated_at: string;
}

const trunc = (s: string, n = 70): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function consolidateScope(scope: string): Promise<{ kept: number; merged: number }> {
  const db = getDb();
  // Freshest first, so the canonical row we keep carries the most recent wording.
  const rows = db
    .prepare(
      `SELECT id, fact, embedding, updated_at FROM facts
       WHERE scope = ? AND deleted_at IS NULL ORDER BY updated_at DESC`,
    )
    .all(scope) as FactRow[];
  const vecs = new Map<number, number[]>(
    rows.map((r) => [r.id, JSON.parse(r.embedding) as number[]]),
  );

  const consumed = new Set<number>();
  let kept = 0;
  let merged = 0;

  for (const canonical of rows) {
    if (consumed.has(canonical.id)) continue;
    consumed.add(canonical.id);
    kept++;
    for (const other of rows) {
      if (consumed.has(other.id)) continue;
      const sim = cosine(vecs.get(canonical.id)!, vecs.get(other.id)!);
      if (sim < GRAY_FLOOR) continue;
      const same = sim >= DEDUP_THRESHOLD ? true : await dedupJudge(canonical.fact, other.fact);
      if (!same) continue;
      consumed.add(other.id);
      merged++;
      console.log(
        `  merge #${other.id} "${trunc(other.fact)}"\n     into #${canonical.id} "${trunc(canonical.fact)}"  (sim ${sim.toFixed(3)})`,
      );
      if (!DRY_RUN) {
        db.prepare(`UPDATE facts SET deleted_at = ? WHERE id = ?`).run(
          new Date().toISOString(),
          other.id,
        );
      }
    }
  }
  return { kept, merged };
}

async function main(): Promise<void> {
  const db = getDb();
  const scopes = (
    db.prepare(`SELECT DISTINCT scope FROM facts WHERE deleted_at IS NULL`).all() as {
      scope: string;
    }[]
  ).map((s) => s.scope);

  if (DRY_RUN) console.log('[dry-run] previewing merges — no changes will be written.\n');

  let totalKept = 0;
  let totalMerged = 0;
  for (const scope of scopes) {
    const before = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM facts WHERE scope = ? AND deleted_at IS NULL`)
        .get(scope) as {
        n: number;
      }
    ).n;
    console.log(`scope ${scope} — ${before} live facts`);
    const { kept, merged } = await consolidateScope(scope);
    if (merged === 0) console.log('  (no duplicates)');
    totalKept += kept;
    totalMerged += merged;
    console.log('');
  }

  console.log(
    `${DRY_RUN ? '[dry-run] ' : ''}done: ${totalKept} canonical kept, ${totalMerged} merged${
      DRY_RUN ? ' (nothing written)' : ''
    }.`,
  );
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error('consolidate failed:', err);
    process.exit(1);
  },
);
