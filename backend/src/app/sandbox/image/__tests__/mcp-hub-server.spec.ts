import { describe, expect, it } from 'vitest';
import type { ResolvedMcpServer } from '@shared/engine/engine.types';
import { parseHubConfig, serverKey } from '../mcp-hub-config';
import {
  buildStdioSpawn,
  decodeRoute,
  diffServers,
  findSetpriv,
  validServer,
} from '../mcp-hub-server';

const SPAWN = {
  uid: 501,
  gid: 20,
  cwd: '/workspace',
  home: '/home/atlas',
  baseEnv: { PATH: '/usr/bin' },
};

describe('buildStdioSpawn', () => {
  const spec: ResolvedMcpServer = {
    name: 'fs',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@fs/mcp'],
    env: { TOKEN: 't' },
  };

  it('wraps in setpriv with the host uid/gid when setpriv is available', () => {
    const out = buildStdioSpawn(spec, SPAWN, '/usr/bin/setpriv');
    expect(out.command).toBe('/usr/bin/setpriv');
    expect(out.args).toEqual([
      '--reuid',
      '501',
      '--regid',
      '20',
      '--clear-groups',
      '--',
      'npx',
      '-y',
      '@fs/mcp',
    ]);
    expect(out.cwd).toBe('/workspace');
    // base env + HOME + the server's own env (server wins).
    expect(out.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/atlas',
      TOKEN: 't',
    });
  });

  it('degrades to a direct spawn (no privilege drop) when setpriv is absent', () => {
    const out = buildStdioSpawn(spec, SPAWN, undefined);
    expect(out.command).toBe('npx');
    expect(out.args).toEqual(['-y', '@fs/mcp']);
  });

  it('degrades to a direct spawn when no uid/gid was supplied (even with setpriv)', () => {
    const out = buildStdioSpawn(
      spec,
      { cwd: '/workspace', home: '/home/atlas', baseEnv: {} },
      '/usr/bin/setpriv',
    );
    expect(out.command).toBe('npx');
  });
});

describe('findSetpriv', () => {
  it('returns the first existing path, else undefined', () => {
    expect(findSetpriv((p) => p === '/bin/setpriv')).toBe('/bin/setpriv');
    expect(findSetpriv(() => false)).toBeUndefined();
  });
});

describe('decodeRoute', () => {
  it('extracts + decodes the server name from a URL path', () => {
    expect(decodeRoute('/deepwiki')).toBe('deepwiki');
    expect(decodeRoute('/deepwiki?x=1')).toBe('deepwiki');
    expect(decodeRoute('/my%20server')).toBe('my server');
    expect(decodeRoute('/')).toBeNull();
    expect(decodeRoute(undefined)).toBeNull();
  });
});

describe('validServer', () => {
  it('requires a name + a usable endpoint per transport', () => {
    expect(
      validServer({ name: 'a', transport: 'http', url: 'https://x' }),
    ).toBe(true);
    expect(validServer({ name: 'a', transport: 'stdio', command: 'x' })).toBe(
      true,
    );
    expect(validServer({ name: 'a', transport: 'http' })).toBe(false);
    expect(validServer({ name: 'a', transport: 'stdio' })).toBe(false);
    expect(validServer({ name: '', transport: 'http', url: 'https://x' })).toBe(
      false,
    );
  });
});

describe('diffServers', () => {
  const a: ResolvedMcpServer = {
    name: 'a',
    transport: 'http',
    url: 'https://a',
  };
  const b: ResolvedMcpServer = { name: 'b', transport: 'stdio', command: 'b' };

  it('adds new, removes gone, and leaves unchanged untouched', () => {
    const current = new Map([['a', { key: serverKey(a) }]]);
    const { add, remove } = diffServers(current, [a, b]);
    expect(add.map((s) => s.name)).toEqual(['b']); // a unchanged → not re-added
    expect(remove).toEqual([]);
  });

  it('removes a server dropped from the desired set', () => {
    const current = new Map([
      ['a', { key: serverKey(a) }],
      ['b', { key: serverKey(b) }],
    ]);
    const { add, remove } = diffServers(current, [a]);
    expect(add).toEqual([]);
    expect(remove).toEqual(['b']);
  });

  it('treats a changed endpoint as remove+add (reconnect) for just that server', () => {
    const current = new Map([['a', { key: serverKey(a) }]]);
    const moved: ResolvedMcpServer = {
      name: 'a',
      transport: 'http',
      url: 'https://a2',
    };
    const { add, remove } = diffServers(current, [moved]);
    expect(remove).toEqual(['a']);
    expect(add.map((s) => s.name)).toEqual(['a']);
  });

  it('ignores invalid desired servers', () => {
    const { add } = diffServers(new Map(), [
      { name: 'bad', transport: 'http' },
    ]);
    expect(add).toEqual([]);
  });
});

describe('parseHubConfig', () => {
  it('parses a well-formed config', () => {
    const cfg = {
      spawn: { cwd: '/workspace', home: '/home/atlas', baseEnv: {} },
      servers: [],
    };
    expect(parseHubConfig(JSON.stringify(cfg))).toEqual(cfg);
  });

  it('returns null on malformed / partial JSON so the hub keeps its current connections', () => {
    expect(parseHubConfig('{ not json')).toBeNull();
    expect(parseHubConfig('{"servers":[]}')).toBeNull(); // no spawn
    expect(
      parseHubConfig('{"spawn":{"cwd":"/workspace","home":"/home/atlas"}}'),
    ).toBeNull(); // no servers
  });

  it('defaults a missing baseEnv to {}', () => {
    const cfg = parseHubConfig(
      '{"spawn":{"cwd":"/w","home":"/h"},"servers":[]}',
    );
    expect(cfg?.spawn.baseEnv).toEqual({});
  });
});
