import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobDir, jobServicesFile } from '../../domain/paths.js';
import { EServiceStatus, type ServiceEntry } from '../../domain/services.js';
import { killGroup } from '../service-process.js';
import { ServiceRegistryService } from '../service-registry.service.js';
import { alive, jobTracker, waitFor } from './real-process.fixture.js';

/**
 * How a service ENDS: `stop` for one the model or the human names, `reapJob` for every service a job
 * owns when the job goes away. Both against real process groups — see `real-process.fixture.ts`.
 */

const jobs = jobTracker('spec-teardown');
const newJob = jobs.newJob;

afterEach(() => {
  jobs.cleanup();
});

function mirror(jobId: string): ServiceEntry[] {
  const path = jobServicesFile(jobId);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as ServiceEntry[];
}

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
    // Once the death Atlas caused has actually been WATCHED there is nothing left to signal, and
    // only then is "already gone" the honest answer.
    await waitFor(() => entry.exitCode !== undefined, 'the exit to land');

    const second = await registry.stop({ jobId, id: entry.id });
    expect(second).toContain('already gone');
    expect(second).toContain('killed');
  });

  /**
   * The one service that needs insisting on, and the reason `stop` asks `stopAction` rather than
   * `isRunning`.
   *
   * `killed` is recorded on signal DELIVERY, not on death, so a group that traps SIGTERM reads as
   * killed while it still holds its port. A second press answering "already gone" would leave the
   * only verb that can end a service unable to end this one — a dead end, on exactly the service a
   * human is most likely to be pressing `k` at twice.
   */
  it('escalates to SIGKILL for a group that ignored SIGTERM', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    // The loop matters: a bare `trap '' TERM; sleep 30` still dies, because the group kill reaps the
    // `sleep` child and the shell then runs off the end of its script.
    await registry.start({
      jobId,
      command: "trap '' TERM; while true; do sleep 0.2; done",
      description: 'stubborn',
      cwd: tmpdir(),
    });
    const [entry] = registry.listFor(jobId);
    if (!entry) throw new Error('no entry recorded');

    // A SIGTERM-immune busy loop, forking twice a second: an assertion that threw before the second
    // stop would leave it running after the test runner had gone.
    try {
      const first = await registry.stop({ jobId, id: entry.id });
      expect(first).toContain('Stopped');
      expect(first).not.toContain('SIGKILL');
      // It trapped the signal and is still there. Nothing watched it die, so it has no exit code.
      expect(entry.exitCode).toBeUndefined();
      expect(entry.status).toBe(EServiceStatus.killed);

      const second = await registry.stop({ jobId, id: entry.id });
      expect(second).toContain('SIGKILL');
      await waitFor(() => entry.exitCode !== undefined, 'the group to actually die');
    } finally {
      killGroup({ pgid: entry.pgid, signal: 'SIGKILL' });
    }
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

describe('ServiceRegistryService.reapJob', () => {
  it('kills what is running and forgets the job', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    await registry.start({ jobId, command: 'sleep 30', description: 'one', cwd: tmpdir() });
    await registry.start({ jobId, command: 'sleep 30', description: 'two', cwd: tmpdir() });
    const pids = registry.listFor(jobId).map((row) => row.pid);

    const killed = await registry.reapJob(jobId);

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
    await registry.reapJob(jobId);

    expect(mirror(jobId).map((row) => row.status)).toEqual([EServiceStatus.killed]);
  });

  it('is safe on a job that never started one', async () => {
    const registry = new ServiceRegistryService();
    expect(await registry.reapJob(newJob())).toEqual([]);
  });

  /**
   * Two things that look alike and are not: Atlas must not claim a kill it did not make, and it must
   * not go on believing in a group the kernel has just denied.
   *
   * `killed` is out — that would tell every remaining layer the leak was handled. But `running` is
   * out too, and that is the half this test used to get wrong: ESRCH is the kernel saying the group
   * is already gone, which is as final as a watched exit and more urgent, because a reaped pgid can
   * be reissued to something else entirely. Leaving the row `running` re-signals it from the exit
   * backstop and hands the deferred reconcile a live-looking pgid pointing at a stranger. `exited`
   * with no `exitCode` is the honest record: gone, but not by a death Atlas watched.
   */
  it('records a denied group as gone, crediting itself with no kill', async () => {
    const registry = new ServiceRegistryService();
    const jobId = newJob();

    await registry.start({ jobId, command: 'sleep 30', description: 'ghost', cwd: tmpdir() });
    const [entry] = registry.listFor(jobId);
    if (!entry) throw new Error('no entry recorded');
    const realPid = entry.pid;
    // A pgid past the kernel's range: what a stale `services.json` looks like after a reboot, and
    // the only way to reach this branch without racing the exit watcher.
    entry.pgid = 4_194_303;

    expect(await registry.reapJob(jobId)).toEqual([]);
    expect(mirror(jobId)[0]?.status).toBe(EServiceStatus.exited);
    // No code: `exitCode` is written by the exit watcher and nowhere else, so its absence is what
    // distinguishes "the kernel says gone" from "Atlas watched it die".
    expect(mirror(jobId)[0]?.exitCode).toBeUndefined();

    process.kill(-realPid, 'SIGTERM');
  });

  /**
   * Best-effort, unlike `stop()` where a throw is the model's answer. This runs from a job deletion
   * that has already removed the row and from a claim-takeover callback: one unsignallable group
   * must not abort the loop, skip the persist, or leave the job in the map for a tree already gone.
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

    expect(await registry.reapJob(jobId)).toEqual([good.id]);
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
    await registry.reapJob(jobId);
    rmSync(jobDir(jobId), { recursive: true, force: true });

    await waitFor(() => !alive(entry.pid), 'the service to die');
    await Bun.sleep(100);
    expect(existsSync(jobServicesFile(jobId))).toBe(false);
  });
});
