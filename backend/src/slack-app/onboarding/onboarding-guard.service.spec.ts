import { Subject } from 'rxjs';
import { OnboardingGuardService } from './onboarding-guard.service';
import type { SlackInbound } from '../slack-inbound.types';

/**
 * The slimmed keyless guard (the voiceless remainder of the old concierge): it consumes human messages
 * ONLY while a workspace is keyless, surfaces the keys modal, and — once ready — hands the new-channel
 * welcome to Atlas (a gate-bypassed seed) instead of greeting itself. Project-less channels are NOT its
 * business anymore (Atlas drives that onboarding).
 */

const SELF = 'U-APP';

function makeGuard(opts: { ready: boolean; project?: string; hasRow?: boolean }) {
  const posted: Array<Record<string, unknown>> = [];
  const opened: unknown[] = [];
  const web = {
    chat: {
      postMessage: vi.fn((m: Record<string, unknown>) => {
        posted.push(m);
        return Promise.resolve({ ts: '1' });
      }),
    },
    views: { open: vi.fn((v: unknown) => (opened.push(v), Promise.resolve())) },
  };
  const ready$ = new Subject<string>();
  const seeds: Array<{ bot: string; channel: string; prompt: string }> = [];
  const guard = new OnboardingGuardService(
    { clientFor: vi.fn(() => Promise.resolve(web)) } as never,
    {
      selfUserIdFor: vi.fn(() => Promise.resolve(SELF)),
      resolveUser: vi.fn(() => Promise.resolve({ authorId: 'dennis' })),
      ensureChannelRegistered: vi.fn(() => Promise.resolve()),
    } as never,
    {
      get: vi.fn(() => ({
        displayName: '#proj',
        project: opts.project ?? 'proj',
      })),
    } as never,
    {
      isReady: vi.fn(() => opts.ready),
      refresh: vi.fn(() => Promise.resolve()),
      ready$,
    } as never,
    { put: vi.fn(() => Promise.resolve()) } as never,
    {
      listMeta: vi.fn(() => Promise.resolve([])),
      put: vi.fn(() => Promise.resolve()),
    } as never,
    { get: vi.fn(() => Promise.resolve(opts.hasRow ? {} : undefined)) } as never,
    {
      injectSeed: vi.fn((bot: string, channel: string, prompt: string) =>
        seeds.push({ bot, channel, prompt }),
      ),
    } as never,
    { teamLead: vi.fn(() => ({ id: 'atlas', name: 'Atlas' })) } as never,
  );
  return { guard, web, posted, opened, seeds, ready$ };
}

const msg = (text = 'hello'): SlackInbound => ({
  kind: 'event',
  body: { team_id: 'T1', event: { type: 'message', user: 'U1', channel: 'C1', ts: '1', text } },
  respond: vi.fn(() => Promise.resolve()),
});

const joined = (): SlackInbound => ({
  kind: 'event',
  body: {
    team_id: 'T1',
    event: { type: 'member_joined_channel', user: SELF, channel: 'C1', inviter: 'U2' },
  },
  respond: vi.fn(() => Promise.resolve()),
});

describe('OnboardingGuardService', () => {
  it('keyless: consumes a human message and surfaces the keys prompt', async () => {
    const { guard, posted } = makeGuard({ ready: false });
    expect(await guard.maybeHandle(msg())).toBe(true);
    expect(posted[0].blocks).toBeTruthy(); // the setup-button blocks
  });

  it('keyless: warns on a key pasted in chat (and does not store it)', async () => {
    const { guard, posted } = makeGuard({ ready: false });
    expect(await guard.maybeHandle(msg('my key is sk-ant-abcdefghijk'))).toBe(true);
    expect(String(posted[0].text)).toMatch(/never paste keys/i);
  });

  it('ready: does NOT consume a human message — it flows to the conductor', async () => {
    const { guard, posted } = makeGuard({ ready: true });
    expect(await guard.maybeHandle(msg())).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it('join while ready: registers + hands the welcome to Atlas (no scripted greeting)', async () => {
    const { guard, posted, seeds } = makeGuard({ ready: true, hasRow: false });
    expect(await guard.maybeHandle(joined())).toBe(true);
    expect(posted).toHaveLength(0); // Atlas speaks, not the guard
    expect(seeds).toHaveLength(1);
    expect(seeds[0].bot).toBe('atlas');
    expect(seeds[0].channel).toBe('slack:T1:C1');
    expect(seeds[0].prompt).toMatch(/Channel onboarding/);
    expect(seeds[0].prompt).toMatch(/onboard one/i); // no repo linked → offer to onboard
  });

  it('join while keyless: prompts for keys, no Atlas seed (Atlas can’t run keyless)', async () => {
    const { guard, posted, seeds } = makeGuard({ ready: false });
    expect(await guard.maybeHandle(joined())).toBe(true);
    expect(posted[0].blocks).toBeTruthy();
    expect(seeds).toHaveLength(0);
  });

  it('keys land: greeted channels get the Atlas welcome seed', async () => {
    const { guard, seeds, ready$ } = makeGuard({ ready: false });
    guard.onModuleInit();
    await guard.maybeHandle(joined()); // greeted while pending
    ready$.next('T1');
    await new Promise((r) => setTimeout(r, 0));
    expect(seeds.some((s) => s.bot === 'atlas')).toBe(true);
    guard.onApplicationShutdown();
  });
});
