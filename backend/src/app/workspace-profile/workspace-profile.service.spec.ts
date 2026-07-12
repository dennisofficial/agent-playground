import { describe, expect, it } from 'vitest';
import { WorkspaceProfileService } from './workspace-profile.service';

/** Build the service over minimal fakes for each composed store (only the methods `describe` calls). */
function make(overrides?: {
  mounts?: { path: string; mode: string }[];
  setupScript?: string | null;
  secretFiles?: { path: string; label?: string | null }[];
  mcpRows?: { name: string; scope: string; surfaces: string[]; enabled: boolean }[];
  skillRows?: { name: string; scope: string; description: string; enabled: boolean }[];
  slug?: string | null;
  conventionName?: string | null;
  unfilledSlots?: { name: string; scope: string; slots: string[] }[];
  authFailing?: { name: string; scope: string; authKind: 'static' | 'oauth'; reason: string }[];
  needConnect?: { name: string; scope: string }[];
  seenManifests?: string[] | null;
}): WorkspaceProfileService {
  const o = overrides ?? {};
  const workspaceConfig = {
    listMounts: async () => o.mounts ?? [],
    getSetupScript: async () => o.setupScript ?? null,
    getSeenManifests: async () => o.seenManifests ?? null,
  };
  const secretFiles = { list: async () => o.secretFiles ?? [] };
  const mcp = {
    rowsForTurn: async () => o.mcpRows ?? [],
    unfilledSecretSlots: async () => o.unfilledSlots ?? [],
    authFailingServers: async () => o.authFailing ?? [],
    needsOAuthConnect: async () => o.needConnect ?? [],
  };
  const skills = { rowsForTurn: async () => o.skillRows ?? [] };
  const conventions = {
    attachedSlug: async () => o.slug ?? null,
    resolveForRepo: async () => (o.conventionName ? { name: o.conventionName, body: 'b' } : null),
  };
  return new WorkspaceProfileService(
    workspaceConfig as never,
    secretFiles as never,
    mcp as never,
    skills as never,
    conventions as never,
  );
}

describe('WorkspaceProfileService.describe', () => {
  it('aggregates every dimension into one snapshot', async () => {
    const svc = make({
      mounts: [{ path: '.cache', mode: 'shared-rw' }],
      setupScript: 'pnpm install',
      secretFiles: [{ path: '.env', label: 'env' }],
      mcpRows: [{ name: 'github', scope: '*', surfaces: ['build'], enabled: true }],
      skillRows: [{ name: 'migrations', scope: 'repo-1', description: 'Use when …', enabled: true }],
      slug: 'nest-next',
      conventionName: 'NestJS + Next',
    });
    const snap = await svc.describe('org1', 'repo-1');
    expect(snap.mounts).toEqual([{ path: '.cache', mode: 'shared-rw' }]);
    expect(snap.setupScript).toEqual({ present: true, length: 'pnpm install'.length });
    expect(snap.secretFiles).toEqual([{ path: '.env', label: 'env' }]);
    expect(snap.mcpServers).toEqual([{ name: 'github', tier: 'org', surfaces: ['build'], enabled: true }]);
    expect(snap.skills).toEqual([
      { name: 'migrations', tier: 'repo', description: 'Use when …', enabled: true },
    ]);
    expect(snap.houseStyle).toEqual({ slug: 'nest-next', name: 'NestJS + Next' });
  });

  it('reports empties on an unprovisioned repo', async () => {
    const snap = await make().describe('org1', 'repo-1');
    expect(snap.setupScript).toEqual({ present: false, length: 0 });
    expect(snap.houseStyle).toBeNull();
    expect(snap.mounts).toEqual([]);
  });
});

describe('WorkspaceProfileService.render', () => {
  it('never includes a secret VALUE — only the file path/label ref', async () => {
    const svc = make({ secretFiles: [{ path: '.env.keys', label: 'keys' }] });
    const out = svc.render(await svc.describe('org1', 'repo-1'));
    expect(out).toContain('.env.keys');
    expect(out).toContain('(keys)');
    // The rendered block lists refs and metadata only — no store ever hands `render` a plaintext value.
  });

  it('renders a compact per-dimension block naming the rendered areas', async () => {
    const out = make().render(
      await make().describe('org1', 'repo-1'),
    );
    // No 'Skills:' label (dropped) — the SDK's native skill listing now owns that surfacing; see render()'s
    // comment. `describe()` still aggregates `snap.skills` (covered above), just not re-rendered here.
    for (const label of ['Mounts:', 'Setup script:', 'Secret files:', 'MCP servers:', 'House style:']) {
      expect(out).toContain(label);
    }
    expect(out).not.toContain('Skills:');
  });
});

