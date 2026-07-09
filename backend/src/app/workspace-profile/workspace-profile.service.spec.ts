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
});
