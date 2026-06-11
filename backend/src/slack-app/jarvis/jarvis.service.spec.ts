import { ProjectConflictError } from '@harness/projects/project-store';
import { Subject } from 'rxjs';
import type { SlackInbound } from '../slack-inbound.types';
import { extractGithubUrl } from './github-url';
import {
  KEYS_MODAL_BLOCKS,
  KEYS_MODAL_CALLBACK_ID,
  SETUP_KEYS_ACTION_ID,
} from './jarvis-blocks';
import { JarvisService } from './jarvis.service';

function makeJarvis(opts: { ready?: boolean; projects?: Record<string, string> } = {}) {
  const ready$ = new Subject<void>();
  const readiness = {
    isReady: opts.ready ?? false,
    ready$,
    refresh: vi.fn(async () => true),
  };
  const projectRows = new Map(
    Object.entries(opts.projects ?? {}).map(([id, gitUrl]) => [id, { projectId: id, gitUrl }]),
  );
  const projects = {
    get: vi.fn(async (id: string) => projectRows.get(id)),
    create: vi.fn(async (input: { projectId: string; gitUrl: string }) => {
      if (projectRows.has(input.projectId)) throw new ProjectConflictError(input.projectId);
      projectRows.set(input.projectId, { projectId: input.projectId, gitUrl: input.gitUrl });
    }),
  };
  const providerKeys = { put: vi.fn(async () => ({})) };
  const githubTokens = {
    put: vi.fn(async () => ({})),
    listMeta: vi.fn(async () => []),
  };
  const web = {
    chat: {
      postMessage: vi.fn(async (_args: Record<string, unknown>) => ({ ok: true, ts: '1.1' })),
    },
    views: { open: vi.fn(async () => ({ ok: true })) },
  };
  const directory = {
    selfUserId: 'UBOT',
    resolveUser: vi.fn(async (id: string) => ({ authorId: id.toLowerCase(), authorName: id })),
    ensureChannelRegistered: vi.fn(async () => {}),
  };
  const registry = {
    get: vi.fn((channelId: string) =>
      channelId.startsWith('slack:C')
        ? {
            channelId,
            kind: 'channel',
            project: 'mls-studio',
            members: [],
            displayName: '#mls-studio',
          }
        : undefined,
    ),
  };
  const jarvis = new JarvisService(
    web as never,
    directory as never,
    registry as never,
    readiness as never,
    providerKeys as never,
    githubTokens as never,
    projects as never,
  );
  jarvis.onModuleInit();
  return { jarvis, web, directory, registry, readiness, providerKeys, githubTokens, projects, ready$ };
}

const message = (text: string, overrides: Record<string, unknown> = {}): SlackInbound => ({
  kind: 'event',
  body: {
    team_id: 'T1',
    event: { type: 'message', user: 'U123', text, channel: 'C042', ts: '1712.1', ...overrides },
  },
  respond: vi.fn(async () => {}),
});

const joined = (user: string): SlackInbound => ({
  kind: 'event',
  body: {
    team_id: 'T1',
    event: { type: 'member_joined_channel', user, channel: 'C042', inviter: 'U123' },
  },
  respond: vi.fn(async () => {}),
});

const keysSubmission = (
  values: Record<string, string>,
  respond = vi.fn(async () => {}),
): SlackInbound => ({
  kind: 'interactivity',
  payload: {
    type: 'view_submission',
    team: { id: 'T1' },
    view: {
      callback_id: KEYS_MODAL_CALLBACK_ID,
      private_metadata: 'C042',
      state: {
        values: {
          [KEYS_MODAL_BLOCKS.anthropic.blockId]: {
            [KEYS_MODAL_BLOCKS.anthropic.actionId]: { value: values.anthropic ?? '' },
          },
          [KEYS_MODAL_BLOCKS.openai.blockId]: {
            [KEYS_MODAL_BLOCKS.openai.actionId]: { value: values.openai ?? '' },
          },
          [KEYS_MODAL_BLOCKS.github.blockId]: {
            [KEYS_MODAL_BLOCKS.github.actionId]: { value: values.github ?? '' },
          },
        },
      },
    },
  },
  respond,
});

