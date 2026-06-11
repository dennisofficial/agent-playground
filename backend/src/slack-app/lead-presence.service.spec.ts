import { LeadPresenceService } from './lead-presence.service';

/** A Slack WebClient error: the API error code rides at err.data.error. */
const slackErr = (code: string) =>
  Object.assign(new Error(code), { data: { ok: false, error: code } });

function makeFakes(opts: {
  leadUserId?: string | undefined;
  leadPuppet?: boolean;
  ready?: boolean;
}) {
  const puppet = {
    conversations: { join: vi.fn(async () => ({ ok: true })) },
  };
  const ears = {
    conversations: { invite: vi.fn(async () => ({ ok: true })) },
    chat: { postMessage: vi.fn(async () => ({ ok: true })) },
  };
  const employees = {
    teamLead: () => ({ id: 'sam', name: 'Sam', teamLead: true }),
  };
  const identities = {
    slackUserIdFor: vi.fn(async () => opts.leadUserId),
    clientFor: vi.fn(async () =>
      (opts.leadPuppet ?? true) ? puppet : undefined,
    ),
    botIdForSlackUser: vi.fn(async (_t: string, u: string) =>
      u === 'USAM' ? 'sam' : undefined,
    ),
  };
  const tenants = { clientFor: vi.fn(async () => ears) };
  const readiness = { isReady: vi.fn(() => opts.ready ?? true) };
  const svc = new LeadPresenceService(
    employees as never,
    identities as never,
    tenants as never,
    readiness as never,
  );
  const message = (overrides: Record<string, unknown> = {}) =>
    svc.observe(
      {
        type: 'message',
        user: 'U123',
        channel: 'C042',
        channel_type: 'channel',
        ...overrides,
      },
      'T1',
    );
  return { svc, puppet, ears, identities, readiness, message };
}

describe('LeadPresenceService', () => {
  it('public channel: the lead puppet joins itself, once — cached as member afterwards', async () => {
    const { puppet, ears, message } = makeFakes({ leadUserId: 'USAM' });
    await message();
    await message(); // second message hits the member cache
    expect(puppet.conversations.join).toHaveBeenCalledTimes(1);
    expect(puppet.conversations.join).toHaveBeenCalledWith({ channel: 'C042' });
    expect(ears.conversations.invite).not.toHaveBeenCalled();
    expect(ears.chat.postMessage).not.toHaveBeenCalled();
  });

  it('private channel: skips self-join, the ears app invites the lead', async () => {
    const { puppet, ears, message } = makeFakes({ leadUserId: 'USAM' });
    await message({ channel_type: 'group', channel: 'G99' });
    expect(puppet.conversations.join).not.toHaveBeenCalled();
    expect(ears.conversations.invite).toHaveBeenCalledWith({
      channel: 'G99',
      users: 'USAM',
    });
  });

  it('failed join falls through to invite; already_in_channel counts as member', async () => {
    const { puppet, ears, message } = makeFakes({ leadUserId: 'USAM' });
    puppet.conversations.join.mockRejectedValue(
      slackErr('method_not_supported_for_channel_type'),
    );
    ears.conversations.invite.mockRejectedValue(slackErr('already_in_channel'));
    await message();
    await message(); // member now — no further calls
    expect(puppet.conversations.join).toHaveBeenCalledTimes(1);
    expect(ears.conversations.invite).toHaveBeenCalledTimes(1);
    expect(ears.chat.postMessage).not.toHaveBeenCalled();
  });

  it('no lead puppet installed: nags exactly ONCE, as the Jarvis identity', async () => {
    const { ears, message } = makeFakes({
      leadUserId: undefined,
      leadPuppet: false,
    });
    await message();
    await message();
    expect(ears.conversations.invite).not.toHaveBeenCalled();
    expect(ears.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(ears.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C042',
        username: 'Jarvis',
        text: expect.stringContaining('Sam'),
      }),
    );
  });

  it('join + invite both failing (e.g. missing_scope) nags once, not per message', async () => {
    const { puppet, ears, message } = makeFakes({ leadUserId: 'USAM' });
    puppet.conversations.join.mockRejectedValue(slackErr('missing_scope'));
    ears.conversations.invite.mockRejectedValue(slackErr('missing_scope'));
    await message();
    await message(); // failed state is cached for the retry TTL — no second nag
    expect(puppet.conversations.join).toHaveBeenCalledTimes(1);
    expect(ears.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it("the lead's member_joined_channel marks membership and clears the nag state", async () => {
    const { puppet, ears, svc, message } = makeFakes({ leadUserId: 'USAM' });
    puppet.conversations.join.mockRejectedValue(slackErr('missing_scope'));
    ears.conversations.invite.mockRejectedValue(slackErr('missing_scope'));
    await message();
    expect(ears.chat.postMessage).toHaveBeenCalledTimes(1);
    await svc.observe(
      {
        type: 'member_joined_channel',
        user: 'USAM',
        channel: 'C042',
      },
      'T1',
    );
    await message(); // member cache hit — no new attempts, no re-nag
    expect(puppet.conversations.join).toHaveBeenCalledTimes(1);
    expect(ears.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('not-ready workspaces never get nagged (Jarvis owns onboarding)', async () => {
    const { ears, message } = makeFakes({
      leadUserId: undefined,
      ready: false,
    });
    await message();
    expect(ears.chat.postMessage).not.toHaveBeenCalled();
  });

  it('ignores DMs, bot echoes, and subtyped messages', async () => {
    const { puppet, ears, message } = makeFakes({ leadUserId: 'USAM' });
    await message({ channel_type: 'im' });
    await message({ channel_type: 'mpim' });
    await message({ bot_id: 'B1' });
    await message({ subtype: 'message_changed' });
    expect(puppet.conversations.join).not.toHaveBeenCalled();
    expect(ears.conversations.invite).not.toHaveBeenCalled();
    expect(ears.chat.postMessage).not.toHaveBeenCalled();
  });

  it('a burst of messages in one channel collapses into a single attempt', async () => {
    const { puppet, message } = makeFakes({ leadUserId: 'USAM' });
    await Promise.all([message(), message(), message()]);
    expect(puppet.conversations.join).toHaveBeenCalledTimes(1);
  });
});
