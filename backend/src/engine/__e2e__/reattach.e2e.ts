// REATTACH — the durable-reattach / restart-survival property (ports `redis-restart-survival-smoke.mjs`).
// A DETACHED engine keeps writing to durable Redis while the "host" dies; a FRESH reader re-attaches from
// the saved cursor and receives the REST of the stream — no loss, no duplication. Simulated with two
// independent read loops in one process: HOST #1 reads a few events then "crashes" (stops, saving its
// cursor); after a gap, HOST #2 resumes from that cursor and must reach `final` with zero replays.
import Redis from 'ioredis';
import {
  cleanup,
  decode,
  kickEngine,
  makeSpec,
  newRedis,
  newTurnId,
  report,
  requireSandboxArg,
  turnKeys,
  xadd,
  type ScenarioResult,
} from './lib/harness';

async function readUntil(
  redis: Redis,
  stream: string,
  cursor: string,
  stop: (seen: number, isFinal: boolean) => boolean,
  timeoutMs: number,
): Promise<{ cursor: string; ids: string[]; final: boolean }> {
  const ids: string[] = [];
  let final = false;
  let cur = cursor;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = (await redis.xread('BLOCK', 2000, 'STREAMS', stream, cur).catch(() => null)) as Array<
      [string, Array<[string, string[]]>]
    > | null;
    if (!r) {
      if (ids.length === 0) continue;
      if (stop(ids.length, final)) break;
      continue;
    }
    for (const [, entries] of r) {
      for (const [id, f] of entries) {
        cur = id;
        ids.push(id);
        if (decode(f)?.t === 'final') final = true;
      }
    }
    if (stop(ids.length, final)) break;
  }
  return { cursor: cur, ids, final };
}

export async function run(sandbox: string): Promise<ScenarioResult> {
  const redis = newRedis();
  const turnId = newTurnId();
  const k = turnKeys(turnId);
  try {
    const spec = makeSpec(turnId, {
      richStream: true,
      task: 'Count slowly from 1 to 15. Output each number on its own line with a short factoid. Take your time.',
      systemPrompt: 'You are a verbose test assistant; produce a long multi-line streamed answer.',
    });
    console.log(`[reattach] turn ${turnId} on ${sandbox}`);
    await xadd(redis, k.spec, spec);
    // Detached — the engine is NOT tied to this script (like the real detached exec); it keeps streaming
    // into Redis even while "host #1" is down.
    kickEngine(sandbox, turnId, { detached: true, quiet: true });

    // HOST #1: read a handful of events, then "crash" — stop reading, saving the cursor.
    const h1 = await readUntil(redis, k.events, '0-0', (seen) => seen >= 4, 90_000);
    const seen1 = new Set(h1.ids);
    console.log(
      `[reattach] HOST #1 read ${h1.ids.length} event(s); CRASHING at cursor ${h1.cursor}`,
    );
    if (h1.ids.length === 0) return { pass: false, detail: 'HOST #1 saw no events' };
    if (h1.final) {
      // Turn finished before we could split the stream — inconclusive for the mid-stream reattach claim.
      return {
        pass: false,
        detail: 'turn finished too fast to test mid-stream reattach (rerun)',
      };
    }

    // The engine keeps streaming into Redis while the host is "down".
    await new Promise((r) => setTimeout(r, 1500));

    // HOST #2 (fresh reader): resume from the saved cursor — must get the REST, including `final`, with no dup.
    const h2 = await readUntil(redis, k.events, h1.cursor, (_s, isFinal) => isFinal, 90_000);
    const dup = h2.ids.filter((id) => seen1.has(id)).length;
    console.log(
      `[reattach] HOST #2 re-attached, read ${h2.ids.length} further event(s), duplicates=${dup}, final=${h2.final}`,
    );
    const pass = h1.ids.length > 0 && h2.final && h2.ids.length > 0 && dup === 0;
    return {
      pass,
      detail: pass
        ? `no loss/dup: host#1=${h1.ids.length} host#2=${h2.ids.length} dup=0, reached final`
        : `reattach imperfect: host#2 final=${h2.final} dup=${dup} further=${h2.ids.length}`,
    };
  } finally {
    await cleanup(redis, turnId);
    redis.disconnect();
  }
}

if (require.main === module) {
  const sandbox = requireSandboxArg('reattach.e2e.ts');
  run(sandbox)
    .then((r) => report('reattach', r.pass, r.detail))
    .catch((e) => report('reattach', false, String(e)));
}