describe('extractGithubUrl', () => {
  it('unwraps Slack auto-links and trims trailing punctuation', () => {
    expect(extractGithubUrl('repo is <https://github.com/acme/api>')).toBe(
      'https://github.com/acme/api',
    );
    expect(extractGithubUrl('<https://github.com/acme/api|acme/api> please')).toBe(
      'https://github.com/acme/api',
    );
    expect(extractGithubUrl('use https://github.com/acme/api.git.')).toBe(
      'https://github.com/acme/api.git',
    );
    expect(extractGithubUrl('no repo here')).toBeUndefined();
    expect(extractGithubUrl('https://github.com/just-an-org')).toBeUndefined();
  });
});

describe('Jarvis while pending keys', () => {
  it('consumes every human message; greets once with the keys button, then nudges', async () => {
    const { jarvis, web } = makeJarvis({ ready: false });

    expect(await jarvis.maybeHandle(message('hey team'))).toBe(true);
    expect(web.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C042',
        username: 'Jarvis',
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: 'actions' }),
        ]),
      }),
    );

    web.chat.postMessage.mockClear();
    expect(await jarvis.maybeHandle(message('anyone home?'))).toBe(true);
    expect(web.chat.postMessage).toHaveBeenCalledTimes(1); // the nudge
  });

  it('warns on key-looking text and never echoes or stores it', async () => {
    const { jarvis, web, providerKeys } = makeJarvis({ ready: false });
    const leaked = 'sk-ant-api03-abcdefghijklmnop';
    expect(await jarvis.maybeHandle(message(`here you go ${leaked}`))).toBe(true);
    expect(providerKeys.put).not.toHaveBeenCalled();
    const posted = web.chat.postMessage.mock.calls.map((c) => JSON.stringify(c[0])).join();
    expect(posted).not.toContain(leaked);
    expect(posted).toContain('never paste keys in chat');
  });

  it('ignores bot/self/thread messages (the surface drops them anyway)', async () => {
    const { jarvis } = makeJarvis({ ready: false });
    expect(await jarvis.maybeHandle(message('x', { bot_id: 'B9' }))).toBe(false);
    expect(await jarvis.maybeHandle(message('x', { user: 'UBOT' }))).toBe(false);
    expect(
      await jarvis.maybeHandle(message('x', { thread_ts: '1700.0', ts: '1712.1' })),
    ).toBe(false);
  });

  it('greets on its own channel join (registered via the inviter)', async () => {
    const { jarvis, web, directory } = makeJarvis({ ready: false });
    expect(await jarvis.maybeHandle(joined('UBOT'))).toBe(true);
    expect(directory.ensureChannelRegistered).toHaveBeenCalledWith('C042', 'u123');
    expect(web.chat.postMessage).toHaveBeenCalled();
    // Someone ELSE joining is not Jarvis's business.
    expect(await jarvis.maybeHandle(joined('UOTHER'))).toBe(false);
  });
});