describe('WorkspaceProfileService.computeGaps / renderGaps', () => {
  it('returns no gaps (and renders nothing) for a healthy profile', async () => {
    const svc = make({ unfilledSlots: [] });
    const gaps = await svc.computeGaps('org1', 'repo-1');
    expect(gaps).toEqual([]);
    expect(svc.renderGaps(gaps)).toBe('');
  });

  it('flags an approved MCP server with an unfilled secret slot (names only, no values, names the fix tool)', async () => {
    const svc = make({
      unfilledSlots: [{ name: 'github', scope: 'repo', slots: ['header:Authorization'] }],
    });
    const gaps = await svc.computeGaps('org1', 'repo-1');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('unfilled_mcp_secret');
    const rendered = svc.renderGaps(gaps);
    expect(rendered).toContain('PROFILE GAPS');
    expect(rendered).toContain('github');
    expect(rendered).toContain('header:Authorization');
    expect(rendered).toContain('request_secret');
  });

  it('flags a NEW manifest not yet acknowledged, once the profile is seeded', async () => {
    const svc = make({ seenManifests: ['package.json'] });
    const gaps = await svc.computeGaps('org1', 'repo-1', ['package.json', 'go.mod']);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('new_stack');
    expect(gaps[0].detail).toContain('go.mod');
    expect(gaps[0].detail).not.toContain('package.json'); // already acknowledged
  });

  it('never flags a new stack before the profile is seeded (seen === null)', async () => {
    const svc = make({ seenManifests: null });
    expect(await svc.computeGaps('org1', 'repo-1', ['package.json', 'go.mod'])).toEqual([]);
  });

  it('no new-stack gap when every current manifest is already acknowledged', async () => {
    const svc = make({ seenManifests: ['package.json', 'go.mod'] });
    expect(await svc.computeGaps('org1', 'repo-1', ['package.json'])).toEqual([]);
  });

  it('flags a static server whose auth broke with the request_secret + reset_sandbox fix', async () => {
    const svc = make({
      authFailing: [{ name: 'github', scope: 'repo-1', authKind: 'static', reason: '401 Unauthorized' }],
    });
    const gaps = await svc.computeGaps('org1', 'repo-1');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('broken_auth');
    const rendered = svc.renderGaps(gaps);
    expect(rendered).toContain('github');
    expect(rendered).toContain('401 Unauthorized');
    expect(rendered).toContain('request_secret');
    expect(rendered).toContain('reset_sandbox');
  });

  it('flags a broken OAuth server as owner-must-reconnect (no request_secret fix)', async () => {
    const svc = make({
      authFailing: [{ name: 'jira', scope: 'org', authKind: 'oauth', reason: 'needs re-auth' }],
    });
    const gaps = await svc.computeGaps('org1', 'repo-1');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('broken_auth');
    expect(gaps[0].detail).toContain('re-authorization');
    expect(gaps[0].detail).toContain('Reconnect');
    expect(gaps[0].detail).not.toContain('request_secret');
  });

  it('does not double-report a never-filled slot as broken_auth (unfilled wins)', async () => {
    const svc = make({
      unfilledSlots: [{ name: 'github', scope: 'repo-1', slots: ['header:Authorization'] }],
      authFailing: [{ name: 'github', scope: 'repo-1', authKind: 'static', reason: 'missing Authorization' }],
    });
    const gaps = await svc.computeGaps('org1', 'repo-1');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('unfilled_mcp_secret');
  });

  it('flags a registered-but-unconnected OAuth server as needs_oauth_connect (owner must Connect, names only)', async () => {
    const svc = make({ needConnect: [{ name: 'jira', scope: 'org' }] });
    const gaps = await svc.computeGaps('org1', 'repo-1');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('needs_oauth_connect');
    const rendered = svc.renderGaps(gaps);
    expect(rendered).toContain('PROFILE GAPS');
    expect(rendered).toContain('jira');
    expect(rendered).toContain('Connect');
    expect(rendered).toContain('not yet connected');
    // Owner-only, brain cannot consent — and never a token/secret value.
    expect(rendered).toContain('cannot consent OAuth');
  });

  it('does not double-report a server as needs_oauth_connect when it is already unfilled/broken (dedup)', async () => {
    const svc = make({
      authFailing: [{ name: 'jira', scope: 'org', authKind: 'oauth', reason: 'needs re-auth' }],
      needConnect: [{ name: 'jira', scope: 'org' }],
    });
    const gaps = await svc.computeGaps('org1', 'repo-1');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('broken_auth');
  });
});
