import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.tokens';
import type { RedisStreamPort, StreamEntry } from './redis.port';

/** The single stream field we store the JSON-encoded frame under (see redis.port.ts). */
const DATA_FIELD = 'data';

/**
 * The PRODUCTION `RedisStreamPort` binding — wraps the shared `ioredis` client.
 *
 * Two ioredis shape details it normalizes for callers:
 *  - `xreadgroup`/`xread` return `[ [streamKey, [ [id, [f1, v1, ...]], ... ]], ... ] | null`. We read a
 *    SINGLE stream per call, so we flatten to `StreamEntry[]` and JSON-decode the `data` field.
 *  - a SUBSCRIBED ioredis connection can't run normal commands, so `subscribe` DUPLICATES the client
 *    (`client.duplicate()`) per channel and quits that connection on unsubscribe.
 *
 * Resilience lives in the client itself (lazyConnect + retryStrategy in redis.tokens.ts), so these
 * ops simply reject if Redis is unreachable — the daemon consumer loop and host client catch + retry.
 */
@Injectable()
export class IoredisStreamAdapter implements RedisStreamPort {
  private readonly logger = new Logger(IoredisStreamAdapter.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async xadd(stream: string, data: unknown): Promise<string> {
    const id = await this.client.xadd(
      stream,
      '*',
      DATA_FIELD,
      JSON.stringify(data),
    );
    // ioredis types xadd's return as `string | null`; '*' auto-id never yields null in practice.
    return id ?? '0-0';
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.client.del(...keys);
  }

  async ensureGroup(stream: string, group: string): Promise<void> {
    try {
      await this.client.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    } catch (err) {
      // BUSYGROUP = the group already exists — the idempotent happy path on every reboot.
      if (err instanceof Error && /BUSYGROUP/.test(err.message)) return;
      throw err;
    }
  }

  async xreadGroup(args: {
    group: string;
    consumer: string;
    stream: string;
    count: number;
    blockMs: number;
  }): Promise<StreamEntry[]> {
    const res = (await this.client.xreadgroup(
      'GROUP',
      args.group,
      args.consumer,
      'COUNT',
      args.count,
      'BLOCK',
      args.blockMs,
      'STREAMS',
      args.stream,
      '>',
    )) as RawStreamReply | null;
    return parseStreamReply(res);
  }

  async ack(stream: string, group: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.xack(stream, group, ...ids);
  }

  async claimStale(args: {
    group: string;
    consumer: string;
    stream: string;
    minIdleMs: number;
    count: number;
  }): Promise<StreamEntry[]> {
    const out: StreamEntry[] = [];
    let cursor = '0-0'; // XAUTOCLAIM start cursor; advances each page, wraps to '0-0' when drained
    // Bound the paging so a pathological PEL can't spin forever (a turn's pending set is normally 0–1).
    for (let page = 0; page < 100; page++) {
      // XAUTOCLAIM key group consumer min-idle-time start COUNT n → [nextCursor, entries, deletedIds].
      const res = (await this.client.xautoclaim(
        args.stream,
        args.group,
        args.consumer,
        args.minIdleMs,
        cursor,
        'COUNT',
        args.count,
      )) as [string, Array<[string, string[]]>, string[]?];
      const [next, entries] = res;
      for (const [id, fields] of entries ?? []) {
        out.push({ id, data: decodeFields(fields) });
      }
      cursor = next;
      if (cursor === '0-0') break; // scanned the whole pending list
    }
    return out;
  }

  async xread(args: {
    stream: string;
    lastId: string;
    count: number;
    blockMs: number;
  }): Promise<StreamEntry[]> {
    const res = (await this.client.xread(
      'COUNT',
      args.count,
      'BLOCK',
      args.blockMs,
      'STREAMS',
      args.stream,
      args.lastId,
    )) as RawStreamReply | null;
    return parseStreamReply(res);
  }

  async publish(channel: string, message: unknown): Promise<number> {
    return this.client.publish(channel, JSON.stringify(message));
  }

  async subscribe(
    channel: string,
    handler: (message: unknown) => void,
  ): Promise<() => Promise<void>> {
    // A subscribed connection can't issue normal commands — give each subscription its own.
    const sub = this.client.duplicate();
    sub.on('message', (chan: string, raw: string) => {
      if (chan !== channel) return;
      try {
        handler(JSON.parse(raw));
      } catch (err) {
        this.logger.warn(`bad pub/sub payload on ${channel}: ${String(err)}`);
      }
    });
    await sub.subscribe(channel);
    return async () => {
      try {
        await sub.unsubscribe(channel);
      } finally {
        sub.disconnect();
      }
    };
  }
}

/** ioredis' nested stream-read reply: [ [streamKey, [ [id, [field, value, ...]], ... ]], ... ]. */
type RawStreamReply = Array<[string, Array<[string, string[]]>]>;

/** Flatten a single-stream ioredis reply to decoded `StreamEntry[]` (the `data` field JSON-parsed). */
function parseStreamReply(res: RawStreamReply | null): StreamEntry[] {
  if (!res || res.length === 0) return [];
  const out: StreamEntry[] = [];
  for (const [, entries] of res) {
    for (const [id, fields] of entries) {
      out.push({ id, data: decodeFields(fields) });
    }
  }
  return out;
}

/** Decode a flat [field, value, ...] list, returning the JSON-parsed `data` field's value. */
function decodeFields(fields: string[]): unknown {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === DATA_FIELD) {
      try {
        return JSON.parse(fields[i + 1]);
      } catch {
        return fields[i + 1];
      }
    }
  }
  return undefined;
}
