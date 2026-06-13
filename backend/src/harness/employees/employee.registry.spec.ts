import { describe, expect, it } from 'vitest';
import { EmployeeRegistry } from './employee.registry';
import type { EmployeeDefinition } from './employee.types';

/**
 * EmployeeRegistry.keywordHit — the cheap programmatic wake-from-dormancy check. keywordHit reads
 * only `bot.id` (for its per-bot regex cache) and `bot.keywords`, so it can be exercised on a fresh
 * registry without standing up discovery / onModuleInit.
 */
const reg = () => new EmployeeRegistry({} as never);
const bot = (id: string, keywords?: string[]) =>
  ({ id, keywords }) as unknown as EmployeeDefinition;

describe('EmployeeRegistry.keywordHit', () => {
  it('matches a lane keyword case-insensitively on word boundaries', () => {
    const r = reg();
    const james = bot('james', ['marketing', 'analytics', 'utm']);
    expect(r.keywordHit(james, 'can we talk Marketing strategy?')).toBe(true);
    expect(r.keywordHit(james, 'the ANALYTICS dashboard is down')).toBe(true);
    expect(r.keywordHit(james, 'add a UTM to that link')).toBe(true);
  });

  it('does not match a keyword embedded in a larger word', () => {
    const r = reg();
    const alex = bot('alex', ['api']);
    expect(r.keywordHit(alex, 'I saw a therapist')).toBe(false); // 'api' inside 'therapist'
    expect(r.keywordHit(alex, 'the api is down')).toBe(true);
  });

  it('returns false when the bot has no keywords', () => {
    const r = reg();
    expect(r.keywordHit(bot('nora', undefined), 'anything at all')).toBe(false);
    expect(r.keywordHit(bot('nora2', []), 'anything at all')).toBe(false);
  });

  it('escapes regex metacharacters in keywords (go-to-market matches literally)', () => {
    const r = reg();
    const james = bot('james2', ['go-to-market']);
    expect(r.keywordHit(james, 'what is the go-to-market plan?')).toBe(true);
    expect(r.keywordHit(james, 'go to market')).toBe(false); // hyphen is literal, not "any char"
  });
});
