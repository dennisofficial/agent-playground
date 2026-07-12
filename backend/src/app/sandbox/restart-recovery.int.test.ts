import type { EnvService } from '@core/config/env/env.service';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EngineRunnerPort, RunEngineArgs } from '../engine';
import type { FeatureSandbox } from '../git';
import { agentMessage } from '../prompt-kit/message';
import type { StepEntity } from '../persistence/entities';
import { TurnRunnerService } from '../runner/turn-runner.service';
import { DockerodeContainerEngine } from './dockerode-container-engine';
import { SandboxImageBuilder } from './sandbox-image.builder';
import { SandboxManager } from './sandbox-manager.service';
import type { Repository } from 'typeorm';

/**
 * Integration test: Docker restart-recovery + durable session.
 *
 * Proves end-to-end that:
 *   (a) A brand-new SandboxManager instance (simulating a process restart) re-adopts the SAME
 *       running container by deriving the same name from team·project·branch.
 *   (b) TurnRunnerService jobs the persisted session_id back as `args.sessionId` on the
 *       post-restart turn, and directs the exec at the same containerId / execUser.
 *
 * No real LLM — the engine port is a vi.fn() fake. Docker must be reachable.
 */

const env = (v: Record<string, string | undefined> = {}) =>
  ({ get: (k: string) => v[k] }) as unknown as EnvService;

/** Map-backed steps repository that survives across TurnRunnerService instances (models Postgres). */
function makeDurablePhaseRepo(initial: { id: string; session_id: string | null }) {
  const row: { id: string; session_id: string | null } = { ...initial };
  const repo = {
    findOne: vi.fn(async () => ({ session_id: row.session_id } as StepEntity)),
    update: vi.fn(async (_where: { id: unknown }, patch: { session_id?: string }) => {
      if (patch.session_id !== undefined) row.session_id = patch.session_id;
      return { affected: 1 } as never;
    }),
  } as unknown as Repository<StepEntity>;
  return { repo, row };
}

let dockerUp = false;
beforeAll(async () => {
  try {
    await new Docker().ping();
    dockerUp = true;
  } catch {
    dockerUp = false;
  }
});

