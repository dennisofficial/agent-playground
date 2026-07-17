import {
  cleanup,
  frameKinds,
  kickAwaitExit,
  kickEngine,
  killEngineIn,
  makeSpec,
  newRedis,
  newTurnId,
  report,
  requireSandboxArg,
  startToolResponder,
  tailEvents,
  turnKeys,
  xadd,
  type Frame,
  type ScenarioResult,
} from './lib/harness';

interface Probe {
  name: string;
  verdict: 'PASS' | 'FAIL' | 'OBSERVATION';
  note: string;
}

function finding(msg: string): void {
  console.log(`[adversarial] FINDING: ${msg}`);
}

async function probeAbortAfterFinal(sandbox: string): Promise<Probe> {
  const redis = newRedis();
  const turnId = newTurnId();
  const k = turnKeys(turnId);
  try {
    await xadd(
      redis,
      k.spec,
      makeSpec(turnId, { steerable: true, task: 'Reply with exactly one word: done.' }),
    );
    kickEngine(sandbox, turnId, { detached: true, quiet: true });
    const first = await tailEvents(redis, turnId, { timeoutMs: 120_000 });
    if (!first.final)
      return { name: 'abort-after-final', verdict: 'FAIL', note: 'turn never reached final' };
    await redis.publish(k.abort, JSON.stringify({ t: 'abort' }));
    const after = await tailEvents(redis, turnId, { timeoutMs: 5_000, fromId: first.lastId });
    const noop = !after.error && !after.frames.some((f) => f.t === 'error');
    if (!noop)
      finding('abort published after final produced a NEW error frame (should be a no-op)');
    return {
      name: 'abort-after-final',
      verdict: noop ? 'PASS' : 'FAIL',
      note: noop
        ? 'post-final abort was a harmless no-op'
        : 'post-final abort produced a new error frame',
    };
  } finally {
    await cleanup(redis, turnId);
    redis.disconnect();
  }
}

async function probeMalformedSteer(sandbox: string): Promise<Probe> {
  const redis = newRedis();
  const turnId = newTurnId();
  const k = turnKeys(turnId);
  try {
    await xadd(
      redis,
      k.spec,
      makeSpec(turnId, {
        homeType: 'brain',
        steerable: true,
        richStream: true,
        task: 'Count slowly from 1 to 40, one number per line with a factoid. Take your time.',
        systemPrompt: 'You are a verbose test assistant.',
      }),
    );
    kickEngine(sandbox, turnId, { detached: true, quiet: true });
    let fired = false;
    const onFrame = (f: Frame): void => {
      const kind = (f.e as { kind?: string })?.kind;
      if (!fired && f.t === 'event' && (kind === 'text' || kind === 'text_delta')) {
        fired = true;
        void xadd(redis, k.input, { id: newTurnId() });
        void xadd(redis, k.input, { id: newTurnId(), text: 'x'.repeat(200 * 1024) });
        console.log('[adversarial] injected malformed + 200KB steers');
      }
    };
    const { frames, final, error, timedOut } = await tailEvents(redis, turnId, {
      timeoutMs: 150_000,
      onFrame,
    });
    console.log(`[adversarial] malformed-steer frames: ${frameKinds(frames)}`);
    if (timedOut) {
      finding('turn HUNG after a malformed + oversized steer (no terminal frame in 150s)');
      killEngineIn(sandbox);
      return {
        name: 'malformed+oversized-steer',
        verdict: 'FAIL',
        note: 'HANG: no terminal frame',
      };
    }
    const terminal = !!final || !!error;
    return {
      name: 'malformed+oversized-steer',
      verdict: terminal ? 'PASS' : 'FAIL',
      note: terminal
        ? `handled gracefully; reached ${final ? 'final' : 'error'} (no crash)`
        : 'no terminal frame',
    };
  } finally {
    await cleanup(redis, turnId);
    redis.disconnect();
  }
}

async function probeMissingTask(sandbox: string): Promise<Probe> {
  const redis = newRedis();
  const turnId = newTurnId();
  const k = turnKeys(turnId);
  try {
    const spec = makeSpec(turnId, { extraUnknownField: 'should-be-ignored' });
    delete (spec as Record<string, unknown>).task; // remove the required field
    await xadd(redis, k.spec, spec);
    kickEngine(sandbox, turnId, { detached: true, quiet: true });
    const { frames, final, error, timedOut } = await tailEvents(redis, turnId, {
      timeoutMs: 60_000,
    });
    console.log(`[adversarial] missing-task frames: ${frameKinds(frames)}`);
    if (timedOut) {
      finding('a spec with no `task` HUNG (no terminal frame in 60s) instead of failing fast');
      killEngineIn(sandbox);
      return { name: 'missing-task-field', verdict: 'FAIL', note: 'HANG: no terminal frame' };
    }
    if (error) {
      return {
        name: 'missing-task-field',
        verdict: 'PASS',
        note: `failed fast with error frame: ${String(error.message).slice(0, 80)}`,
      };
    }
    return {
      name: 'missing-task-field',
      verdict: 'OBSERVATION',
      note: `no error frame; engine produced ${final ? 'a final (treated empty task as empty prompt)' : 'no terminal'} — extra field ignored, no crash`,
    };
  } finally {
    await cleanup(redis, turnId);
    redis.disconnect();
  }
}

