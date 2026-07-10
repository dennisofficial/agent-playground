import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readServiceMarkers } from './service-markers';

describe('readServiceMarkers', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'markers-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (id: string, body: unknown): void => {
    writeFileSync(
      join(dir, `${id}.json`),
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  };

  it('defaults a marker WITHOUT port/expose to port:null, expose:true (back-compat)', () => {
    write('web', {
      name: 'web',
      cmd: 'pnpm dev',
      pid: 10,
      pgid: 10,
      startedAt: '2026-07-10T00:00:00Z',
    });
    const [m] = readServiceMarkers(dir);
    expect(m.port).toBeNull();
    expect(m.expose).toBe(true);
  });

  it('parses explicit port + expose:false', () => {
    write('api', { name: 'api', port: 3000, expose: false });
    const [m] = readServiceMarkers(dir);
    expect(m.port).toBe(3000);
    expect(m.expose).toBe(false);
  });

  it('does not expose a ported service whose name cannot form a valid DNS label', () => {
    write('api_server', { name: 'api_server', port: 3000 });
    const [m] = readServiceMarkers(dir);
    expect(m.port).toBe(3000);
    expect(m.expose).toBe(false);
  });

  it('skips corrupt / mid-write JSON', () => {
    write('good', { name: 'good', port: 8080 });
    write('bad', '{ not valid json');
    const ids = readServiceMarkers(dir).map((m) => m.id);
    expect(ids).toEqual(['good']);
  });

  it('ignores non-json files and invalid ids', () => {
    write('ok', { name: 'ok' });
    writeFileSync(join(dir, 'ok.log'), 'log data');
    writeFileSync(join(dir, 'Bad Name.json'), JSON.stringify({ name: 'x' }));
    const ids = readServiceMarkers(dir).map((m) => m.id);
    expect(ids).toEqual(['ok']);
  });

  it('returns [] when the dir does not exist', () => {
    expect(readServiceMarkers(join(dir, 'nope'))).toEqual([]);
  });
});
