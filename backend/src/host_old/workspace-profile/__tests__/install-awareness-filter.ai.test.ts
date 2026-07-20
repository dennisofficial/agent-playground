import type { InstallMatch } from '@shared/prompt-kit/jit/install-awareness';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AnthropicInstallAwarenessFilter,
  type InstallFilterVerdict,
} from '../install-awareness-filter';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const describeLive = API_KEY ? describe : describe.skip;

const EVIDENCE_DIR = join(
  process.env.ATLAS_EVIDENCE_DIR ?? '/context/evidence',
  'install-awareness-filter',
);

const BARE_PROFILE = [
  '- Mounts: none',
  '- Setup script: none',
  '- Preview recipe: none',
  '- Secret files: none',
  '- MCP servers: none',
  '- House style: none',
].join('\n');

const LINT_COVERED_PROFILE = [
  '- Mounts: none',
  '- Setup script: recorded (240 chars)',
  '- Preview recipe: none',
  '- Secret files: none',
  '- MCP servers: none',
  '- House style: none',
  '',
  'Installed skills: eslint-review (repo) — runs `pnpm lint` and reviews violations against the repo house style.',
].join('\n');

type Scenario = {
  name: string;
  match: InstallMatch;
  profileBlock: string;
  expectSuppress: boolean;
};

const SCENARIOS: Scenario[] = [
  {
    name: 'new lint tool, bare profile → kept, concrete suggestion',
    match: {
      action: 'add',
      kind: 'repo-manifest',
      key: 'pnpm:eslint',
      label: 'pnpm add/install',
    },
    profileBlock: BARE_PROFILE,
    expectSuppress: false,
  },
  {
    name: 'transient one-off scaffolder (npx create-foo) → suppressed',
    match: {
      action: 'add',
      kind: 'repo-manifest',
      key: 'npx:create-foo',
      label: 'npx dlx/npx (ad-hoc runner)',
    },
    profileBlock: BARE_PROFILE,
    expectSuppress: true,
  },
  {
    name: 'lint tool already covered by an installed skill → suppressed',
    match: {
      action: 'add',
      kind: 'repo-manifest',
      key: 'pnpm:eslint',
      label: 'pnpm add/install',
    },
    profileBlock: LINT_COVERED_PROFILE,
    expectSuppress: true,
  },
];

describeLive('AnthropicInstallAwarenessFilter — LIVE Haiku filter/enricher', () => {
  const results: {
    scenario: string;
    input: InstallMatch;
    verdict: InstallFilterVerdict | undefined;
  }[] = [];

  it.each(SCENARIOS)('$name', async ({ match, profileBlock, expectSuppress }) => {
    const filter = new AnthropicInstallAwarenessFilter(async () => API_KEY);

    const verdict = await filter.filter({
      orgId: 'live-test',
      match,
      profileBlock,
    });
    results.push({
      scenario: expect.getState().currentTestName ?? match.key,
      input: match,
      verdict,
    });

    expect(verdict).toBeDefined();
    expect(verdict?.suppress).toBe(expectSuppress);
    if (!expectSuppress) {
      expect((verdict?.suggestion || verdict?.reason || '').length).toBeGreaterThan(0);
    }
  });

  it('writes the captured verdicts to the evidence bundle', () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const lines = [
      '# install-awareness-filter — LIVE Haiku verdicts',
      '',
      `Model: claude-haiku-4-5-20251001. Captured ${new Date().toISOString()}.`,
      '',
      ...results.map((r) =>
        [
          `## ${r.scenario}`,
          '',
          `- input: \`${JSON.stringify(r.input)}\``,
          `- verdict: \`${JSON.stringify(r.verdict)}\``,
          '',
        ].join('\n'),
      ),
    ];
    writeFileSync(join(EVIDENCE_DIR, 'RESULTS.md'), lines.join('\n'), 'utf8');
    expect(results.length).toBe(SCENARIOS.length);
  });
});
