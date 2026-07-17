
export interface StreamEntry<T = unknown> {
  id: string;
  data: T;
}

export const REDIS_STREAM_PORT = Symbol('REDIS_STREAM_PORT');

export interface RedisStreamPort {
  xadd(stream: string, data: unknown): Promise<string>;

  del(...keys: string[]): Promise<void>;

  scanKeys(match: string, count?: number): Promise<string[]>;

  objectIdleTime(key: string): Promise<number | null>;

  ensureGroup(stream: string, group: string): Promise<void>;

  xreadGroup(args: {
    group: string;
    consumer: string;
    stream: string;
    count: number;
    blockMs: number;
  }): Promise<StreamEntry[]>;

  ack(stream: string, group: string, ids: string[]): Promise<void>;

  claimStale(args: {
    group: string;
    consumer: string;
    stream: string;
    minIdleMs: number;
    count: number;
  }): Promise<StreamEntry[]>;

  xread(args: {
    stream: string;
    lastId: string;
    count: number;
    blockMs: number;
  }): Promise<StreamEntry[]>;

  publish(channel: string, message: unknown): Promise<number>;

  subscribe(channel: string, handler: (message: unknown) => void): Promise<() => Promise<void>>;
}
