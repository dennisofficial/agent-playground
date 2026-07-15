import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppServerClient } from './app-server-client.js';

// Vitest runs from the package root, so the fixture resolves off cwd (avoids import.meta, which this
// package's CommonJS-resolved TS config disallows).
const FAKE_SERVER = join(process.cwd(), 'test/fixtures/fake-app-server.mjs');

function makeClient(): AppServerClient {
  return new AppServerClient({
    codexHome: '/tmp/codex-sdk-test-home',
    // Point the spawn at the fake node script; a full override path means `args` is trusted verbatim
    // (no implicit `app-server` subcommand), which is exactly what pointing at a fixture needs.
    codexPathOverride: process.execPath,
    args: [FAKE_SERVER],
  });
}

describe('AppServerClient', () => {
  let client: AppServerClient;

  afterEach(async () => {
    await client.close();
  });

  it('round-trips a request and resolves with the server result', async () => {
    client = makeClient();
    const result = await client.request('initialize', { clientInfo: {}, capabilities: {} });
    expect(result).toMatchObject({ userAgent: 'fake-app-server/0' });
  });

  it('correlates concurrent overlapping requests by id', async () => {
    client = makeClient();
    // Fire both before either resolves; each must get its OWN matching result.
    const [init, thread] = await Promise.all([
      client.request('initialize', { clientInfo: {}, capabilities: {} }),
      client.request('thread/start', { cwd: '/tmp' }),
    ]);
    expect(init).toMatchObject({ userAgent: 'fake-app-server/0' });
    expect(thread).toMatchObject({ thread: { id: 'thr_test_1' } });
  });

  it('sends notifications without expecting a response', async () => {
    client = makeClient();
    expect(client.notify('initialized', {})).toBeUndefined();
    // The peer is still healthy for subsequent requests after a fire-and-forget notification.
    const result = await client.request('thread/start', { cwd: '/tmp' });
    expect(result).toMatchObject({ thread: { id: 'thr_test_1' } });
  });
});
