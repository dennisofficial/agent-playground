import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Fact } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { Identity } from '../../domain/identity';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { MemoryWriteService } from '../memory-write.service';
import { ReconcileService } from '../reconcile.service';
import { SemanticMemory } from '../semantic-memory';

/**
 * The memory EVALUATION harness — framework-agnostic so it runs from a vitest `*.ai.test.ts` (real
 * LLM + embeddings + live Postgres) but carries no test-framework coupling itself. It exists because
 * memory can't be tuned blind: every later phase (recall ranking, the consolidation extraction pass)
 * is judged against the numbers this produces, not by feel.
 *
 * Two case kinds, both driving the REAL services:
 *   - extraction: run the fact-extraction pass over a transcript, then check what landed against
 *     `shouldExtract` (must be captured) and `shouldNotExtract` (anticipatory/chatter that must NOT
 *     become a fact — the 2026-06-12 regression lives here as a permanent guard).
 *   - recall: seed facts with controlled ages, run `recall`, check `shouldRecall` surfaces in the
 *     top-k and `shouldNotRecall` does not (this is where the stale-fact-burial bug shows up).
 *
 * Phase 1 is MEASUREMENT, not a gate: `runEvals` returns numbers and never throws on a quality miss.
 * Later phases add thresholds in the test wrapper once the consolidation pass exists.
 */

export interface ExtractionCase {
  name: string;
  kind: 'extraction';
  /** Bot id whose memory we reconcile as (roster id, e.g. 'alex'). */
  bot: string;
  /** Facts already in memory before the turn — lets a case exercise supersede/contradiction
   * (e.g. seed "uses Postgres", then the turn says "we use MySQL now"). */
  seedFacts?: Array<{
    fact: string;
    tier?: 'team' | 'project' | 'bot' | 'private';
    project?: string;
  }>;
  /** The turn, oldest first. `human` lines render bare (as production's turnTranscript does);
   * `bot` lines render "Name: text". */
  transcript: Array<{ human?: string; bot?: string; text: string }>;
  /** Facts that SHOULD be captured (semantic match via the dedup judge). */
  shouldExtract: string[];
  /** Lines/facts that must NOT remain in memory after the turn — anticipatory chatter, status,
   * questions, or a stale fact a correction should have superseded. */
  shouldNotExtract?: string[];
}

export interface RecallCase {
  name: string;
  kind: 'recall';
  bot: string;
  /** Facts to seed before recall. `ageDays` back-dates `updated_at` so recency ranking is exercised. */
  seedFacts: Array<{
    fact: string;
    tier?: 'team' | 'project' | 'bot' | 'private';
    project?: string;
    ageDays?: number;
  }>;
  query: string;
  /** Top-k to request (defaults to recall's own default of 5). */
  k?: number;
  /** Facts that MUST appear in the top-k. */
  shouldRecall: string[];
  /** Facts that must NOT appear in the top-k. */
  shouldNotRecall?: string[];
  /** Marks a case that specifically probes stale-but-relevant recall (rolled into its own metric). */
  stale?: boolean;
}

export type EvalCase = ExtractionCase | RecallCase;

export interface EvalDeps {
  semantic: SemanticMemory;
  writes: MemoryWriteService;
  reconcile: ReconcileService;
  facts: Repository<Fact>;
  employees: EmployeeRegistry;
}

export interface ExtractionResult {
  name: string;
  kind: 'extraction';
  expected: number;
  captured: number; // expected facts actually captured (true positives)
  recall: number; // captured / expected
  noiseHits: number; // stored facts matching a shouldNotExtract line
  storedTotal: number;
  noiseRate: number; // noiseHits / max(1, storedTotal)
  missed: string[];
  noise: string[];
}

export interface RecallResult {
  name: string;
  kind: 'recall';
  stale: boolean;
  expected: number;
  hit: number;
  hitRate: number; // hit / expected
  violations: string[]; // shouldNotRecall facts that surfaced
  missed: string[];
}

