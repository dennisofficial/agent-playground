// TOOL BRIDGE — the bidirectional host tool-bridge round-trips over Redis end to end (ports
// `redis-toolbridge-smoke.mjs`): the engine registers proxy tools for `spec.toolBridgeTools`, calls them
// mid-turn (XADD `tool_request` on `turn:{T}:tools`), this script (mirroring `RedisEngineRunner.consumeTools`)
// answers on `turn:{T}:replies`, and the engine continues.
//
// NOTE (porting divergence): the old smoke used a synthetic `get_info` tool. The NEW engine's
// `makeProxyTool` (turn-runner.service.ts) requires a `TOOL_SHAPES` entry per bridged tool and THROWS on a
// missing one ("no TOOL_SHAPES entry for bridged tool 'get_info'"), so `get_info` no longer works — it was
// a test-only name. This exercises TWO real read-only host tools instead, proving more than one bridge
// SHAPE: `list_skills` routes through the GENERAL host bridge; `read_setup_script` routes through the
// dedicated WORKSPACE-PROFILE bridge (partitioned in turn-runner) — two distinct MCP servers, one turn.
import {
  newTurnId as _uid,
  cleanup,
  finalResult,
  frameKinds,
  kickEngine,
  makeSpec,
  newRedis,
  newTurnId,
  report,
  requireSandboxArg,
  startToolResponder,
  tailEvents,
  turnKeys,
  xadd,
  type ScenarioResult,
} from './lib/harness';

export async function run(sandbox: string): Promise<ScenarioResult> {
  const redis = newRedis();
  const turnId = newTurnId();
  const k = turnKeys(turnId);
  const secretSkills = `skills-secret-${_uid().slice(0, 6)}`;
  const secretSetup = `setup-secret-${_uid().slice(0, 6)}`;
  let responder: ReturnType<typeof startToolResponder> | undefined;
  try {
    const spec = makeSpec(turnId, {
      toolBridgeTools: ['list_skills', 'read_setup_script'],
      task:
        'You have two tools. First call the list_skills tool with empty arguments, then call the ' +
        'read_setup_script tool with empty arguments. Then reply with EXACTLY the two string values they ' +
        'returned, separated by a single space, and nothing else.',
      systemPrompt:
        'You are a terse test assistant. Use the provided tools, then report their outputs verbatim.',
    });
    console.log(`[bridge] turn ${turnId} on ${sandbox}; secrets=${secretSkills},${secretSetup}`);
    await xadd(redis, k.spec, spec);

    responder = startToolResponder(redis, turnId, {
      heartbeat: true,
      onRequest: (req) => {
        console.log(`[bridge] host got tool_request: ${req.name}(${JSON.stringify(req.args)})`);
        if (req.name === 'list_skills') return { result: secretSkills };
        if (req.name === 'read_setup_script') return { result: secretSetup };
        return { error: `unknown tool ${req.name}` };
      },
    });

    kickEngine(sandbox, turnId, { detached: true, quiet: true });
    const { frames, final, error } = await tailEvents(redis, turnId, { timeoutMs: 150_000 });
    responder.stop();
    await responder.done.catch(() => undefined);

    console.log(`[bridge] frames: ${frameKinds(frames)}`);
    console.log(`[bridge] tools the engine called: ${JSON.stringify(responder.called)}`);
    if (error)
      return { pass: false, detail: `error frame: ${String(error.message).slice(0, 200)}` };
    if (!final) return { pass: false, detail: 'no final frame' };

    const result = finalResult(final);
    console.log(`[bridge] final result: ${JSON.stringify(result).slice(0, 200)}`);
    const calledBoth =
      responder.called.includes('list_skills') && responder.called.includes('read_setup_script');
    const reportsBoth = result.includes(secretSkills) && result.includes(secretSetup);
    return {
      pass: calledBoth && reportsBoth,
      detail: calledBoth
        ? reportsBoth
          ? 'both host tools round-tripped (general + workspace-profile bridge); model reported both secrets'
          : `both tools called but result missing a secret: "${result.slice(0, 80)}"`
        : `engine did not call both tools: ${JSON.stringify(responder.called)}`,
    };
  } finally {
    responder?.stop();
    await cleanup(redis, turnId);
    redis.disconnect();
  }
}

if (require.main === module) {
  const sandbox = requireSandboxArg('tool-bridge.e2e.ts');
  run(sandbox)
    .then((r) => report('bridge', r.pass, r.detail))
    .catch((e) => report('bridge', false, String(e)));
}
