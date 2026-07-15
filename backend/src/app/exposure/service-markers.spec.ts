import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServiceLivenessProbe } from '../sandbox/sandbox-provider.port';
import {
  derivePortState,
  readServiceMarkers,
  type ReadServiceMarker,
} from './service-markers';

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

  it('defaults a marker WITHOUT port/expose to port:null, expose:false (secure-by-default)', () => {
    write('web', {
      name: 'web',
      cmd: 'pnpm dev',
      pid: 10,
      pgid: 10,
      startedAt: '2026-07-10T00:00:00Z',
    });
    const [m] = readServiceMarkers(dir);
    expect(m.port).toBeNull();
    expect(m.expose).toBe(false);
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

  it('parses explicit port + expose:true for a DNS-safe name', () => {
    write('api', { name: 'api', port: 3000, expose: true });
    const [m] = readServiceMarkers(dir);
    expect(m.port).toBe(3000);
    expect(m.expose).toBe(true);
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

describe('derivePortState', () => {
  const CONTAINER_STARTED_AT = '2026-07-10T00:00:00Z';

  const runningMarker = (
    overrides: Partial<ReadServiceMarker> = {},
  ): ReadServiceMarker => ({
    id: 'web',
    name: 'web',
    cmd: 'pnpm dev',
    pid: 10,
    pgid: 10,
    startedAt: CONTAINER_STARTED_AT,
    port: 3000,
    expose: true,
    logBytes: 0,
    logUpdatedAt: null,
    ...overrides,
  });

  const upProbe = (...alivePgids: number[]): ServiceLivenessProbe => ({
    status: 'up',
    containerStartedAt: CONTAINER_STARTED_AT,
    alive: alivePgids,
  });

  it('exposed running service with a public URL ⇒ exposed', () => {
    const m = runningMarker({ expose: true });
    expect(derivePortState([m], upProbe(10), () => true)).toBe('exposed');
  });

  it('running but expose:false ⇒ internal', () => {
    const m = runningMarker({ expose: false });
    expect(derivePortState([m], upProbe(10), () => true)).toBe('internal');
  });

  it('running but hasUrl ⇒ false (exposure disabled) ⇒ internal', () => {
    const m = runningMarker();
    expect(derivePortState([m], upProbe(10), () => false)).toBe('internal');
  });

  it('running with no port ⇒ internal', () => {
    const m = runningMarker({ port: null });
    expect(derivePortState([m], upProbe(10), () => true)).toBe('internal');
  });

  it('nothing running (probe down) ⇒ null', () => {
    const m = runningMarker();
    expect(derivePortState([m], { status: 'down' }, () => true)).toBeNull();
  });
});
