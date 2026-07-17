export function detectLongRunningCommand(command: string): string | null {
  const cmd = command.trim();
  if (!cmd) return null;
  if (/\batlas-svc\b/.test(cmd)) return null;

  const smells: Array<[RegExp, string]> = [
    [/\bnohup\b/, 'nohup'],
    [/(^|[^&])&\s*$/, 'trailing & (backgrounded)'],
    [/\bdocker(-compose|\s+compose)\s+up\b/, 'docker compose up'],
    [/\bdocker\s+run\b(?=[^|&;]*\s(-d|--detach)\b)/, 'docker run -d'],
    [/\b(pnpm|npm|yarn|bun|npx)\b[^|&;]*\b(dev|serve|watch)\b/, 'dev/serve/watch script'],
    [/\b(pnpm|npm|yarn|bun)\s+start\b/, 'start script'],
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

export function renderSvcNudge(command: string): string {
  const shown = command.length > 120 ? `${command.slice(0, 117)}…` : command;
  return `[atlas-svc reminder] You just ran \`${shown}\` — ${SVC_NUDGE_TEXT}`;
}

export function svcNudgeShouldFire(last: number | null, now: number, delta: number): boolean {
  return last === null || now - last >= delta;
}
