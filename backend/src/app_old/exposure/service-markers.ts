import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceLivenessProbe } from '../sandbox/sandbox-provider.port';
import { isValidExposedServiceName } from './exposure-naming';

export type ServiceMarker = {
  name: string;
  cmd: string;
  pid: number | null;
  pgid: number | null;
  startedAt: string | null;
  port: number | null;
  expose: boolean;
  logBytes: number;
  logUpdatedAt: string | null;
};

const SERVICE_ID_RE = /^[a-z0-9_-]+$/;

export type ReadServiceMarker = ServiceMarker & { id: string };

export type ServiceStatus = 'running' | 'stopped' | 'unknown';

export const GENERATION_SKEW_MS = 2_000;

export function serviceStatus(
  marker: Pick<ServiceMarker, 'pgid' | 'startedAt'>,
  probe: ServiceLivenessProbe,
): ServiceStatus {
  if (probe.status === 'unknown') return 'unknown';
  if (probe.status === 'down') return 'stopped'; // no running container ⇒ every marker is dead
  if (marker.pgid == null || marker.startedAt == null) return 'unknown';
  const started = Date.parse(marker.startedAt);
  const generation = Date.parse(probe.containerStartedAt);
  if (!Number.isFinite(started) || !Number.isFinite(generation)) return 'unknown';
  if (started < generation - GENERATION_SKEW_MS) return 'stopped'; // previous container — reused pgid must not read as running
  return probe.alive.includes(marker.pgid) ? 'running' : 'stopped';
}

export function readServiceMarkers(dir: string): ReadServiceMarker[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const markers: ReadServiceMarker[] = [];
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    if (!SERVICE_ID_RE.test(id)) continue; // defensive — atlas-svc only ever writes validated names
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
    } catch {
      continue; // a marker mid-write / corrupt — skip rather than fail the whole list
    }
    let logBytes = 0;
    let logUpdatedAt: string | null = null;
    try {
      const st = statSync(join(dir, `${id}.log`));
      logBytes = st.size;
      logUpdatedAt = st.mtime.toISOString();
    } catch {
    }
    const name =
      typeof parsed.name === 'string' && SERVICE_ID_RE.test(parsed.name) ? parsed.name : id;
    const port =
      typeof parsed.port === 'number' &&
      Number.isInteger(parsed.port) &&
      parsed.port >= 1 &&
      parsed.port <= 65535
        ? parsed.port
        : null;
    markers.push({
      id,
      name,
      cmd: typeof parsed.cmd === 'string' ? parsed.cmd : '',
      pid: typeof parsed.pid === 'number' ? parsed.pid : null,
      pgid: typeof parsed.pgid === 'number' ? parsed.pgid : null,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      port,
      expose: parsed.expose === true && isValidExposedServiceName(name),
      logBytes,
      logUpdatedAt,
    });
  }
  return markers;
}

export type PortState = 'exposed' | 'internal' | null;
export function derivePortState(
  markers: ReadServiceMarker[],
  probe: ServiceLivenessProbe,
  hasUrl: (m: ReadServiceMarker) => boolean,
): PortState {
  const running = markers.filter((m) => serviceStatus(m, probe) === 'running');
  if (running.length === 0) return null;
  return running.some((m) => m.port != null && m.expose && hasUrl(m)) ? 'exposed' : 'internal';
}
