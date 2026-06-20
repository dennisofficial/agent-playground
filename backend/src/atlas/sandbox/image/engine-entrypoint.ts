/**
 * The in-container engine entrypoint (D1). Bundled by esbuild into `engine-entrypoint.mjs`, baked into
 * the sandbox image, and invoked by the host's `DockerEngineRunner` via `docker exec atlas-engine-turn`.
 *
 * Protocol (so a turn runs IDENTICALLY here and on the host):
 *   - stdin: one JSON `TurnSpec` (a serialized `RunEngineArgs` minus the host-only callbacks).
 *   - stdout: NDJSON frames — `{t:'event', e:EngineEvent}` per progress event, then a single
 *     `{t:'final', r:EngineRunResult}` (or `{t:'error', message}` on failure).
 *   - stderr: diagnostics only (kept off stdout so the NDJSON stays parseable).
 *
 * It reuses the SAME {@link EngineCore} as the host runner (esbuild bundles it in), constructing it from
 * the exec env (ANTHROPIC_API_KEY / ATLAS_ENGINE_AUTH_MODE / models / ATLAS_AGENT_HOME_ROOT — the host
 * passes secrets as exec env, never baked into the image). The engine SDKs are external (installed in
 * the image) and dynamically imported here.
 */
import { EngineCore, type EngineCoreConfig } from '../../engine/engine-core';
import type { EngineEvent, EngineRunResult, RunEngineArgs } from '../../engine/engine.types';

/** The serialized turn — everything `RunEngineArgs` carries except host-only, non-serializable bits. */
type TurnSpec = Omit<RunEngineArgs, 'onEvent' | 'signal' | 'target'>;

function emit(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) throw new Error('engine-entrypoint: empty turn spec on stdin');
  const spec = JSON.parse(raw) as TurnSpec;

  const claudeSdk = await import('@anthropic-ai/claude-agent-sdk');
  const codexSdk = await import('@openai/codex-sdk');

  const cfg: EngineCoreConfig = {
    homeRoot: process.env.ATLAS_AGENT_HOME_ROOT ?? process.env.AGENT_HOME_ROOT,
    authMode: process.env.ATLAS_ENGINE_AUTH_MODE as EngineCoreConfig['authMode'],
    claudeOauthToken: process.env.ATLAS_CLAUDE_OAUTH_TOKEN,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    workerModel: process.env.ATLAS_WORKER_MODEL ?? process.env.WORKER_MODEL,
    codexModel: process.env.ATLAS_CODEX_MODEL ?? process.env.CODEX_MODEL,
  };

  const core = new EngineCore(claudeSdk, codexSdk, cfg, {
    warn: (m) => process.stderr.write(`[engine-core] ${m}\n`),
  });

  const result: EngineRunResult = await core.run({
    ...spec,
    onEvent: (e: EngineEvent) => emit({ t: 'event', e }),
  });
  emit({ t: 'final', r: result });
}

main().catch((err: unknown) => {
  const e = err as { isAuthError?: boolean; sessionId?: string; stack?: string; message?: string };
  // Auth (401) errors carry the live session id so the host can PAUSE + resume this same session.
  emit({
    t: 'error',
    message: err instanceof Error ? (err.stack ?? err.message) : String(err),
    ...(e?.isAuthError ? { auth: true } : {}),
    ...(typeof e?.sessionId === 'string' ? { sessionId: e.sessionId } : {}),
  });
  process.exitCode = 1;
});