export type CaseResult = ExtractionResult | RecallResult;

export interface EvalSummary {
  results: CaseResult[];
  extraction: {
    cases: number;
    meanRecall: number;
    meanNoiseRate: number;
  };
  recall: {
    cases: number;
    meanHitRate: number;
    staleCases: number;
    staleMeanHitRate: number;
    totalViolations: number;
  };
}

/** Build the channel identity an eval case runs under (one human, Dennis; current project = local). */
function identityFor(bot: string): Identity {
  return {
    selfAgent: bot,
    team: 'local',
    project: 'local',
    participants: ['dennis'],
    speaker: 'dennis',
    surface: 'eval',
    isChannel: true,
  };
}

/** Load every `*.eval.json` from the cases directory next to this file. */
export function loadCases(dir = join(__dirname, 'cases')): EvalCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.eval.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as EvalCase);
}

/** Render a case transcript the way production's turnTranscript does. */
function renderTranscript(
  c: ExtractionCase,
  employees: EmployeeRegistry,
): string {
  return c.transcript
    .map((line) => {
      if (line.bot) {
        const name = employees.byId(line.bot)?.name ?? line.bot;
        return `${name}: ${line.text}`;
      }
      return line.text; // human → bare, matching turnTranscript
    })
    .join('\n');
}

/** True if `stored` states the same underlying fact as any of `targets` (gray-zone dedup judge). */
async function matchesAny(
  writes: MemoryWriteService,
  stored: string,
  targets: string[],
): Promise<boolean> {
  for (const t of targets) {
    if (await writes.dedupJudge(t, stored)) return true;
  }
  return false;
}

async function runExtraction(
  c: ExtractionCase,
  deps: EvalDeps,
): Promise<ExtractionResult> {
  const bot = deps.employees.byId(c.bot);
  if (!bot) throw new Error(`Unknown bot id "${c.bot}" in case "${c.name}"`);
  const id = identityFor(c.bot);
  await deps.facts.query('TRUNCATE facts RESTART IDENTITY');

  // Pre-existing memory, so a correction in the turn can supersede/contradict it.
  for (const s of c.seedFacts ?? []) {
    await deps.writes.rememberDeduped({
      fact: s.fact,
      tier: s.tier ?? 'project',
      id,
      project: s.project,
    });
  }

  const transcript = renderTranscript(c, deps.employees);
  await deps.reconcile.reconcileMemory(bot, transcript, id);

  const stored = (await deps.facts.find()).map((f) => f.fact);

  // Each expected fact: captured if some stored fact is judged the same underlying claim.
  let captured = 0;
  const missed: string[] = [];
  for (const exp of c.shouldExtract) {
    if (await matchesAny(deps.writes, exp, stored)) captured++;
    else missed.push(exp);
  }

  // Noise: a stored fact that matches a line we explicitly said must NOT be remembered.
  const noise: string[] = [];
  const forbidden = c.shouldNotExtract ?? [];
  for (const s of stored) {
    if (forbidden.length && (await matchesAny(deps.writes, s, forbidden)))
      noise.push(s);
  }

  return {
    name: c.name,
    kind: 'extraction',
    expected: c.shouldExtract.length,
    captured,
    recall: c.shouldExtract.length ? captured / c.shouldExtract.length : 1,
    noiseHits: noise.length,
    storedTotal: stored.length,
    noiseRate: stored.length ? noise.length / stored.length : 0,
    missed,
    noise,
  };
}

