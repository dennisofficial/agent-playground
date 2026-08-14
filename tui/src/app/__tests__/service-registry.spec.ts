import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobDir, jobServicesFile } from '../../domain/paths.js';
import { EServiceStatus, type ServiceEntry } from '../../domain/services.js';
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

    registry.reapJob(jobId);
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

    registry.reapJob(jobId);
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

    registry.reapJob(jobId);
  });

  it('is scoped to the job — one job never sees what another job started', async () => {
    const registry = new ServiceRegistryService();
    const mine = newJob();
    const theirs = newJob();

    await registry.start({ jobId: mine, command: 'sleep 30', description: 'mine', cwd: tmpdir() });

    expect(registry.listFor(theirs)).toHaveLength(0);
    expect(await registry.list({ jobId: theirs })).toContain('No services in this job');

    registry.reapJob(mine);
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

describe('ServiceRegistryService.stop', () => {
  /**
   * The whole reason for spawning detached. A dev server is a tree — `pnpm dev` spawns node spawns
   * more — and a kill by pid leaves the grandchildren holding the port. This test starts a shell
   * whose real work is a CHILD of that shell, and asserts the child dies too.
   */
  it('kills the group, so a grandchild goes with the shell that started it', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();
    const marker = join(tmpdir(), `svc-spec-${randomUUID()}.pid`);

    await registry.start({
      jobId,
      command: `sleep 30 & echo $! > ${marker}; wait`,
      description: 'a tree',
      cwd: tmpdir(),
    });
    const [entry] = registry.listFor(jobId);
    if (!entry) throw new Error('no entry recorded');

    await waitFor(
      () => existsSync(marker) && readFileSync(marker, 'utf8').trim().length > 0,
      'the grandchild to report its pid',
    );
    const grandchild = Number(readFileSync(marker, 'utf8').trim());
    expect(alive(grandchild)).toBe(true);

    await registry.stop({ jobId, id: entry.id });
    await waitFor(() => !alive(grandchild), 'the grandchild to die with its group');
    expect(entry.status).toBe(EServiceStatus.killed);
    rmSync(marker, { force: true });
  });

  it('leaves the log where it was, because that is the whole record of what ran', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    await registry.start({ jobId, command: 'echo hello; sleep 30', description: 'talker', cwd: tmpdir() });
    const [entry] = registry.listFor(jobId);
    if (!entry) throw new Error('no entry recorded');
    await waitFor(
      () => existsSync(entry.logPath) && readFileSync(entry.logPath, 'utf8').includes('hello'),
      'the log to be written',
    );

    const reply = await registry.stop({ jobId, id: entry.id });
    expect(reply).toContain(entry.logPath);
    expect(readFileSync(entry.logPath, 'utf8')).toContain('hello');
  });

  it('is idempotent — a second stop is a sentence, not a throw', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    await registry.start({ jobId, command: 'sleep 30', description: 'sleeper', cwd: tmpdir() });
    const [entry] = registry.listFor(jobId);
    if (!entry) throw new Error('no entry recorded');

    await registry.stop({ jobId, id: entry.id });
    // The mirror moves with the memory, on every status change and not only on membership ones.
    expect(mirror(jobId)[0]?.status).toBe(EServiceStatus.killed);

    const second = await registry.stop({ jobId, id: entry.id });
    expect(second).toContain('already gone');
    expect(second).toContain('killed');
  });

  /**
   * The exit lands a beat AFTER the kill, and `killed` is the more honest account of why a process
   * is gone than the signal it died of. Without the `running` guard in the exit watcher this flips
   * to `exited (143)` a moment later, and the human reading the services page cannot tell a service
   * they stopped from one that fell over.
   */
  it('stays killed once the exit it caused actually lands', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    await registry.start({ jobId, command: 'sleep 30', description: 'sleeper', cwd: tmpdir() });
    const [entry] = registry.listFor(jobId);
    if (!entry) throw new Error('no entry recorded');

    await registry.stop({ jobId, id: entry.id });
    await waitFor(() => entry.exitCode !== undefined, 'the exit code to land');

    expect(entry.status).toBe(EServiceStatus.killed);
    expect(mirror(jobId)[0]?.status).toBe(EServiceStatus.killed);
  });

  it('answers an unknown id with a sentence that names the way to find the real one', async () => {
    const registry = new ServiceRegistryService();
    const reply = await registry.stop({ jobId: newJob(), id: 'not-a-service' });
    expect(reply).toContain('No service');
    expect(reply).toContain('service_list');
  });

  /**
   * Stopping something that already died on its own is the common case — the dev server crashed an
   * hour ago and the model does not know. `killGroup` swallows only `ESRCH`, so this is the path that
   * proves it: it must not throw, and it must not claim to have stopped anything.
   */
  it('answers a service that already exited without pretending to have killed it', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    await registry.start({ jobId, command: 'exit 0', description: 'quitter', cwd: tmpdir() });
    const [entry] = registry.listFor(jobId);
    if (!entry) throw new Error('no entry recorded');
    await waitFor(() => entry.status === EServiceStatus.exited, 'the service to exit');

    const reply = await registry.stop({ jobId, id: entry.id });
    expect(reply).toContain('already gone');
    expect(reply).toContain('exited');
  });
});

