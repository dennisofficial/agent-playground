import { describe, expect, it } from 'vitest';
import type { Repository } from 'typeorm';
import type { Job } from '../domain';
import type { AtlasChannel, AtlasThread } from '../persistence/entities';
import { DriverStoreService } from './driver-store.service';

/**
 * `route()` is what carries surface identity from the persisted thread onto async outbound (build
 * progress, park, the approval card), so a post for a web thread reaches the web adapter. Only the
 * channels + threads repos are exercised here; the others are unused by `route()`.
 */
function makeStore(opts: { channel?: Partial<AtlasChannel>; thread?: Partial<AtlasThread> }): DriverStoreService {
  const channels = {
    findOne: async () => (opts.channel ? (opts.channel as AtlasChannel) : null),
  } as unknown as Repository<AtlasChannel>;
  const threads = {
    findOne: async () => (opts.thread ? (opts.thread as AtlasThread) : null),
  } as unknown as Repository<AtlasThread>;
  const unused = {} as unknown as Repository<AtlasThread>;
  return new DriverStoreService(
    unused as never, // jobs
    unused as never, // sections
    unused as never, // phases
    unused as never, // records
    threads as never,
    channels as never,
  );
}

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: 'job-1',
    teamId: 'T1',
    projectId: 'web',
    threadId: 'thread-1',
    kind: 'feature',
    status: 'running',
    title: 't',
    decisionRecordId: null,
    featureBranch: null,
    prUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as Job;

describe('DriverStoreService.route — surfaceId', () => {
  it('carries the thread surface onto the JobRoute (so async posts reach the originating surface)', async () => {
    const store = makeStore({
      channel: { surface_channel_ref: 'C042', team_id: 'T1' } as Partial<AtlasChannel>,
      thread: { surface_thread_ref: '50.0', surface: 'web' } as Partial<AtlasThread>,
    });
    const route = await store.route(job());
    expect(route).toEqual({ channel: 'C042', threadTs: '50.0', teamId: 'T1', surfaceId: 'web' });
  });

  it('omits surfaceId when the thread row has none (legacy / not found)', async () => {
    const store = makeStore({
      channel: { surface_channel_ref: 'C042' } as Partial<AtlasChannel>,
      thread: { surface_thread_ref: '50.0' } as Partial<AtlasThread>, // no surface
    });
    const route = await store.route(job());
    expect(route.surfaceId).toBeUndefined();
    expect(route).toMatchObject({ channel: 'C042', threadTs: '50.0', teamId: 'T1' });
  });
});
