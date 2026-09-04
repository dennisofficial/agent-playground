import { EAccountOrigin, EAuthKind, EAuthProvider, toThreadId } from '@dltech/atlas-core'
import {
  AccountsService,
  EDevicePoll,
  memoryAccountStore,
  SystemClock,
} from '@dltech/atlas-harness'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const WIDE = { width: 150, height: 40 }

type Mounted = Awaited<ReturnType<typeof testRender>>

const TOKEN_RESPONSE = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  account: { email_address: 'signed-in@example.com' },
}

const accountsHolding = async (labels: readonly string[]): Promise<AccountsService> => {
  const clock = new SystemClock()
  const store = memoryAccountStore({ clock })

  for (const label of labels) {
    await store.add({
      provider: EAuthProvider.Anthropic,
      label,
      origin: EAccountOrigin.Login,
      secret: {
        kind: EAuthKind.Oauth,
        tokens: {
          accessToken: `token-${label}`,
          refreshToken: 'refresh',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      },
    })
  }

  return new AccountsService({
    accounts: store,
    clients: {
      [EAuthProvider.Anthropic]: {
        generatePkce: () => ({ verifier: 'v', challenge: 'c', state: 'state-1' }),
        authorizeUrl: () => 'https://claude.com/cai/oauth/authorize?code=true',
        exchange: async () => ({
          tokens: {
            accessToken: TOKEN_RESPONSE.access_token,
            refreshToken: TOKEN_RESPONSE.refresh_token,
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
          email: TOKEN_RESPONSE.account.email_address,
        }),
        refresh: async () => ({
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      },
      [EAuthProvider.OpenAI]: {
        startDeviceLogin: async () => ({
          deviceAuthId: 'da-1',
          userCode: 'ABCD-EFGH',
          verificationUrl: 'https://auth.openai.com/codex/device',
          intervalMs: 100,
          expiresInMs: 900_000,
        }),
        pollDeviceLogin: async () => ({
          status: EDevicePoll.Complete,
          login: {
            tokens: {
              accessToken: 'openai-access',
              refreshToken: 'openai-refresh',
              expiresAt: '2099-01-01T00:00:00.000Z',
              accountId: 'acct-123',
            },
            email: 'codex-user@example.com',
            subscription: 'plus',
          },
        }),
        refresh: async () => ({
          accessToken: 'openai-access-2',
          refreshToken: 'openai-refresh-2',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      },
    },
  })
}

const appWith = async (labels: readonly string[]): Promise<FakeApp> => {
  const app = fakeApp({
    model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
  })

  return { ...app, accounts: await accountsHolding(labels) }
}

async function opened(args: { app: FakeApp; notice?: string }): Promise<Mounted> {
  const setup = await testRender(
    <App
      app={args.app}
      opened={{ threadId: THREAD, events: [], turns: [], name: null, started: true }}
      credentialNotice={args.notice ?? null}
    />,
    WIDE,
  )
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

const openOverlay = async (setup: Mounted): Promise<void> => {
  setup.mockInput.pressKey('a', { ctrl: true })
  await setup.flush()
  await settle(150)
  await setup.flush()
}

describe('the accounts overlay', () => {
  it('opens on ctrl+a and lists what Atlas can answer with', async () => {
    const setup = await opened({ app: await appWith(['work@example.com', 'personal@example.com']) })

    try {
      await openOverlay(setup)

      const frame = setup.captureCharFrame()

      expect(frame).toContain('ACCOUNTS')
      expect(frame).toContain('work@example.com')
      expect(frame).toContain('personal@example.com')
    } finally {
      await teardown(setup)
    }
  })

  it('opens by itself, carrying what went wrong, when nothing can authenticate', async () => {
    const setup = await opened({
      app: await appWith([]),
      notice: 'Atlas could not authenticate.\n\nAtlas holds no accounts. Sign in with /auth.',
    })

    try {
      const frame = setup.captureCharFrame()

      expect(frame).toContain('ACCOUNTS')
      expect(frame).toContain('Atlas holds no accounts')
      expect(frame).toContain('Anthropic')
      expect(frame).toContain('not signed in')
    } finally {
      await teardown(setup)
    }
  })

  it('files an api key under the provider whose row is selected, not the first one', async () => {
    const setup = await opened({ app: await appWith([]) })

    try {
      await openOverlay(setup)
      setup.mockInput.pressArrow('down')
      await setup.flush()
      await settle(120)
      setup.mockInput.pressArrow('down')
      await setup.flush()
      await settle(120)
      setup.mockInput.pressKey('k')
      await setup.flush()
      await settle(150)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('Paste a OpenRouter api key')
      expect(frame).not.toContain('Paste a Anthropic api key')
    } finally {
      await teardown(setup)
    }
  })

  it('starts the key flow on ⏎ over a provider nothing has signed into', async () => {
    const setup = await opened({ app: await appWith([]) })

    try {
      await openOverlay(setup)
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(150)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('Paste a Anthropic api key')
    } finally {
      await teardown(setup)
    }
  })

  it('says a key is the way in rather than opening a browser flow that does not exist', async () => {
    const setup = await opened({ app: await appWith([]) })

    try {
      await openOverlay(setup)
      setup.mockInput.pressArrow('down')
      await setup.flush()
      await settle(120)
      setup.mockInput.pressArrow('down')
      await setup.flush()
      await settle(120)
      setup.mockInput.pressKey('n')
      await setup.flush()
      await settle(150)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('OpenRouter takes an api key')
    } finally {
      await teardown(setup)
    }
  })

  it('opens from /auth as well as the chord', async () => {
    const setup = await opened({ app: await appWith(['work@example.com']) })

    try {
      await setup.mockInput.typeText('/auth')
      await setup.flush()
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(200)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('ACCOUNTS')
    } finally {
      await teardown(setup)
    }
  })

  it('moves the mark to the account the operator chose', async () => {
    const app = await appWith(['work@example.com', 'personal@example.com'])
    const setup = await opened({ app })

    try {
      await openOverlay(setup)
      setup.mockInput.pressArrow('down')
      await setup.flush()
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(200)
      await setup.flush()

      const chosen = await app.accounts.activeFor(EAuthProvider.Anthropic)
      const accounts = await app.accounts.list()

      expect(accounts.find((account) => account.id === chosen)?.label).toBe('personal@example.com')
    } finally {
      await teardown(setup)
    }
  })

  it('removes the account under the cursor', async () => {
    const app = await appWith(['work@example.com', 'personal@example.com'])
    const setup = await opened({ app })

    try {
      await openOverlay(setup)
      setup.mockInput.pressKey('x')
      await setup.flush()
      await settle(200)
      await setup.flush()

      expect((await app.accounts.list()).map((account) => account.label)).toEqual([
        'personal@example.com',
      ])
      expect(setup.captureCharFrame()).not.toContain('work@example.com')
    } finally {
      await teardown(setup)
    }
  })

  it('shows the URL to open when a sign-in begins', async () => {
    const setup = await opened({ app: await appWith(['work@example.com']) })

    try {
      await openOverlay(setup)
      setup.mockInput.pressKey('n')
      await setup.flush()
      await settle(120)
      await setup.flush()

      const frame = setup.captureCharFrame()

      expect(frame).toContain('SIGN IN')
      expect(frame).toContain('claude.com/cai/oauth/auth')
    } finally {
      await teardown(setup)
    }
  })

  it('opens the authorize URL in the browser when a sign-in begins', async () => {
    const app = await appWith(['work@example.com'])
    const setup = await opened({ app })

    try {
      await openOverlay(setup)
      setup.mockInput.pressKey('n')
      await setup.flush()
      await settle(120)
      await setup.flush()

      expect(app.openedUrls).toEqual(['https://claude.com/cai/oauth/authorize?code=true'])
    } finally {
      await teardown(setup)
    }
  })

  it('takes a bracketed paste of the code and says who signed in', async () => {
    const setup = await opened({ app: await appWith([]) })

    try {
      await openOverlay(setup)
      setup.mockInput.pressKey('n')
      await setup.flush()
      await settle(120)

      await setup.mockInput.pasteBracketedText('code#state-1')
      await setup.flush()
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(200)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('signed-in@example.com')
    } finally {
      await teardown(setup)
    }
  })

  it('shows the device code for OpenAI and signs in once the poll completes', async () => {
    const app = await appWith([])
    const setup = await opened({ app })

    try {
      await openOverlay(setup)
      setup.mockInput.pressArrow('down')
      await setup.flush()
      await settle(120)
      setup.mockInput.pressKey('n')
      await setup.flush()
      await settle(200)
      await setup.flush()

      const prompting = setup.captureCharFrame()
      expect(prompting).toContain('ABCD-EFGH')
      expect(prompting).toContain('auth.openai.com/codex/device')
      expect(app.openedUrls).toEqual(['https://auth.openai.com/codex/device'])

      await settle(3500)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('codex-user@example.com')
      expect(await app.accounts.activeFor(EAuthProvider.OpenAI)).not.toBeUndefined()
    } finally {
      await teardown(setup)
    }
  })

  it('takes a pasted code and says who signed in', async () => {
    const setup = await opened({ app: await appWith([]) })

    try {
      await openOverlay(setup)
      setup.mockInput.pressKey('n')
      await setup.flush()
      await settle(120)

      await setup.mockInput.typeText('code#state-1')
      await setup.flush()
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(200)
      await setup.flush()

      const frame = setup.captureCharFrame()

      expect(frame).toContain('signed-in@example.com')
    } finally {
      await teardown(setup)
    }
  })
})