async function runRecall(c: RecallCase, deps: EvalDeps): Promise<RecallResult> {
  const id = identityFor(c.bot);
  await deps.facts.query('TRUNCATE facts RESTART IDENTITY');

  // Seed via the real write path (real embeddings), then back-date updated_at to exercise recency.
  for (const s of c.seedFacts) {
    const { id: rowId } = await deps.writes.rememberDeduped({
      fact: s.fact,
      tier: s.tier ?? 'project',
      id,
      project: s.project,
    });
    if (s.ageDays && s.ageDays > 0) {
      await deps.facts.query(
        `UPDATE facts SET updated_at = now() - ($1 || ' days')::interval WHERE id = $2`,
        [s.ageDays, rowId],
      );
    }
  }

  const hits = (await deps.semantic.recall(c.query, id, c.k ?? 5)).map(
    (f) => f.fact,
  );
  const hitSet = new Set(hits);

  const missed = c.shouldRecall.filter((f) => !hitSet.has(f));
  const hit = c.shouldRecall.length - missed.length;
  const violations = (c.shouldNotRecall ?? []).filter((f) => hitSet.has(f));

  return {
    name: c.name,
    kind: 'recall',
    stale: !!c.stale,
    expected: c.shouldRecall.length,
    hit,
    hitRate: c.shouldRecall.length ? hit / c.shouldRecall.length : 1,
    violations,
    missed,
  };
}

const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/** Run every case and aggregate. Never throws on a quality miss — Phase 1 is measurement. */
export async function runEvals(
  cases: EvalCase[],
  deps: EvalDeps,
): Promise<EvalSummary> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    results.push(
      c.kind === 'extraction'
        ? await runExtraction(c, deps)
        : await runRecall(c, deps),
    );
  }

  const ext = results.filter(
    (r): r is ExtractionResult => r.kind === 'extraction',
  );
  const rec = results.filter((r): r is RecallResult => r.kind === 'recall');
  const stale = rec.filter((r) => r.stale);

  return {
    results,
    extraction: {
      cases: ext.length,
      meanRecall: mean(ext.map((r) => r.recall)),
      meanNoiseRate: mean(ext.map((r) => r.noiseRate)),
    },
    recall: {
      cases: rec.length,
      meanHitRate: mean(rec.map((r) => r.hitRate)),
      staleCases: stale.length,
      staleMeanHitRate: mean(stale.map((r) => r.hitRate)),
      totalViolations: rec.reduce((a, r) => a + r.violations.length, 0),
    },
  };
}

/** A compact human-readable report — printed by the test wrapper so runs are comparable over time. */
export function formatSummary(s: EvalSummary): string {
  const lines: string[] = [];
  lines.push('── Memory eval ─────────────────────────────────────────────');
  for (const r of s.results) {
    if (r.kind === 'extraction') {
      lines.push(
        `[extract] ${r.name}: recall ${(r.recall * 100).toFixed(0)}% (${r.captured}/${r.expected}), ` +
          `noise ${r.noiseHits}/${r.storedTotal}` +
          (r.missed.length ? ` — missed: ${r.missed.join(' | ')}` : '') +
          (r.noise.length ? ` — NOISE: ${r.noise.join(' | ')}` : ''),
      );
    } else {
      lines.push(
        `[recall${r.stale ? ':stale' : ''}] ${r.name}: hit ${(r.hitRate * 100).toFixed(0)}% (${r.hit}/${r.expected})` +
          (r.missed.length ? ` — missed: ${r.missed.join(' | ')}` : '') +
          (r.violations.length
            ? ` — VIOLATIONS: ${r.violations.join(' | ')}`
            : ''),
      );
    }
  }
  lines.push('────────────────────────────────────────────────────────────');
  lines.push(
    `extraction: ${s.extraction.cases} cases · mean recall ${(s.extraction.meanRecall * 100).toFixed(0)}% · mean noise ${(s.extraction.meanNoiseRate * 100).toFixed(0)}%`,
  );
  lines.push(
    `recall: ${s.recall.cases} cases · mean hit-rate ${(s.recall.meanHitRate * 100).toFixed(0)}% · ` +
      `stale ${s.recall.staleCases} cases @ ${(s.recall.staleMeanHitRate * 100).toFixed(0)}% · ` +
      `violations ${s.recall.totalViolations}`,
  );
  lines.push('────────────────────────────────────────────────────────────');
  return lines.join('\n');
}
