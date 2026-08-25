import { describe, expect, it } from 'vitest';
import { detectLongRunningCommand, svcNudgeShouldFire } from './engine-core';

describe('detectLongRunningCommand', () => {
  it.each([
    'pnpm dev',
    'pnpm --filter backend dev',
    'npm run dev',
    'yarn dev',
    'pnpm start',
    'pnpm serve',
    'pnpm run test:watch',
    'docker compose up',
    'docker-compose up',
    'docker compose up web',
    'docker run -d --name pg postgres',
    'next dev',
    'vite',
    'nodemon src/index.js',
    'ng serve',
    'rails server',
    'rails s',
    'flask run',
    'uvicorn app:app --reload',
    'python -m http.server 8000',
    'nohup ./run.sh',
    'pnpm build & ',
    'node server.js &',
  ])('nudges on %j', (cmd) => {
    expect(detectLongRunningCommand(cmd)).not.toBeNull();
  });

  it.each([
    'pnpm test',
    'pnpm build',
    'pnpm run build',
    'pnpm lint',
    'pnpm typecheck',
    'pnpm install',
    'pnpm i',
    'vite build',
    'git status',
    'ls -la',
    "sed -n '1,120p' file",
    'cat package.json',
    'echo hi && echo bye',
    'curl localhost:3000/health',
    'node scripts/seed.js',
    '',
  ])('does NOT nudge on %j', (cmd) => {
    expect(detectLongRunningCommand(cmd)).toBeNull();
  });

  it('never nudges a command already using atlas-svc', () => {
    expect(detectLongRunningCommand('atlas-svc run --name web -- pnpm dev')).toBeNull();
    expect(detectLongRunningCommand('atlas-svc run --name db -- docker compose up')).toBeNull();
  });
});

describe('svcNudgeShouldFire (token-delta throttle)', () => {
  const DELTA = 40_000;

  it('fires on the first match (last === null), whatever the occupancy', () => {
    expect(svcNudgeShouldFire(null, 0, DELTA)).toBe(true);
    expect(svcNudgeShouldFire(null, 123_456, DELTA)).toBe(true);
  });

  it('does NOT re-fire within the delta window', () => {
    const last = 100_000;
    expect(svcNudgeShouldFire(last, 100_000, DELTA)).toBe(false); // back-to-back, same occupancy
    expect(svcNudgeShouldFire(last, 139_999, DELTA)).toBe(false); // just under the window
  });

  it('fires again once the context has grown by at least the delta', () => {
    const last = 100_000;
    expect(svcNudgeShouldFire(last, 140_000, DELTA)).toBe(true);
    expect(svcNudgeShouldFire(last, 200_000, DELTA)).toBe(true);
  });

  it('models the 5-back-to-back-commands case: one nudge, not five', () => {
    let last: number | null = null;
    const occupancy = 100_000; // barely moves across a burst of quick Bash calls
    let fired = 0;
    for (let i = 0; i < 5; i++) {
      if (svcNudgeShouldFire(last, occupancy, DELTA)) {
        fired++;
        last = occupancy;
      }
    }
    expect(fired).toBe(1);
  });
});
