// ABORTING — a mid-turn cooperative abort stops a running turn promptly with a CLEAN terminal frame. The
// engine only subscribes to `turn:{T}:abort` for a `steerable` turn, so this drives a steerable long turn,
// then PUBLISHes `{t:'abort'}` to `turn:{T}:abort` (exactly what `RedisEngineRunner.stop()` does). Asserts a
// `final` frame lands within a short grace after the abort (a graceful stop — engine-core turns a cooperative
// cancel of a streaming turn into a normal `final` with the partial transcript), i.e. no hang, no error frame.
import {
  cleanup,
  frameKinds,
  kickEngine,
  makeSpec,
  newRedis,
  newTurnId,
  report,
  requireSandboxArg,
  tailEvents,
  turnKeys,
  xadd,
  type Frame,
  type ScenarioResult,
} from './lib/harness';

/** Max wait from publishing abort to the terminal frame before we call it a hang. */
const ABORT_GRACE_MS = 30_000;

export async function run(sandbox: string): Promise<ScenarioResult> {
  const redis = newRedis();
  const turnId = newTurnId();
  const k = turnKeys(turnId);
  try {
    const spec = makeSpec(turnId, {
      homeType: 'brain',
      steerable: true,
      richStream: true,
      task: 'Count slowly from 1 to 100. Print each number on its own line with a one-sentence factoid. Go slowly.',
      systemPrompt: 'You are a verbose test assistant; produce a long multi-line streamed answer.',
    });
    console.log(`[aborting] turn ${turnId} on ${sandbox}`);
    await xadd(redis, k.spec, spec);
    kickEngine(sandbox, turnId, { detached: true, quiet: true });

    let abortedAt = 0;
    let aborted = false;
    const onFrame = (f: Frame): void => {
      const kind = (f.e as { kind?: string })?.kind;
      if (!aborted && f.t === 'event' && (kind === 'text' || kind === 'text_delta')) {
        aborted = true;
        abortedAt = Date.now();
        // pub/sub abort — the engine subscribed on startup (steerable), so publish once it is streaming.
        void redis.publish(k.abort, JSON.stringify({ t: 'abort' }));
        console.log('[aborting] published abort to :abort at first streamed text');
      }
    };

    const { frames, final, error, timedOut } = await tailEvents(redis, turnId, {
      timeoutMs: 150_000,
      onFrame,
    });
    console.log(`[aborting] frames: ${frameKinds(frames)}`);
    if (!aborted) return { pass: false, detail: 'turn produced no streamed text to abort against' };

    const stoppedAfterMs = final || error ? Date.now() - abortedAt : -1;
    console.log(
      `[aborting] terminal=${final ? 'final' : error ? 'error' : 'NONE'} ${stoppedAfterMs}ms after abort; timedOut=${timedOut}`,
    );
    if (timedOut) return { pass: false, detail: 'HANG: no terminal frame within 150s of abort' };
    if (error)
      return {
        pass: false,
        detail: `abort produced an error frame, not a clean stop: ${String(error.message).slice(0, 160)}`,
      };
    // A clean, prompt graceful stop: a `final` frame within the abort grace window.
    const prompt = stoppedAfterMs >= 0 && stoppedAfterMs <= ABORT_GRACE_MS;
    return {
      pass: !!final && prompt,
      detail: prompt
        ? `clean final ${stoppedAfterMs}ms after abort (≤ ${ABORT_GRACE_MS}ms grace)`
        : `final arrived but ${stoppedAfterMs}ms after abort (> ${ABORT_GRACE_MS}ms grace)`,
    };
  } finally {
    await cleanup(redis, turnId);
    redis.disconnect();
  }
}

if (require.main === module) {
  const sandbox = requireSandboxArg('aborting.e2e.ts');
  run(sandbox)
    .then((r) => report('aborting', r.pass, r.detail))
    .catch((e) => report('aborting', false, String(e)));
}
