import { TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { BotCursor, Channel, ChannelMessage } from '@workspace/shared/schemas';
import { ChannelRegistryService } from './channel-registry.service';
import { ChannelService } from './channel.service';
import { CursorStore } from './cursor.store';

/**
 * The conversation logs (one per room) + per-bot cursors + the channel registry, with Postgres
 * durability behind a synchronous in-memory face (see ChannelService for why sync is load-bearing).
 */
@CreateModule({
  imports: [TypeOrmModule.forFeature([ChannelMessage, BotCursor, Channel])],
  services: [ChannelService, CursorStore, ChannelRegistryService],
})
export class ChannelModule {}
