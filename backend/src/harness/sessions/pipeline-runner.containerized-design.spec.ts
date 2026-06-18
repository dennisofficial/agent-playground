import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineRunnerService } from './pipeline-runner.service';

const pExecFile = promisify(execFile);

/**
 * Phase 11 — the CONTAINERIZED branch of `PipelineRunnerService.attachDesign`. A sandbox run has no host
 * path; the design zip is read, base64-encoded, and shipped to the daemon (`attachDesign`), which unzips
 * it into the sandbox clone's `design/`. NO session id is threaded (the design gate has no engine session
 * — the daemon writes to the clone root). The host filesystem unzip path is NOT taken.
 *
 * Driven with fakes (no Redis/Docker). The LOCAL design-gate unzip is covered by
 * pipeline-runner.section-driver.spec.ts (unchanged).
 */

const SANDBOX = 'sandbox-uuid-1';
const TEAM = 'T1';

function build() {
  const run = {
    id: 'run-1',
    team: TEAM,
    taskId: 41,
    workspaceId: SANDBOX,
    status: 'paused',
    planningSubstep: 'awaiting_design',
  };
  const runs = {
    getByTask: vi.fn(async () => run),
    get: vi.fn(async () => ({ ...run, status: 'running', planningSubstep: null })),
    update: vi.fn(async () => undefined),
  };
  const attachDesign = vi.fn(async () => ({ ok: true, message: 'attached' }));
  const daemon = { attachDesign };
  const workspaceGit = {
    daemonFor: vi.fn(() => daemon),
  };
  // The host workspace lookup + unzip must NOT happen on the containerized path.
  const hostGet = vi.fn(() => ({ path: '/should/not/be/used' }));
  const workspaces = { get: hostGet };
  const sandboxes = { has: (id: string) => id === SANDBOX };
  // The design section + advance tail — stub so attachDesign's success tail doesn't explode.
  const sectionStore = {
    activeSection: vi.fn(async () => ({ id: 'sec-1' })),
    update: vi.fn(async () => undefined),
    nextPending: vi.fn(async () => undefined),
    listForRun: vi.fn(async () => [{ status: 'done' }]),
  };
  const noop = () => undefined;
  const noopAsync = vi.fn(async () => undefined);
  const review = {
    shipTask: vi.fn(async () => ({ ok: true, prUrl: 'http://pr/1' })),
    reviewFullImplementation: vi.fn(async () => ({ verdict: 'pass', findings: '' })),
  };
  const sessions = { onUpdate: noop, get: async () => undefined };
  const stub = (over: Record<string, unknown> = {}) =>
    new Proxy({ ...over }, { get: (t, p) => (p in t ? (t as never)[p] : noopAsync) });

  const svc = new PipelineRunnerService(
    runs as never,
    sectionStore as never,
    stub() as never, // runner
    sessions as never,
    stub() as never, // board
    stub() as never, // employees
    stub() as never, // plans
    stub() as never, // proposals
    review as never,
    { emit: noop, onEvent: noop } as never, // boardEvents
    workspaces as never,
    stub() as never, // phaseStore
    stub() as never, // codingStore
    stub() as never, // reviewStore
    stub() as never, // notes
    sandboxes as never,
    workspaceGit as never,
  );
  return { svc, attachDesign, daemon, workspaceGit, hostGet };
}

describe('PipelineRunnerService.attachDesign — containerized routing', () => {
  let zip: string;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'design-spec-'));
    await writeFile(join(dir, 'tokens.json'), '{"x":1}\n');
    zip = join(dir, 'design.zip');
    await pExecFile('zip', ['-j', zip, join(dir, 'tokens.json')]);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the local zip, base64s it, ships it to the daemon, and never touches the host FS', async () => {
    const f = build();
    const res = await f.svc.attachDesign(TEAM, 41, zip);
    expect(res.ok).toBe(true);
    expect(f.workspaceGit.daemonFor).toHaveBeenCalledWith({ workspaceId: SANDBOX });
    expect(f.attachDesign).toHaveBeenCalledTimes(1);
    // The arg is the base64 of the zip (a real zip starts with 'PK' → base64 'UEs').
    const calls = f.attachDesign.mock.calls as unknown as string[][];
    const b64 = calls[0][0];
    expect(b64.startsWith('UEs')).toBe(true);
    // The HOST workspace lookup (the local-FS unzip path) is NOT taken.
    expect(f.hostGet).not.toHaveBeenCalled();
  });

  it('surfaces a daemon attachDesign failure as a clear message', async () => {
    const f = build();
    f.daemon.attachDesign.mockResolvedValueOnce({ ok: false, message: 'unzip blew up' });
    const res = await f.svc.attachDesign(TEAM, 41, zip);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/unzip blew up/);
  });
});
