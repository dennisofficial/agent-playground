// TypeORM entities (backend-only — imported via `@workspace/shared/schemas`, never the root barrel,
// so the web bundle never pulls TypeORM decorators).
// NOTE: the board (tickets/plans/comments) is intentionally NOT here — it's being redesigned and will
// land in its own pass.
export * from './classes/base.entity';
export * from './bot-cursor.entity';
export * from './channel-message.entity';
export * from './channel.entity';
export * from './fact.entity';
export * from './task.entity';
export * from './worklog.entity';

import { BotCursor } from './bot-cursor.entity';
import { ChannelMessage } from './channel-message.entity';
import { Channel } from './channel.entity';
import { Fact } from './fact.entity';
import { Task } from './task.entity';
import { Worklog } from './worklog.entity';

/** Every harness entity — pass to the TypeORM DataSource / `TypeOrmModule.forRoot({ entities })`. */
export const ENTITIES = [Fact, Task, Worklog, ChannelMessage, BotCursor, Channel];
