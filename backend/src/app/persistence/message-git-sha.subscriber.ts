import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntitySubscriberInterface, InsertEvent } from 'typeorm';
import { AppVersionService } from '../cluster/app-version.service';
import { DB_CONNECTION } from './database.module';
import { TranscriptMessageEntity } from './entities';

@Injectable()
export class MessageGitShaSubscriber implements EntitySubscriberInterface<TranscriptMessageEntity> {
  constructor(
    @InjectDataSource(DB_CONNECTION) dataSource: DataSource,
    private readonly version: AppVersionService,
  ) {
    dataSource.subscribers.push(this);
  }

  listenTo(): typeof TranscriptMessageEntity {
    return TranscriptMessageEntity;
  }

  beforeInsert(event: InsertEvent<TranscriptMessageEntity>): void {
    if (!event.entity.engine_git_sha) event.entity.engine_git_sha = this.version.sha;
  }
}
