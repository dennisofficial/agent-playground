import type { InsertEvent } from 'typeorm';
import { describe, expect, it } from 'vitest';
import type { AppVersionService } from '../../cluster/app-version.service';
import type { TranscriptMessageEntity } from '../entities';
import { MessageGitShaSubscriber } from '../message-git-sha.subscriber';

function make(sha = 'sha-abc1234') {
  const dataSource = { subscribers: [] as unknown[] };
  const version = { sha } as unknown as AppVersionService;
  const subscriber = new MessageGitShaSubscriber(dataSource as never, version);
  return { subscriber, dataSource };
}

describe('MessageGitShaSubscriber', () => {
  it('registers itself on the datasource at construction', () => {
    const { subscriber, dataSource } = make();
    expect(dataSource.subscribers).toContain(subscriber);
  });

  it('listens to TranscriptMessageEntity', () => {
    const { subscriber } = make();
    expect(subscriber.listenTo()).toBeDefined();
  });

  it('stamps engine_git_sha on insert when unset', () => {
    const { subscriber } = make('sha-abc1234');
    const entity = {
      engine_git_sha: null,
    } as unknown as TranscriptMessageEntity;
    subscriber.beforeInsert({ entity } as InsertEvent<TranscriptMessageEntity>);
    expect(entity.engine_git_sha).toBe('sha-abc1234');
  });

  it('does not clobber an already-set engine_git_sha', () => {
    const { subscriber } = make('sha-current');
    const entity = {
      engine_git_sha: 'sha-preset',
    } as unknown as TranscriptMessageEntity;
    subscriber.beforeInsert({ entity } as InsertEvent<TranscriptMessageEntity>);
    expect(entity.engine_git_sha).toBe('sha-preset');
  });
});
