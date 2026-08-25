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
  type ScenarioResult,
} from './lib/harness';

export async function run(sandbox: string): Promise<ScenarioResult> {
  const redis = newRedis();
  const turnId = newTurnId();
  const k = turnKeys(turnId);
  try {
    const spec = makeSpec(turnId, {
      auth: false,
      task: 'Reply with exactly one word: pong.',
    });
    console.log(`[error] turn ${turnId} on ${sandbox} (spec deliberately carries no auth)`);
    await xadd(redis, k.spec, spec);
    kickEngine(sandbox, turnId, { detached: true, quiet: true });

    const { frames, final, error, timedOut } = await tailEvents(redis, turnId, {
      timeoutMs: 60_000,
    });
    console.log(`[error] frames: ${frameKinds(frames)}`);
    if (timedOut)
      return { pass: false, detail: 'HANG: no terminal frame within 60s (should fail fast)' };
    if (final)
      return {
        pass: false,
        detail: 'unexpected success final (auth was omitted — expected an error)',
      };
    if (!error) return { pass: false, detail: 'no error frame produced' };

    const message = String(error.message ?? '');
    const authClassified = error.auth === true;
    const engineClassified = error.engine === 'claude';
    const markerPresent = message.includes('NO_ENGINE_CREDENTIAL');
    console.log(
      `[error] error frame: auth=${error.auth} engine=${JSON.stringify(error.engine)} msg="${message.slice(0, 120)}"`,
    );
    const pass = authClassified && engineClassified && markerPresent;
    return {
      pass,
      detail: pass
        ? 'error frame classified auth:true engine:claude with NO_ENGINE_CREDENTIAL marker'
        : `classification mismatch (auth=${error.auth} engine=${JSON.stringify(error.engine)} marker=${markerPresent})`,
    };
  } finally {
    await cleanup(redis, turnId);
    redis.disconnect();
  }
}

if (require.main === module) {
  const sandbox = requireSandboxArg('error-handling.e2e.ts');
  run(sandbox)
    .then((r) => report('error', r.pass, r.detail))
    .catch((e) => report('error', false, String(e)));
}
