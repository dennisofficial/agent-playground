// REDIS RESTART-SURVIVAL SMOKE TEST (manual; real Docker + real Claude + real Redis). Proves the core
// claim: a turn's engine keeps running + writing to durable Redis while the HOST dies, and a FRESH host
// re-attaches from the saved cursor (active_turns.events_last_id) to receive the rest — no loss, no dup.
//   cd backend && pnpm env:inject -- node scripts/redis-restart-survival-smoke.mjs <atlas-sbx-thread-...>
import Redis from 'ioredis';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const SBX = process.argv[2];
const TOKEN = process.env.CLAUDE_OAUTH_TOKEN;
if (!SBX || !TOKEN) { console.error('need CLAUDE_OAUTH_TOKEN + sandbox arg'); process.exit(2); }

const redis = new Redis('redis://127.0.0.1:6380');
const turnId = randomUUID();
const k = (s) => `turn:${turnId}:${s}`;
const decode = (f) => { const i = f.indexOf('data'); return i < 0 ? null : JSON.parse(f[i + 1]); };

const spec = {
  turnId, engine: 'claude',
  task: 'Count slowly from 1 to 15. Output each number on its own line with a short factoid. Take your time.',
  cwd: '/workspace', writableRoots: [],
  systemPrompt: 'You are a verbose test assistant; produce a long multi-line streamed answer.',
  sandboxKey: `redis-survival-${turnId.slice(0, 8)}`,
  mode: 'review', richStream: true,
};

console.log(`[survival] turn ${turnId}`);
await redis.xadd(k('spec'), '*', 'data', JSON.stringify(spec));

// Kick the engine DETACHED — it keeps running independently of any host.
const child = spawn('docker', ['exec',
  '-e', 'ENGINE_TRANSPORT=redis', '-e', `TURN_ID=${turnId}`,
  '-e', 'REDIS_URL=redis://host.docker.internal:6380', '-e', `CLAUDE_OAUTH_TOKEN=${TOKEN}`,
  '-e', 'AGENT_HOME_ROOT=/atlas-home', '-w', '/workspace', SBX, 'atlas-engine-turn'],
  { stdio: ['ignore', 'ignore', 'inherit'], detached: true });
child.unref(); // the engine is NOT tied to this script — like the real detached exec

// ── HOST #1: tail a few events, then "crash" (stop reading), saving the cursor. ──────────────────
let cursor = '0-0';
let seen1 = 0;
const seenIds = new Set();
while (seen1 < 4) {
  const r = await redis.xread('BLOCK', 2000, 'STREAMS', k('events'), cursor).catch(() => null);
  if (!r) { if (seen1 === 0) continue; else break; }
  for (const [, entries] of r) for (const [id, f] of entries) {
    cursor = id; seenIds.add(id); seen1++;
    const fr = decode(f); if (fr?.t === 'final') { console.log('[survival] turn finished too fast to test mid-stream'); }
  }
}
console.log(`[survival] HOST #1 read ${seen1} event(s); CRASHING at cursor ${cursor}`);

// Simulate the host being down for a moment (the engine keeps streaming into Redis meanwhile).
await new Promise((r) => setTimeout(r, 1500));

// ── HOST #2 (fresh process): re-attach from the saved cursor — must get the REST incl. final. ────
let final, seen2 = 0, dup = 0;
const t0 = Date.now();
while (!final && Date.now() - t0 < 90000) {
  const r = await redis.xread('BLOCK', 2000, 'STREAMS', k('events'), cursor).catch(() => null);
  if (!r) continue;
  for (const [, entries] of r) for (const [id, f] of entries) {
    cursor = id; seen2++;
    if (seenIds.has(id)) dup++; // re-attach must NOT replay already-seen entries
    const fr = decode(f); if (fr?.t === 'final') final = fr;
  }
}
console.log(`[survival] HOST #2 re-attached, read ${seen2} further event(s), duplicates=${dup}`);
if (final) console.log('[survival] FINAL after re-attach:', JSON.stringify(final.r).slice(0, 160));

const pass = seen1 > 0 && final && seen2 > 0 && dup === 0;
console.log(pass
  ? '[survival] RESULT: PASS — engine survived the host "crash"; fresh host re-attached from cursor, no loss/dup'
  : '[survival] RESULT: FAIL');
await redis.del(k('spec'), k('events'));
redis.disconnect();
process.exit(pass ? 0 : 1);