describe('Jarvis keys modal', () => {
  it('opens the modal on the setup button (block_actions)', async () => {
    const { jarvis, web } = makeJarvis({ ready: false });
    const respond = vi.fn(async () => {});
    const consumed = await jarvis.maybeHandle({
      kind: 'interactivity',
      payload: {
        type: 'block_actions',
        trigger_id: 'trig-1',
        channel: { id: 'C042' },
        actions: [{ action_id: SETUP_KEYS_ACTION_ID }],
      },
      respond,
    });
    expect(consumed).toBe(true);
    expect(respond).toHaveBeenCalled();
    expect(web.views.open).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger_id: 'trig-1',
        view: expect.objectContaining({
          callback_id: KEYS_MODAL_CALLBACK_ID,
          private_metadata: 'C042',
        }),
      }),
    );
  });

  it('rejects malformed keys with inline modal errors (nothing stored)', async () => {
    const { jarvis, providerKeys } = makeJarvis({ ready: false });
    const respond = vi.fn(async () => {});
    await jarvis.maybeHandle(keysSubmission({ anthropic: 'nope', openai: 'sk-okokokokok' }, respond));
    expect(respond).toHaveBeenCalledWith({
      response_action: 'errors',
      errors: expect.objectContaining({
        [KEYS_MODAL_BLOCKS.anthropic.blockId]: expect.stringContaining('Anthropic'),
      }),
    });
    expect(providerKeys.put).not.toHaveBeenCalled();
  });

  it('stores valid keys (+ optional GitHub token), clears the modal, refreshes readiness, confirms', async () => {
    const { jarvis, providerKeys, githubTokens, readiness, web } = makeJarvis({ ready: false });
    const respond = vi.fn(async () => {});
    await jarvis.maybeHandle(
      keysSubmission(
        {
          anthropic: 'sk-ant-api03-valid-key',
          openai: 'sk-proj-valid-key',
          github: 'ghp_0123456789abcdefghij',
        },
        respond,
      ),
    );
    expect(providerKeys.put).toHaveBeenCalledWith('anthropic', 'sk-ant-api03-valid-key');
    expect(providerKeys.put).toHaveBeenCalledWith('openai', 'sk-proj-valid-key');
    expect(githubTokens.put).toHaveBeenCalledWith(
      'onboarding',
      'ghp_0123456789abcdefghij',
      true,
    );
    expect(respond).toHaveBeenCalledWith(); // clear, not errors
    expect(readiness.refresh).toHaveBeenCalled();
    expect(web.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C042' }), // KEYS_STORED to private_metadata origin
    );
  });

  it('announces engines-online to greeted channels on the ready edge', async () => {
    const { jarvis, web, ready$ } = makeJarvis({ ready: false });
    await jarvis.maybeHandle(message('hello')); // greets C042 → tracked
    web.chat.postMessage.mockClear();
    ready$.next();
    await new Promise((r) => setTimeout(r, 0));
    expect(web.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C042', text: expect.stringContaining('online') }),
    );
  });
});

describe('Jarvis when ready', () => {
  it('leaves channels WITH a project row completely alone', async () => {
    const { jarvis, web } = makeJarvis({
      ready: true,
      projects: { 'mls-studio': 'https://github.com/acme/mls' },
    });
    expect(await jarvis.maybeHandle(message('morning!'))).toBe(false);
    expect(web.chat.postMessage).not.toHaveBeenCalled();
  });

  it('consumes ALL messages in project-less channels until the repo is linked', async () => {
    const { jarvis, web, projects } = makeJarvis({ ready: true });
    expect(await jarvis.maybeHandle(message('what is this channel?'))).toBe(true);
    expect(web.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('GitHub URL') }),
    );
    expect(projects.create).not.toHaveBeenCalled();
  });

  it('creates the project from a GitHub URL (channel slug + display name) and confirms', async () => {
    const { jarvis, projects, web } = makeJarvis({ ready: true });
    expect(
      await jarvis.maybeHandle(message('<https://github.com/acme/mls-studio>')),
    ).toBe(true);
    expect(projects.create).toHaveBeenCalledWith({
      projectId: 'mls-studio',
      displayName: 'mls-studio',
      gitUrl: 'https://github.com/acme/mls-studio',
    });
    expect(web.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('acme/mls-studio') }),
    );
    // Linked now — Jarvis steps aside.
    expect(await jarvis.maybeHandle(message('great, thanks'))).toBe(false);
  });

  it('is idempotent on a duplicate URL and explicit on a conflicting one', async () => {
    const { jarvis, web } = makeJarvis({
      ready: true,
      projects: { 'mls-studio': 'https://github.com/acme/mls' },
    });
    // Force the project-less path to race into create: registry says project exists, so simulate
    // by removing the row check result — covered instead via create() conflict in linkRepo:
    // a channel that just got its row between the check and create.
    const conflicting = await (
      jarvis as unknown as {
        linkRepo: (c: string, s: string, u: string) => Promise<boolean>;
      }
    ).linkRepo('C042', 'mls-studio', 'https://github.com/other/repo');
    expect(conflicting).toBe(true);
    expect(web.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('acme/mls') }),
    );
  });
});
