import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DecisionLedgerService,
  LedgerValidationError,
  type LedgerEntryInput,
} from './decision-ledger.service';

const LEDGER = join('.atlas', 'decisions');

function entry(over: Partial<LedgerEntryInput> = {}): LedgerEntryInput {
  return {
    slug: 'money-out-requires-superadmin',
    title: 'Money-out actions require SUPER_ADMIN',
    context: 'Staff billing exposes refunds and credits.',
    decision: 'Gate the irreversible money-out endpoints to SUPER_ADMIN via a new RolesGuard.',
    consequences: 'A reusable role primitive; one extra DB lookup per gated request.',
    alternatives: 'Gate everything to SUPER_ADMIN — rejected, SUPPORT needs day-to-day actions.',
    tags: ['staff-portal', 'security'],
    confirmedByOperator: true,
    sourceThread: 'thread-1',
    sourceDecision: 'd3',
    governsPaths: ['backend/src/staff/**'],
    ...over,
  };
}

describe('DecisionLedgerService', () => {
  let svc: DecisionLedgerService;
  let worktree: string;
  const dir = (): string => join(worktree, LEDGER);
  const read = (slug: string): Promise<string> => readFile(join(dir(), `${slug}.md`), 'utf8');

  beforeEach(async () => {
    svc = new DecisionLedgerService();
    worktree = await mkdtemp(join(tmpdir(), 'atlas-ledger-'));
  });

  it('writes a decision file with frontmatter + ADR body, and regenerates the index', async () => {
    const res = await svc.promote(worktree, [entry()]);
    expect(res.written).toEqual(['money-out-requires-superadmin']);

    const md = await read('money-out-requires-superadmin');
    expect(md).toContain('id: money-out-requires-superadmin');
    expect(md).toContain('status: proposed');
    expect(md).toContain('confirmed_by_operator: true');
    expect(md).toContain('source_decision: "d3"');
    expect(md).toContain('tags: ["staff-portal", "security"]');
    expect(md).toContain('governs_paths: ["backend/src/staff/**"]');
    expect(md).toContain('## Context');
    expect(md).toContain('## Decision');
    expect(md).toContain('## Alternatives considered');

    const index = await readFile(join(dir(), 'index.md'), 'utf8');
    expect(index).toContain('[money-out-requires-superadmin](money-out-requires-superadmin.md)');
    expect(index).toContain('proposed');
  });

  it('rejects an invalid slug, a missing body field, and a duplicate slug in one batch — writing nothing', async () => {
    await expect(svc.promote(worktree, [entry({ slug: 'Bad Slug!' })])).rejects.toBeInstanceOf(
      LedgerValidationError,
    );
    await expect(svc.promote(worktree, [entry({ decision: '   ' })])).rejects.toBeInstanceOf(
      LedgerValidationError,
    );
    await expect(
      svc.promote(worktree, [entry(), entry({ title: 'dup' })]),
    ).rejects.toBeInstanceOf(LedgerValidationError);

    // None of the failed batches left a file behind (the dir may not even exist).
    const names = await readdir(dir()).catch(() => [] as string[]);
    expect(names.filter((n) => n.endsWith('.md') && n !== 'index.md')).toEqual([]);
  });

  it('throws on a dangling supersedes target (no such slug in batch or on disk)', async () => {
    await expect(
      svc.promote(worktree, [entry({ supersedes: ['ghost-decision'] })]),
    ).rejects.toBeInstanceOf(LedgerValidationError);
  });

  it('back-links a superseded on-disk entry: marks it superseded + points it at the replacer', async () => {
    await svc.promote(worktree, [entry({ slug: 'old-call', title: 'Old call' })]);
    await svc.promote(worktree, [
      entry({ slug: 'new-call', title: 'New call', supersedes: ['old-call'] }),
    ]);

    const old = await read('old-call');
    expect(old).toContain('status: superseded');
    expect(old).toContain('superseded_by: "new-call"');
    const fresh = await read('new-call');
    expect(fresh).toContain('supersedes: ["old-call"]');
  });

  it('is idempotent — re-promoting the same slug overwrites and preserves the original decided_on', async () => {
    await svc.promote(worktree, [entry()], { now: new Date('2026-06-01T00:00:00Z') });
    const first = await read('money-out-requires-superadmin');
    expect(first).toContain('decided_on: 2026-06-01');

    await svc.promote(worktree, [entry({ title: 'Reworded title' })], {
      now: new Date('2026-06-28T00:00:00Z'),
    });
    const second = await read('money-out-requires-superadmin');
    expect(second).toContain('decided_on: 2026-06-01'); // preserved, not bumped
    expect(second).toContain('Reworded title');

    // Still exactly one entry file (overwrite, not append).
    const names = await readdir(dir());
    expect(names.filter((n) => n.endsWith('.md') && n !== 'index.md')).toEqual([
      'money-out-requires-superadmin.md',
    ]);
  });

  it('preserves a human edit to an EXISTING entry as a proposal is out of scope here — but does not crash on a hand-written file', async () => {
    // A pre-existing, hand-authored ledger file (no trailing newline, extra key) must not break a later promote.
    await mkdir(dir(), { recursive: true });
    await writeFile(
      join(dir(), 'hand-written.md'),
      '---\nid: hand-written\ntitle: "Hand"\nstatus: accepted\n---\n# Hand\n',
      'utf8',
    );
    await svc.promote(worktree, [entry({ slug: 'new-one', supersedes: ['hand-written'] })]);
    const patched = await read('hand-written');
    expect(patched).toContain('status: superseded');
    expect(patched).toContain('superseded_by: "new-one"');
    expect(patched).toContain('# Hand'); // body untouched
  });
});