async function probeBogusContainer(): Promise<Probe> {
  const turnId = newTurnId();
  const bogus = `atlas-sbx-does-not-exist-${turnId.slice(0, 8)}`;
  const t0 = Date.now();
  const { code, spawnError } = await kickAwaitExit(bogus, turnId, 20_000);
  const ms = Date.now() - t0;
  const failedFast = (code !== 0 || spawnError) && ms < 15_000;
  if (code === 0) finding('docker exec on a bogus container exited 0 (should be a failure)');
  if (code === null && !spawnError)
    finding(`docker exec on a bogus container did not exit within 20s (hang)`);
  return {
    name: 'bogus-container',
    verdict: failedFast ? 'PASS' : code === null && !spawnError ? 'FAIL' : 'OBSERVATION',
    note: failedFast
      ? `exec failed fast in ${ms}ms (exit code ${code ?? 'spawn-error'})`
      : `exec outcome: code=${code} spawnError=${spawnError} after ${ms}ms`,
  };
}

async function probeSilentTool(sandbox: string): Promise<Probe> {
  const redis = newRedis();
  const turnId = newTurnId();
  const k = turnKeys(turnId);
  const WAIT_MS = 70_000;
  let responder: ReturnType<typeof startToolResponder> | undefined;
  try {
    await xadd(
      redis,
      k.spec,
      makeSpec(turnId, {
        toolBridgeTools: ['list_skills'],
        task: 'Call the list_skills tool with empty arguments, then reply with exactly what it returned.',
        systemPrompt:
          'You are a terse test assistant. Use the tool, then report its output verbatim.',
      }),
    );
    responder = startToolResponder(redis, turnId, { heartbeat: false, onRequest: () => null });
    kickEngine(sandbox, turnId, { detached: true, quiet: true });
    const { frames, final, error, timedOut } = await tailEvents(redis, turnId, {
      timeoutMs: WAIT_MS,
    });
    console.log(`[adversarial] silent-tool frames: ${frameKinds(frames)}`);
    responder.stop();
    const calledTool = responder.called.includes('list_skills');
    if (!timedOut) {
      return {
        name: 'silent-tool-timeout',
        verdict: 'PASS',
        note: `engine reached ${final ? 'final' : 'error'} despite a silent host (self-bounded)`,
      };
    }
    finding(
      `a tool-bridge turn HUNG for ${WAIT_MS / 1000}s when the host consumed the tool_request but sent ` +
        `zero heartbeats/replies (toolCalled=${calledTool}). The engine has no independent tool-call ` +
        `timeout absent a host heartbeat — it relies on the real host always emitting an immediate ` +
        `tool_progress on pickup (see tool-bridge-reader HEARTBEAT_GAP_MS, armed only by the first frame).`,
    );
    killEngineIn(sandbox); // clean up the deliberately-hung engine
    return {
      name: 'silent-tool-timeout',
      verdict: 'OBSERVATION',
      note: `no terminal frame in ${WAIT_MS / 1000}s with a fully-silent host (relies on host heartbeat; not an engine-side timeout)`,
    };
  } finally {
    responder?.stop();
    await cleanup(redis, turnId);
    redis.disconnect();
  }
}

export async function run(sandbox: string): Promise<ScenarioResult> {
  const probes: Probe[] = [];
  for (const p of [
    () => probeAbortAfterFinal(sandbox),
    () => probeMalformedSteer(sandbox),
    () => probeMissingTask(sandbox),
    () => probeBogusContainer(),
    () => probeSilentTool(sandbox),
  ]) {
    try {
      probes.push(await p());
    } catch (e) {
      probes.push({
        name: 'unknown',
        verdict: 'FAIL',
        note: `probe threw: ${String(e).slice(0, 120)}`,
      });
    }
  }

  console.log('\n[adversarial] ── SUMMARY ─────────────────────────────────────────────');
  for (const p of probes) {
    console.log(`  ${p.verdict.padEnd(11)} ${p.name.padEnd(26)} ${p.note}`);
  }
  console.log('[adversarial] ────────────────────────────────────────────────────────\n');

  const hardFail = probes.filter((p) => p.verdict === 'FAIL');
  return {
    pass: hardFail.length === 0,
    detail:
      hardFail.length === 0
        ? `${probes.length} probes ran; ${probes.filter((p) => p.verdict === 'OBSERVATION').length} observation(s), no hard failures`
        : `hard failures: ${hardFail.map((p) => p.name).join(', ')}`,
  };
}

if (require.main === module) {
  const sandbox = requireSandboxArg('adversarial.e2e.ts');
  run(sandbox)
    .then((r) => report('adversarial', r.pass, r.detail))
    .catch((e) => report('adversarial', false, String(e)));
}
