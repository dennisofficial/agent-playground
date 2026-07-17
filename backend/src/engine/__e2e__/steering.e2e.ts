import { randomUUID } from 'node:crypto';
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
  type Frame,
  type ScenarioResult,
} from './lib/harness';

export async function run(sandbox: string): Promise<ScenarioResult> {
  const redis = newRedis();
  const turnId = newTurnId();
  const k = turnKeys(turnId);
  const steerId = randomUUID();
  try {
    const spec = makeSpec(turnId, {
      homeType: 'brain',
      steerable: true,
      richStream: true,
      task:
        'Count slowly from 1 to 40. Print each number on its own line with a one-sentence factoid about ' +
        'that number. Take your time and be thorough.',
      systemPrompt: 'You are a verbose test assistant; produce a long multi-line streamed answer.',
    });
    console.log(`[steering] turn ${turnId} on ${sandbox}; steerId=${steerId}`);
    await xadd(redis, k.spec, spec);
    kickEngine(sandbox, turnId, { detached: true, quiet: true });

    let steered = false;
    const onFrame = (f: Frame): void => {
      const kind = (f.e as { kind?: string })?.kind;
      if (!steered && f.t === 'event' && (kind === 'text' || kind === 'text_delta')) {
        steered = true;
        void xadd(redis, k.input, {
          id: steerId,
          text: 'STOP counting immediately. Ignore the rest of the counting task and reply with exactly the single word: BANANA.',
        });
        console.log('[steering] steer XADDed to :input at first streamed text');
      }
    };

    const { frames, final, error } = await tailEvents(redis, turnId, {
      timeoutMs: 150_000,
      onFrame,
    });
    console.log(`[steering] frames: ${frameKinds(frames)}`);
    if (error)
      return { pass: false, detail: `error frame: ${String(error.message).slice(0, 200)}` };

    const ackedIds = frames
      .filter((f) => f.t === 'event' && (f.e as { kind?: string })?.kind === 'input_ack')
      .map((f) => (f.e as { id?: string }).id);
    const acked = ackedIds.includes(steerId);
    const result = finalResult(final);
    const behaviorChanged = result.toUpperCase().includes('BANANA');
    console.log(
      `[steering] input_ack for steer=${acked}; final=${!!final}; result="${result.slice(0, 80)}" behaviorChanged=${behaviorChanged}`,
    );
    return {
      pass: acked && !!final,
      detail: acked
        ? `steer consumed (input_ack ${steerId.slice(0, 8)}), turn completed${behaviorChanged ? '; behavior changed to BANANA' : ''}`
        : 'no input_ack for the steer id',
    };
  } finally {
    await cleanup(redis, turnId);
    redis.disconnect();
  }
}

if (require.main === module) {
  const sandbox = requireSandboxArg('steering.e2e.ts');
  run(sandbox)
    .then((r) => report('steering', r.pass, r.detail))
    .catch((e) => report('steering', false, String(e)));
}
