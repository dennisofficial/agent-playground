import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntitySubscriberInterface, InsertEvent } from 'typeorm';
import { AppVersionService } from '../cluster/app-version.service';
import { DB_CONNECTION } from './database.module';
import { MessageEntity } from './entities';

/**
 * Auto-stamps every `messages` insert with the writing process's backend commit SHA
 * (`AppVersionService.sha`) — covers every `.save()`/`repo.insert()` write path project-wide. The one
 * exception is `MessageBlockSink.appendBlock`'s QueryBuilder `.insert().orIgnore()` path (a TypeORM
 * subscriber's `beforeInsert` does not fire for QueryBuilder inserts), which sets `engine_git_sha`
 * directly in its row instead.
 */
@Injectable()
export class MessageGitShaSubscriber implements EntitySubscriberInterface<MessageEntity> {
  constructor(
    @InjectDataSource(DB_CONNECTION) dataSource: DataSource,
    private readonly version: AppVersionService,
  ) {
    dataSource.subscribers.push(this);
  }

  listenTo(): typeof MessageEntity {
    return MessageEntity;
  }

  beforeInsert(event: InsertEvent<MessageEntity>): void {
    if (!event.entity.engine_git_sha) event.entity.engine_git_sha = this.version.sha;
  }
}
