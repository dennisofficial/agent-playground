/**
 * prompt-kit / jit — the atlas-svc long-running-command nudge (content for the `svc-nudge` JIT rule).
 *
 * Relocated verbatim out of `engine/engine-core.ts` so the trigger matcher + payload live beside the rest of the
 * rule catalog (the hub owns CONTENT; the engine's `PostToolUse` hook keeps the DELIVERY wiring and re-exports
 * these for its own callers/specs). Byte-identical to the shipped text — guarded by the `svc-nudge-text` golden
 * snapshot and the `engine-core.svc-nudge` behavior spec.
 */

/**
 * Does this Bash command look like a long-running SERVICE that should run under the `atlas-svc` supervisor (dev
 * server / `docker compose up` / watcher / bare-backgrounded), rather than a one-shot the model should just run
 * directly? Returns a short label for the matched smell, or null.
 *
 * Precision is load-bearing: a false positive tells Atlas to wrap a one-shot like `pnpm test` in atlas-svc,
 * which is WRONG advice. So we match a curated allowlist of long-running smells and bias toward under-matching —
 * the token-delta throttle on the rule makes a rare miss cheap. A command already using atlas-svc is skipped
 * outright (it's already doing the right thing).
 */
export function detectLongRunningCommand(command: string): string | null {
  const cmd = command.trim();
  if (!cmd) return null;
  if (/\batlas-svc\b/.test(cmd)) return null;

  const smells: Array<[RegExp, string]> = [
    // Explicit backgrounding markers.
    [/\bnohup\b/, 'nohup'],
    [/(^|[^&])&\s*$/, 'trailing & (backgrounded)'],
    // Docker long-running.
    [/\bdocker(-compose|\s+compose)\s+up\b/, 'docker compose up'],
    [/\bdocker\s+run\b(?=[^|&;]*\s(-d|--detach)\b)/, 'docker run -d'],
    // Package-runner dev/serve/watch scripts (NOT test/build/lint/install — those are one-shots).
    [
      /\b(pnpm|npm|yarn|bun|npx)\b[^|&;]*\b(dev|serve|watch)\b/,
      'dev/serve/watch script',
    ],
    [/\b(pnpm|npm|yarn|bun)\s+start\b/, 'start script'],
    // Bare dev servers / watchers.
    [/\bnext\s+dev\b/, 'next dev'],
    [/\bvite\b(?!\s+build)/, 'vite'],
    [/\bnodemon\b/, 'nodemon'],
    [/\bwebpack(-dev-server)?\s+serve\b/, 'webpack serve'],
    [/\bng\s+serve\b/, 'ng serve'],
    [/\brails\s+s(erver)?\b/, 'rails server'],
    [/\bflask\s+run\b/, 'flask run'],
    [/\b(uvicorn|gunicorn|daphne|hypercorn)\b/, 'python app server'],
    [/\bpython[0-9.]*\s+-m\s+http\.server\b/, 'python http.server'],
  ];
  for (const [re, label] of smells) if (re.test(cmd)) return label;
  return null;
}

export const SVC_NUDGE_TEXT =
  'this looks like a long-running process. If it is a dev server / `docker compose up` / watcher, do NOT ' +
  "run it bare — start it under the supervisor so it survives the turn and shows in the operator's SERVICES " +
  'sidebar with live logs: `atlas-svc run --name <id> -- <cmd>` (then `atlas-svc logs -f <id>`, `atlas-svc ' +
  'ps`, `atlas-svc stop <id>`). Anything started with a bare `&`/nohup/`-d` is invisible to the operator and ' +
  'gets reaped between turns. (One-off commands like `pnpm test`/`build` are fine to run directly with Bash.)';

/** The atlas-svc nudge appended to a matching Bash tool result via PostToolUse `additionalContext`. */
export function renderSvcNudge(command: string): string {
  const shown = command.length > 120 ? `${command.slice(0, 117)}…` : command;
  return `[atlas-svc reminder] You just ran \`${shown}\` — ${SVC_NUDGE_TEXT}`;
}

/**
 * Throttle predicate for the atlas-svc nudge: fire on the FIRST match (`last === null`), then only once the
 * context has grown by at least `delta` tokens since the last nudge. Keeps back-to-back matching commands from
 * spamming the reminder. Pure — the caller latches `last` on a true result.
 */
export function svcNudgeShouldFire(
  last: number | null,
  now: number,
  delta: number,
): boolean {
  return last === null || now - last >= delta;
}
