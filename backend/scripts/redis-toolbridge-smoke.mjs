// REDIS TOOL-BRIDGE SMOKE TEST (manual; real Docker + real Claude + real Redis). Proves the
// bidirectional tool-bridge over Redis end-to-end: the engine calls a host tool over turn:{T}:tools,
// the host (this script, mirroring RedisEngineRunner.consumeTools) dispatches + replies over
// turn:{T}:replies, the engine continues. Run after regenerating the bundle:
//   cd backend && pnpm env:inject -- node scripts/redis-toolbridge-smoke.mjs <atlas-sbx-thread-...>
import Redis from 'ioredis';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const SBX = process.argv[2];
const TOKEN = process.env.CLAUDE_OAUTH_TOKEN;
if (!SBX || !TOKEN) { console.error('usage: CLAUDE_OAUTH_TOKEN must be set; arg = sandbox container'); process.exit(2); }

const redis = new Redis('redis://127.0.0.1:6380');
const turnId = randomUUID();
const k = (s) => `turn:${turnId}:${s}`;
const xadd = (stream, frame) => redis.xadd(stream, '*', 'data', JSON.stringify(frame));
const decode = (fields) => { const i = fields.indexOf('data'); return i < 0 ? null : JSON.parse(fields[i + 1]); };

const SECRET = 'redis-bridge-works-' + turnId.slice(0, 4);
const spec = {
  turnId, engine: 'claude',
  task: `Call the get_info tool with empty arguments. Then reply with EXACTLY the text it returns, nothing else.`,
  cwd: '/workspace', writableRoots: [],
  systemPrompt: 'You are a terse test assistant. Use the provided tool, then report its output verbatim.',
  sandboxKey: `redis-bridge-${turnId.slice(0, 8)}`,
  mode: 'review',
  toolBridgeTools: ['get_info'],
};

console.log(`[bridge] turn ${turnId} on ${SBX}; secret=${SECRET}`);
await xadd(k('spec'), spec);
await redis.xgroup('CREATE', k('tools'), 'host', '0', 'MKSTREAM').catch(() => {});

// Host: dispatch get_info → reply with SECRET (mirrors RedisEngineRunner.consumeTools).
let done = false;
const toolsLoop = (async () => {
  let toolCalled = false;
  while (!done) {
    const r = await redis.xreadgroup('GROUP', 'host', 'c1', 'COUNT', 10, 'BLOCK', 500, 'STREAMS', k('tools'), '>').catch(() => null);
    if (!r) continue;
    for (const [, entries] of r) for (const [id, f] of entries) {
      const req = decode(f);
      if (req?.t === 'tool_request') {
        toolCalled = true;
        console.log(`[bridge] host got tool_request: ${req.name}(${JSON.stringify(req.args)})`);
        const reply = req.name === 'get_info'
          ? { t: 'tool_response', id: req.id, result: SECRET }
          : { t: 'tool_error', id: req.id, message: 'unknown tool' };
        await xadd(k('replies'), reply);
      }
      await redis.xack(k('tools'), 'host', id);
    }
  }
  return toolCalled;
})();

// Kick the engine detached.
const child = spawn('docker', ['exec',
  '-e', 'ENGINE_TRANSPORT=redis', '-e', `TURN_ID=${turnId}`,
  '-e', 'REDIS_URL=redis://host.docker.internal:6380', '-e', `CLAUDE_OAUTH_TOKEN=${TOKEN}`,
  '-e', 'AGENT_HOME_ROOT=/atlas-home', '-w', '/workspace', SBX, 'atlas-engine-turn'],
  { stdio: ['ignore', 'inherit', 'inherit'] });

// Tail events for the final frame.
const t0 = Date.now();
let lastId = '0-0', final, error;
while (!final && !error && Date.now() - t0 < 120000) {
  const r = await redis.xread('BLOCK', 1000, 'STREAMS', k('events'), lastId).catch(() => null);
  if (!r) continue;
  for (const [, entries] of r) for (const [id, f] of entries) { lastId = id; const fr = decode(f); if (fr?.t === 'final') final = fr; if (fr?.t === 'error') error = fr; }
}
done = true;
const toolCalled = await toolsLoop;
child.kill('SIGTERM');

if (error) console.log('[bridge] ERROR:', error.message?.slice(0, 300));
console.log(`[bridge] tool called by engine: ${toolCalled}`);
if (final) console.log('[bridge] FINAL:', JSON.stringify(final.r).slice(0, 200));
const pass = toolCalled && final && JSON.stringify(final.r).includes(SECRET);
console.log(pass ? '[bridge] RESULT: PASS — bidirectional tool-bridge worked over Redis' : '[bridge] RESULT: FAIL');
await redis.del(k('spec'), k('events'), k('tools'), k('replies'));
redis.disconnect();
process.exit(pass ? 0 : 1);