/**
 * A command that does not exist spawns perfectly well and dies with 127 a millisecond later, and it
 * is by far the commonest way a real `service_start` fails. Answering "Started" for it hands the
 * model an id it will then reason about as a running server.
 */
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
    registry.reapJob(jobId);
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

describe('ServiceRegistryService.reapJob', () => {
  it('kills what is running and forgets the job', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    await registry.start({ jobId, command: 'sleep 30', description: 'one', cwd: tmpdir() });
    await registry.start({ jobId, command: 'sleep 30', description: 'two', cwd: tmpdir() });
    const pids = registry.listFor(jobId).map((row) => row.pid);

    const killed = registry.reapJob(jobId);

    expect(killed).toHaveLength(2);
    expect(registry.listFor(jobId)).toHaveLength(0);
    for (const pid of pids) {
      await waitFor(() => !alive(pid), `pid ${pid} to die`);
    }
  });

  /**
   * The mirror is written BEFORE the job is forgotten, and this is why: a deletion that fails
   * halfway must not leave a file on disk claiming two processes are live when they are not. It is
   * also the only thing the deferred crash-orphan reconcile would have to read.
   */
  it('records the kill in services.json before dropping the job', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    await registry.start({ jobId, command: 'sleep 30', description: 'one', cwd: tmpdir() });
    registry.reapJob(jobId);

    expect(mirror(jobId).map((row) => row.status)).toEqual([EServiceStatus.killed]);
  });

  it('is safe on a job that never started one', () => {
    const registry = new ServiceRegistryService();
    expect(registry.reapJob(newJob())).toEqual([]);
  });

  /**
   * A group that did not actually die stays `running`, and this is the load-bearing half of the
   * reap: `running` is what slice 05's exit backstop sweeps and what the deferred reconcile matches
   * against — the whole reason `services.json` records a pgid at all. An optimistic `killed` here
   * would tell every remaining layer the leak was already handled, and each of them would agree.
   */
  it('does not record a kill it did not make', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    await registry.start({ jobId, command: 'sleep 30', description: 'ghost', cwd: tmpdir() });
    const [entry] = registry.listFor(jobId);
    if (!entry) throw new Error('no entry recorded');
    const realPid = entry.pid;
    // A pgid past the kernel's range: what a stale `services.json` looks like after a reboot, and
    // the only way to reach this branch without racing the exit watcher.
    entry.pgid = 4_194_303;

    expect(registry.reapJob(jobId)).toEqual([]);
    expect(mirror(jobId)[0]?.status).toBe(EServiceStatus.running);

    process.kill(-realPid, 'SIGTERM');
  });

  /**
   * Best-effort, unlike `stop()` where a throw is the model's answer. This runs from a job deletion
   * that has already removed the row and from a React effect: one unsignallable group must not abort
   * the loop, skip the persist, or leave the job in the map for a tree that is already gone.
   */
  it('carries on past a group it cannot signal', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    await registry.start({ jobId, command: 'sleep 30', description: 'poisoned', cwd: tmpdir() });
    await registry.start({ jobId, command: 'sleep 30', description: 'ordinary', cwd: tmpdir() });
    const [bad, good] = registry.listFor(jobId);
    if (!bad || !good) throw new Error('no entries recorded');
    const realPid = bad.pid;
    // A negative pgid rather than the more realistic `0`, deliberately: `killGroup`'s floor is what
    // stops `0` meaning "my own process group", and a test that relied on that floor would SIGTERM
    // the test runner the day someone deleted it. `-5` throws with the floor and throws without it.
    bad.pgid = -5;

    expect(registry.reapJob(jobId)).toEqual([good.id]);
    expect(registry.listFor(jobId)).toHaveLength(0);
    expect(mirror(jobId).map((row) => row.status)).toEqual([
      EServiceStatus.running,
      EServiceStatus.killed,
    ]);

    process.kill(-realPid, 'SIGTERM');
  });

  /**
   * The exit watcher outlives the reap — `sleep 30` resolves its `exited` promise a beat after the
   * group dies, by which time the job is gone from the map. Writing the mirror back then would
   * recreate a file a job deletion had just removed, under a `jobDir` that no longer exists.
   */
  it('does not let a pending exit resurrect the mirror of a reaped job', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    await registry.start({ jobId, command: 'sleep 30', description: 'one', cwd: tmpdir() });
    const [entry] = registry.listFor(jobId);
    if (!entry) throw new Error('no entry recorded');
    registry.reapJob(jobId);
    rmSync(jobDir(jobId), { recursive: true, force: true });

    await waitFor(() => !alive(entry.pid), 'the service to die');
    await Bun.sleep(100);
    expect(existsSync(jobServicesFile(jobId))).toBe(false);
  });
});
