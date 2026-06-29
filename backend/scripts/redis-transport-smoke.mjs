// REDIS TRANSPORT SMOKE TEST (manual; real Docker + real Claude + real Redis). Proves the one-shot
// Redis transport end-to-end against a LIVE sandbox. Steps: regenerate the engine bundle, then
//   cd backend && pnpm env:inject -- node scripts/redis-transport-smoke.mjs <atlas-sbx-thread-...>
// Validated 2026-06-29: frames `event:session event:text event:result final`, result "pong" (Haiku).
//
// Real end-to-end smoke test of the ONE-SHOT Redis transport: XADD a spec, docker exec the bundled
// entrypoint in redis-mode inside a LIVE sandbox, then read the events stream back. Read-only review
// turn + a distinct sandboxKey so it can't touch the thread's worktree or engine session.
import Redis from 'ioredis';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const SBX = process.argv[2];
if (!SBX) { console.error('usage: node redis-smoke.mjs <sandbox-container>'); process.exit(2); }
const TOKEN = process.env.CLAUDE_OAUTH_TOKEN;
if (!TOKEN) { console.error('CLAUDE_OAUTH_TOKEN missing'); process.exit(2); }

const redis = new Redis('redis://127.0.0.1:6380');
const turnId = randomUUID();
const k = (s) => `turn:${turnId}:${s}`;

const spec = {
  turnId,
  engine: 'claude',
  task: 'Reply with exactly one word: pong. Do not call any tools.',
  cwd: '/workspace',
  writableRoots: [],
  systemPrompt: 'You are a terse test assistant.',
  sandboxKey: `redis-smoke-${turnId.slice(0, 8)}`,
  mode: 'review',
};

console.log(`[smoke] turn ${turnId} on ${SBX}`);
await redis.xadd(k('spec'), '*', 'data', JSON.stringify(spec));
console.log('[smoke] spec XADDed; kicking engine via docker exec (redis mode)…');

const t0 = Date.now();
try {
  execFileSync('docker', [
    'exec',
    '-e', 'ENGINE_TRANSPORT=redis',
    '-e', `TURN_ID=${turnId}`,
    '-e', 'REDIS_URL=redis://host.docker.internal:6380',
    '-e', `CLAUDE_OAUTH_TOKEN=${TOKEN}`,
    '-e', 'AGENT_HOME_ROOT=/atlas-home',
    '-w', '/workspace',
    SBX, 'atlas-engine-turn',
  ], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 120000 });
} catch (e) {
  console.log(`[smoke] exec returned non-zero (exit ${e.status}) — reading events anyway`);
}
console.log(`[smoke] exec done in ${Math.round((Date.now() - t0) / 1000)}s; reading ${k('events')}`);

const entries = await redis.xrange(k('events'), '-', '+');
let frames = entries.map(([, fields]) => {
  const i = fields.indexOf('data');
  try { return JSON.parse(fields[i + 1]); } catch { return null; }
}).filter(Boolean);

const kinds = frames.map((f) => f.t + (f.t === 'event' ? `:${f.e?.kind}` : ''));
console.log('[smoke] frame sequence:', kinds.join(' '));
const final = frames.find((f) => f.t === 'final');
const error = frames.find((f) => f.t === 'error');
if (error) console.log('[smoke] ERROR frame:', error.message?.slice(0, 300));
if (final) {
  console.log('[smoke] ✅ FINAL result:', JSON.stringify(final.r).slice(0, 300));
  console.log('[smoke] RESULT: PASS — one-shot turn ran end-to-end over Redis');
} else {
  console.log('[smoke] RESULT: FAIL — no final frame (events:', frames.length, ')');
}
// Clean up the test streams.
await redis.del(k('spec'), k('events'));
redis.disconnect();
process.exit(final ? 0 : 1);
