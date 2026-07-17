import type { EngineRunnerPort } from '@shared/engine';
import { EngineCore } from '@shared/engine/engine-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LocalGitService } from '../git';
import type { TurnHarnessFactory } from '../surface/turn-harness.service';
import { lensById } from './autofix-lenses';
import { AutoFixStage } from './autofix.stage';
import type { AutoFixContext } from './autofix.types';

/**
 * LIVE, model-backed proof of the framework-conformance lens (real LLM provider call — runs only under
 * `pnpm test:ai` with a subscription token in the env). It drives the REAL AutoFixStage review runner
 * against the REAL {@link EngineCore} (the SDK wrapper the in-process/in-container engines both use):
 *   1. force-inject a `review`-surface skill body (a React checklist forbidding array-index list keys)
 *      into the framework lens via `ctx.frameworkBodies`,
 *   2. hand the lens a diff that VIOLATES that rule (a `.tsx` list rendered with `key={index}`),
 *   3. run the turn end-to-end and assert the MODEL returned a `lens:'framework'` finding that names
 *      the injected rule — proving the injected body reaches the model and shapes its findings, not
 *      just the prompt builder (which `autofix.stage.spec.ts` already covers with a fake engine).
 *
 * The raw model report + parsed findings are captured to `/context/artifacts/framework-lens/live-run/`.
 */
const OAUTH_TOKEN = process.env.CLAUDE_OAUTH_TOKEN ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
const describeLive = OAUTH_TOKEN ? describe : describe.skip;

const INJECTED_SKILL_NAME = 'react-review-checklist';
const INJECTED_RULE =
  'Never use an array index as a React list `key`. Keys must be stable, unique ids derived from the ' +
  'item data (e.g. `user.id`), because index keys corrupt component state and diffing when the list ' +
  'reorders, inserts, or deletes.';
const INJECTED_SKILL_BODY = [
  '# React review checklist',
  '',
  '## List rendering',
  `- ${INJECTED_RULE}`,
  '- Prefer derived/memoized values over recomputing in render.',
].join('\n');

/** A .tsx change that clearly BREAKS the injected rule (renders a list with `key={index}`). */
const VIOLATING_FILE_PATH = 'src/UserList.tsx';
const VIOLATING_FILE = `import React from 'react';

type User = { id: string; name: string };

export function UserList({ users }: { users: User[] }) {
  return (
    <ul>
      {users.map((user, index) => (
        <li key={index}>{user.name}</li>
      ))}
    </ul>
  );
}
`;

/** Constructor stubs — the review path never touches git, and no harness is created (ctx carries no
 *  streaming identity), so these are inert placeholders that satisfy the DI signature. */
const gitStub = {
  headSha: async () => 'base',
  hasChanges: async () => false,
} as unknown as LocalGitService;
const harnessStub = {
  create: () => {
    throw new Error('harness must not be created in this test (ctx has no jobId/channel)');
  },
} as unknown as TurnHarnessFactory;

describeLive('AutoFixStage framework lens — LIVE model-backed review turn', () => {
  const artifactDir = '/context/artifacts/framework-lens/live-run';
  let stage: AutoFixStage;
  let worktree: string;
  // The reviewer now pulls the diff itself via `git diff <range>` (it is no longer inlined), so the
  // worktree is a real git repo and the violating file lands as its OWN commit against a base — the
  // range the lens diffs. Reproduces the production per-thread `sectionStartSha..HEAD` scoping.
  let gitRange: string;
  const rawReports: string[] = [];

  beforeAll(async () => {
    // The real Claude Agent SDK (dynamic import — it is ESM). Codex SDK is unused on a Claude turn.
    const claudeSdk = await import('@anthropic-ai/claude-agent-sdk');
    const homeRoot = mkdtempSync(join(tmpdir(), 'atlas-fw-home-'));
    const core = new EngineCore(claudeSdk, {} as never, { homeRoot });

    // A capturing adapter so we keep the exact raw model text (the stage itself only returns parsed
    // findings) for the evidence bundle, while the stage does the real selection + injection + parse.
    const engine = {
      run: async (args: Parameters<EngineCore['run']>[0]) => {
        const res = await core.run(args);
        rawReports.push(res.result);
        return res;
      },
    } as unknown as EngineRunnerPort;

    stage = new AutoFixStage(engine, gitStub, harnessStub);

    // A real on-disk GIT repo so the reviewer can pull the change set with `git diff <range>` (and Read
    // the file for context). Base commit = a repo without UserList; the violating file is a second commit,
    // and `gitRange` (base..HEAD) is exactly what the lens diffs — the production per-thread scoping.
    worktree = mkdtempSync(join(tmpdir(), 'atlas-fw-wt-'));
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: worktree });
    };
    git('init', '-q');
    git('config', 'user.email', 'test@atlas.local');
    git('config', 'user.name', 'Atlas Test');
    writeFileSync(join(worktree, 'README.md'), '# fixture repo\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktree,
    })
      .toString()
      .trim();
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, VIOLATING_FILE_PATH), VIOLATING_FILE, 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'add UserList');
    gitRange = `${baseSha}..HEAD`;
    mkdirSync(artifactDir, { recursive: true });
  });

  it('the model flags the injected array-index-key rule as a framework finding', async () => {
    const frameworkLens = lensById('framework');
    expect(frameworkLens?.scope).toBe('framework');

    const ctx: AutoFixContext = {
      worktreePath: worktree,
      sandboxKey: {
        orgId: 'live-test',
        repoId: 'atlas',
        jobId: 'framework-lens',
        type: 'autofix',
      },
      gitRange,
      changedFiles: [VIOLATING_FILE_PATH],
      intent: 'Add a UserList component that renders the given users as a list.',
      label: 'frontend',
      frameworkBodies: [{ name: INJECTED_SKILL_NAME, body: INJECTED_SKILL_BODY }],
    };

    const findings = await stage.runReviewLens(ctx, frameworkLens!, {
      auth: { secret: OAUTH_TOKEN! },
      model: 'claude-sonnet-5',
    });

    const raw = rawReports.join('\n\n---\n\n');
    writeFileSync(
      join(artifactDir, 'model-report.txt'),
      `INJECTED RULE:\n${INJECTED_RULE}\n\n=== RAW MODEL REPORT ===\n${raw}\n`,
      'utf8',
    );
    writeFileSync(
      join(artifactDir, 'parsed-findings.json'),
      JSON.stringify(findings, null, 2),
      'utf8',
    );

    // The model returned at least one finding, tagged with the framework lens…
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.lens === 'framework')).toBe(true);
    // …and it is about the injected list-key rule (mentions the key/index concept the rule forbids).
    const haystack = findings
      .map((f) => `${f.title} ${f.detail}`)
      .join(' ')
      .toLowerCase();
    expect(haystack).toMatch(/key/);
    expect(haystack).toMatch(/index/);
  }, 120_000);
});
