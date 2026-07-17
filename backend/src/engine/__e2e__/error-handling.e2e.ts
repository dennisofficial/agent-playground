// ERROR HANDLING — a turn that fails produces a terminal `error` frame carrying the EXPECTED
// CLASSIFICATION, not just any error. The most deterministic classified failure is a missing subscription
// credential: the engine's `EngineCore.resolveAuth` has NO env fallback and THROWS an `EngineAuthError`
// (`isAuthError`, `engine`) when a spec carries no `auth`. `TurnRunner`'s catch maps that onto the error
// frame as `auth:true` + `engine:'claude'`, with the `NO_ENGINE_CREDENTIAL` marker in the message. This
// asserts those classification fields (not merely that some error occurred), and that the failure is
// FAST — no hang, no crash-without-a-frame.
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
    // `auth: false` → build a spec with NO auth block, driving the deterministic no-credential auth halt.
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