describe('Docker restart recovery + durable session (integration, needs Docker)', () => {
  const engine1 = new DockerodeContainerEngine(env());
  const builder1 = new SandboxImageBuilder(env(), engine1);

  let repoRoot: string;
  let worktree: string;
  let homeRoot: string;
  let sandbox: FeatureSandbox;
  let manager1: SandboxManager;

  // Thread the container id so afterAll can force-remove it if the test fails mid-flight.
  let attachedContainerId: string | undefined;

  beforeAll(() => {
    if (!dockerUp) return;

    repoRoot = mkdtempSync(join(tmpdir(), 'atlas-restart-'));
    homeRoot = mkdtempSync(join(tmpdir(), 'atlas-restart-home-'));

    const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    git(['init', '-q'], repoRoot);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'Test']);
    execFileSync('bash', ['-c', `echo "# restart-test" > ${repoRoot}/README.md`]);
    git(['add', '-A'], repoRoot);
    git(['commit', '-qm', 'init'], repoRoot);

    // Linked worktree — the real Atlas shape (.git is a file, external gitdir).
    worktree = join(repoRoot, '.worktrees', 'restart-feat');
    git(['worktree', 'add', '-q', worktree, '-b', 'atlas/restart-feat'], repoRoot);

    sandbox = {
      repoId: 'restart-proj',
      branch: 'atlas/restart-feat',
      worktreePath: worktree,
      gitUrl: '',
    };

    manager1 = new SandboxManager(engine1, builder1, env({ AGENT_HOME_ROOT: homeRoot }));
  });

  afterAll(async () => {
    // Best-effort: tear down any container that survived a test failure.
    if (attachedContainerId) {
      await engine1.remove(attachedContainerId, { force: true }).catch(() => undefined);
    }
    for (const p of [repoRoot, homeRoot]) {
      if (p) rmSync(p, { recursive: true, force: true });
    }
  });

  it(
    're-adopts the same container and resumes the persisted session after a simulated restart',
    async () => {
      if (!dockerUp) {
        // eslint-disable-next-line no-console
        console.warn('Docker not reachable — skipping restart-recovery integration test');
        return;
      }

      // Ensure the sandbox image is present before any manager attaches.
      await builder1.ensureImage();

      // ── Durable steps row (survives the "restart") ───────────────────────────────────────
      const { repo: fakePhases, row: phaseRow } = makeDurablePhaseRepo({
        id: 'ph1',
        session_id: null,
      });

      // ── Pre-restart: Instance 1 ───────────────────────────────────────────────────────────
      const s1 = await manager1.attach({ sandbox, orgId: 'team-restart' });
      attachedContainerId = s1.containerId;

      expect(s1.containerId).toBeTruthy();
      expect(s1.execUser).toMatch(/^\d+:\d+$/);

      // Fake engine 1: emits a session event early, then returns.
      const fakeEngine1ReceivedArgs: RunEngineArgs[] = [];
      const fakeEngine1: EngineRunnerPort = {
        run: vi.fn(async (args: RunEngineArgs) => {
          fakeEngine1ReceivedArgs.push(args);
          // Emit the session handle early (mirrors real Claude SDK behaviour).
          args.onEvent?.({ kind: 'session', sessionId: 'SESSION-1' });
          return { result: 'ok', sessionId: 'SESSION-1' };
        }),
      };

      await new TurnRunnerService(fakeEngine1, fakePhases).runTurn({
        orgId: 'team-restart',
        jobId: 'j1',
        stepId: 'ph1',
        sandbox: s1,
        engine: 'claude',
        mode: 'execute',
        task: agentMessage('pre-restart task'),
        systemPrompt: agentMessage('persona'),
      });

      // Session id must be persisted onto the (durable) step row.
      expect(phaseRow.session_id).toBe('SESSION-1');

      // Engine received the docker target.
      expect(fakeEngine1ReceivedArgs).toHaveLength(1);
      const arg1 = fakeEngine1ReceivedArgs[0]!;
      expect(arg1.target?.containerId).toBe(s1.containerId);
      expect(arg1.target?.user).toBe(s1.execUser);

      // ── Simulate process restart: brand-new SandboxManager (new objects) ─────────────────
      const engine2 = new DockerodeContainerEngine(env());
      const builder2 = new SandboxImageBuilder(env(), engine2);
      const manager2 = new SandboxManager(engine2, builder2, env({ AGENT_HOME_ROOT: homeRoot }));

      const s2 = await manager2.attach({ sandbox, orgId: 'team-restart' });

      // Must re-adopt the EXACT same container — same id, same exec user.
      expect(s2.containerId).toBe(s1.containerId);
      expect(s2.execUser).toBe(s1.execUser);

      // ── Post-restart: Instance 2 ──────────────────────────────────────────────────────────
      const fakeEngine2ReceivedArgs: RunEngineArgs[] = [];
      const fakeEngine2: EngineRunnerPort = {
        run: vi.fn(async (args: RunEngineArgs) => {
          fakeEngine2ReceivedArgs.push(args);
          return { result: 'ok2', sessionId: 'SESSION-1' };
        }),
      };

      await new TurnRunnerService(fakeEngine2, fakePhases).runTurn({
        orgId: 'team-restart',
        jobId: 'j1',
        stepId: 'ph1',
        sandbox: s2,
        engine: 'claude',
        mode: 'execute',
        task: agentMessage('post-restart task'),
        systemPrompt: agentMessage('persona'),
      });

      expect(fakeEngine2ReceivedArgs).toHaveLength(1);
      const arg2 = fakeEngine2ReceivedArgs[0]!;

      // Must thread the persisted session id back (RESUME, not respawn).
      expect(arg2.sessionId).toBe('SESSION-1');
      // Must target the SAME container.
      expect(arg2.target?.containerId).toBe(s1.containerId);
      // Must exec as the host uid.
      expect(arg2.target?.user).toBe(s1.execUser);

      // ── Teardown ──────────────────────────────────────────────────────────────────────────
      await manager2.teardown(s2);
      expect(await engine2.inspect(s2.containerId!)).toBeNull();
      attachedContainerId = undefined; // container gone — afterAll guard no longer needed
    },
    120_000,
  );
});
