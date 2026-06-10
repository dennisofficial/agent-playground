import { TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { BotCursor, ChannelMessage } from '@workspace/shared/schemas';
import { ChannelService } from './channel.service';
import { CursorStore } from './cursor.store';

/**
 * The conversation log + per-bot cursors, with Postgres durability behind a synchronous in-memory
 * face (see ChannelService for why sync is load-bearing).
 */
@CreateModule({
  imports: [TypeOrmModule.forFeature([ChannelMessage, BotCursor])],
  services: [ChannelService, CursorStore],
})
export class ChannelModule {}
