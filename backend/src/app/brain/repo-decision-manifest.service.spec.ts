import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { LocalGitService } from '../git';
import type { CredentialResolver } from '../onboarding';
import type { RepoDecisionEntity, RepoEntity } from '../persistence/entities';
import { ledgerContentHash } from './decision-ledger.service';
import { RepoDecisionManifestService } from './repo-decision-manifest.service';

/** A minimal merged ledger file (frontmatter the manifest parser reads + a body). */
function ledgerFile(over: { slug?: string; supersededBy?: string | null } = {}): string {
  const slug = over.slug ?? 'money-out-requires-superadmin';
  const supersededBy = over.supersededBy ?? null;
  return [
    '---',
    `id: ${slug}`,
    'title: "Money-out requires SUPER_ADMIN"',
    'status: proposed',
    'tags: ["security"]',
    'decided_on: 2026-06-28',
    'authored_by: atlas',
    'confirmed_by_operator: true',
    'source_thread: "thread-1"',
    'source_decision: "d3"',
    'supersedes: []',
    `superseded_by: ${supersededBy ? `"${supersededBy}"` : 'null'}`,
    'governs_paths: ["backend/src/staff/**"]',
    'last_reconciled: 2026-06-28T00:00:00.000Z',
    '---',
    '# Money-out requires SUPER_ADMIN',
    '',
    '## Context',
    '',
    'Body.',
    '',
  ].join('\n');
}

function make(opts: { existing?: Partial<RepoDecisionEntity> | null; file?: string }) {
  const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
  const saved: Array<Record<string, unknown>> = [];
  const manifest = {
    findOne: vi.fn(async () => opts.existing ?? null),
    create: vi.fn((row: Record<string, unknown>) => row),
    save: vi.fn(async (row: Record<string, unknown>) => {
      saved.push(row);
      return row;
    }),
    update: vi.fn(async (where: { id: string }, fields: Record<string, unknown>) => {
      updates.push({ id: where.id, fields });
    }),
  } as unknown as Repository<RepoDecisionEntity>;
  const repos = {
    findOne: vi.fn(async () => ({
      id: 'repo-1',
      org_id: 'org-1',
      git_url: 'https://github.com/acme/widgets.git',
      default_branch: 'main',
    })),
  } as unknown as Repository<RepoEntity>;
  const git = {
    ensureRepo: vi.fn(async () => ({ repoPath: '/tmp/repo', defaultBranch: 'main' })),
    listFilesAtRef: vi.fn(async () => ['.atlas/decisions/money-out-requires-superadmin.md']),
    readFileAtRef: vi.fn(async () => opts.file ?? ledgerFile()),
  } as unknown as LocalGitService;
  const creds = { githubToken: vi.fn(async () => undefined) } as unknown as CredentialResolver;
  const svc = new RepoDecisionManifestService(manifest, repos, git, creds);
  return { svc, manifest, updates, saved };
}

describe('RepoDecisionManifestService.reconcileFromBaseCheckout', () => {
  it('first-seen (no manifest row) → records the merged decision as accepted', async () => {
    const { svc, saved } = make({ existing: null });
    const res = await svc.reconcileFromBaseCheckout('org-1', 'repo-1');
    expect(res).toMatchObject({ reconciled: 1, accepted: 1, flagged: 0 });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      slug: 'money-out-requires-superadmin',
      status: 'accepted',
      flagged: false,
    });
  });

  it('baseline matches the merged file → flips proposed→accepted (no flag)', async () => {
    const file = ledgerFile();
    const { svc, updates } = make({
      existing: { id: 'm1', content_hash: ledgerContentHash(file), flagged: false },
      file,
    });
    const res = await svc.reconcileFromBaseCheckout('org-1', 'repo-1');
    expect(res).toMatchObject({ accepted: 1, flagged: 0 });
    expect(updates[0].fields).toMatchObject({ status: 'accepted' });
    expect(updates[0].fields.flagged).toBeUndefined(); // untouched
  });

  it('merged file diverged from the baseline → FLAGS it, never updates the content_hash', async () => {
    const { svc, updates } = make({
      existing: { id: 'm1', content_hash: 'sha256-of-something-old', flagged: false },
      file: ledgerFile(),
    });
    const res = await svc.reconcileFromBaseCheckout('org-1', 'repo-1');
    expect(res).toMatchObject({ flagged: 1 });
    expect(updates[0].fields).toMatchObject({ flagged: true });
    expect(updates[0].fields.content_hash).toBeUndefined(); // baseline preserved — never auto-trusted
  });

  it('frontmatter superseded_by → records status superseded', async () => {
    const file = ledgerFile({ supersededBy: 'newer-call' });
    const { svc, saved } = make({ existing: null, file });
    await svc.reconcileFromBaseCheckout('org-1', 'repo-1');
    expect(saved[0]).toMatchObject({ status: 'superseded', superseded_by: 'newer-call' });
  });
});

describe('RepoDecisionManifestService.recordPromoted', () => {
  it('inserts a proposed row with the promotion-time hash when none exists', async () => {
    const { svc, saved } = make({ existing: null });
    await svc.recordPromoted('org-1', 'repo-1', [
      {
        slug: 'a-call',
        title: 'A call',
        contentHash: 'hash-1',
        tags: ['x'],
        sourceThread: 'thread-1',
        supersedes: [],
        supersededBy: null,
        governsPaths: [],
      },
    ]);
    expect(saved[0]).toMatchObject({
      slug: 'a-call',
      status: 'proposed',
      content_hash: 'hash-1',
      flagged: false,
    });
  });

  it('updates an existing row (idempotent re-promotion) and clears a stale flag', async () => {
    const { svc, updates } = make({ existing: { id: 'm9', flagged: true } });
    await svc.recordPromoted('org-1', 'repo-1', [
      {
        slug: 'a-call',
        title: 'A call',
        contentHash: 'hash-2',
        tags: [],
        sourceThread: 'thread-2',
        supersedes: [],
        supersededBy: null,
        governsPaths: [],
      },
    ]);
    expect(updates[0]).toMatchObject({ id: 'm9' });
    expect(updates[0].fields).toMatchObject({ status: 'proposed', content_hash: 'hash-2', flagged: false });
  });
});
