import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobDir, jobServicesFile } from '../../domain/paths.js';
import { EServiceStatus, type ServiceEntry } from '../../domain/services.js';
import { writeServiceMirror } from '../service-mirror.js';
import { killGroup } from '../service-process.js';
import { ServiceRegistryService } from '../service-registry.service.js';

/**
 * Against REAL processes, deliberately.
 *
 * Everything this slice promises is an operating-system fact — the child outlives the turn, its
 * group can be reaped, the tree goes with it — and a mocked `Bun.spawn` would assert only that the
 * mock was called. So these spawn `sh`, watch `/tmp` and ask the kernel.
 *
 * `jobDir` resolves `~/.atlas` at module load and has no injection seam, so each test takes a fresh
 * uuid job and removes its folder afterwards.
 */

const created: string[] = [];

function newJob(): string {
  const jobId = `spec-services-${randomUUID()}`;
  created.push(jobId);
  return jobId;
}

afterEach(() => {
  for (const jobId of created.splice(0)) {
    rmSync(jobDir(jobId), { recursive: true, force: true });
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is "exists, and is not yours" — alive, and the answer that matters.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function mirror(jobId: string): ServiceEntry[] {
  return JSON.parse(readFileSync(jobServicesFile(jobId), 'utf8')) as ServiceEntry[];
}

describe('ServiceRegistryService.start', () => {
  it('spawns, logs both streams to one file, and hands back an id the model can stop', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    const reply = await registry.start({
      jobId,
      command: 'echo out; echo err >&2; sleep 30',
      description: 'noisy sleeper',
      cwd: tmpdir(),
    });

    const [entry] = registry.listFor(jobId);
    if (!entry) throw new Error('no entry recorded');
    expect(reply).toContain(entry.id);
    expect(reply).toContain(entry.logPath);
    expect(alive(entry.pid)).toBe(true);

    // Both streams, one file, so interleaving in the log matches interleaving in time.
    await waitFor(
      () => existsSync(entry.logPath) && readFileSync(entry.logPath, 'utf8').includes('err'),
      'the log to carry stdout and stderr',
    );
    expect(readFileSync(entry.logPath, 'utf8')).toContain('out');

    await registry.reapJob(jobId);
  });

  /**
   * `pgid` is recorded rather than derived, and this is what it is for: the reconcile job that is
   * deliberately NOT built here has only `services.json` to work from, and a mirror without a group
   * id can kill a shell but never the tree under it.
   */
  it('mirrors the in-memory set to services.json, pid and pgid both', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    await registry.start({
      jobId,
      command: 'sleep 30',
      description: 'sleeper',
      cwd: tmpdir(),
    });
    const [entry] = registry.listFor(jobId);
    if (!entry) throw new Error('no entry recorded');

    expect(mirror(jobId)).toEqual([{ ...entry }]);
    expect(entry.pgid).toBe(entry.pid);
    expect(entry.status).toBe(EServiceStatus.running);

    await registry.reapJob(jobId);
  });

  it('keeps several services in one job apart', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    await registry.start({ jobId, command: 'sleep 30', description: 'one', cwd: tmpdir() });
    await registry.start({ jobId, command: 'sleep 30', description: 'two', cwd: tmpdir() });

    const entries = registry.listFor(jobId);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((row) => row.id)).size).toBe(2);
    expect(new Set(entries.map((row) => row.logPath)).size).toBe(2);

    await registry.reapJob(jobId);
  });

  it('is scoped to the job — one job never sees what another job started', async () => {
    const registry = new ServiceRegistryService();
    const mine = newJob();
    const theirs = newJob();

    await registry.start({ jobId: mine, command: 'sleep 30', description: 'mine', cwd: tmpdir() });

    expect(registry.listFor(theirs)).toHaveLength(0);
    expect(await registry.list({ jobId: theirs })).toContain('No services in this job');

    await registry.reapJob(mine);
  });
});

describe('exit detection', () => {
  /**
   * And no notification. That is the report channel this design deliberately does not have — the
   * model finds out by calling `service_list` or reading the log, which is what it already does.
   */
  it('records the code a service ended with, in memory and on disk', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    await registry.start({ jobId, command: 'exit 3', description: 'quitter', cwd: tmpdir() });
    const [entry] = registry.listFor(jobId);
    if (!entry) throw new Error('no entry recorded');

    await waitFor(() => entry.status === EServiceStatus.exited, 'the service to exit');
    expect(entry.exitCode).toBe(3);
    expect(mirror(jobId)[0]?.status).toBe(EServiceStatus.exited);
    expect(mirror(jobId)[0]?.exitCode).toBe(3);
  });
});

describe('a command that dies on the spot', () => {
  it('is reported as a failure with its code and the shell\'s own words, not as a start', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    const reply = await registry.start({
      jobId,
      command: 'definitely-not-a-real-command-42',
      description: 'doomed',
      cwd: tmpdir(),
    });

    expect(reply).toContain('exited immediately');
    expect(reply).not.toContain('Started');
    expect(reply).toContain('127');
    // The diagnosis itself, inline. The model has no reason to go and read a log for a call it
    // believes succeeded, so the one moment it will not look is the moment worth telling it.
    expect(reply.toLowerCase()).toContain('not found');
    expect(registry.listFor(jobId)[0]?.status).toBe(EServiceStatus.exited);
  });

  // A server that takes a minute to bind is running. The settle is not a health check.
  it('does not report a slow starter as a failure', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    const reply = await registry.start({
      jobId,
      command: 'sleep 30',
      description: 'slow starter',
      cwd: tmpdir(),
    });

    expect(reply).toContain('Started');
    await registry.reapJob(jobId);
  });
});

describe('killGroup refuses a group id it must not signal', () => {
  /**
   * `kill(0, sig)` is POSIX for "my OWN process group" — Atlas and everything sharing its terminal.
   * Unreachable from a live spawn, but `pgid` round-trips through `services.json` and the deferred
   * reconcile is specified to read it back, so the floor is the cheapest possible insurance.
   */
  it('throws on 0 and 1 rather than signalling itself or init', () => {
    for (const pgid of [0, 1, -5]) {
      expect(() => killGroup({ pgid, signal: 'SIGTERM' })).toThrow('refusing to signal');
    }
  });
});

describe('the on-disk mirror', () => {
  /**
   * A deleted job must stay deleted. A service's exit can land after `purgeJobFiles` has removed the
   * job directory, and this write is the last thing to touch that path — recreating it leaves an
   * orphaned folder holding a `services.json` for a job that no longer exists.
   */
  it('does not resurrect a job directory that has been purged', () => {
    const jobId = newJob();
    const dir = jobDir(jobId);
    rmSync(dir, { recursive: true, force: true });

    writeServiceMirror({ jobId, entries: [], warn: () => {} });

    expect(existsSync(dir)).toBe(false);
  });
});

