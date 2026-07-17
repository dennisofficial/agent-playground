// NORMAL TURN — a one-shot review turn round-trips over Redis end to end (ports
// `scripts/redis-transport-smoke.mjs`). Asserts an ordered event sequence ending in `final`, and that the
// result content is the expected single word.
import {
  cleanup,
  finalResult,
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
  type ScenarioResult,
} from './lib/harness';

export async function run(sandbox: string): Promise<ScenarioResult> {
  const redis = newRedis();
  const turnId = newTurnId();
  const k = turnKeys(turnId);
  try {
    const spec = makeSpec(turnId, {
      task: 'Reply with exactly one word: pong. Do not call any tools.',
    });
    console.log(`[normal] turn ${turnId} on ${sandbox}`);
    await xadd(redis, k.spec, spec);
    kickEngine(sandbox, turnId, { detached: true, quiet: true });

    const { frames, final, error } = await tailEvents(redis, turnId, { timeoutMs: 120_000 });
    console.log(`[normal] frames: ${frameKinds(frames)}`);
    if (error)
      return { pass: false, detail: `error frame: ${String(error.message).slice(0, 200)}` };
    if (!final) return { pass: false, detail: 'no final frame' };

    const result = finalResult(final).toLowerCase();
    console.log(`[normal] result: ${JSON.stringify(finalResult(final)).slice(0, 120)}`);
    const kinds = frames.map((f) => f.t);
    const orderedOk = kinds.indexOf('final') === kinds.length - 1; // final is terminal
    const sawResultEvent = frames.some(
      (f) => f.t === 'event' && (f.e as { kind?: string })?.kind === 'result',
    );
    const contentOk = result.includes('pong');
    return {
      pass: orderedOk && sawResultEvent && contentOk,
      detail: contentOk
        ? 'ordered frames ended in final; result contained "pong"'
        : `result did not contain "pong": ${result.slice(0, 80)}`,
    };
  } finally {
    await cleanup(redis, turnId);
    redis.disconnect();
  }
}

if (require.main === module) {
  const sandbox = requireSandboxArg('normal-turn.e2e.ts');
  run(sandbox)
    .then((r) => report('normal', r.pass, r.detail))
    .catch((e) => report('normal', false, String(e)));
}
