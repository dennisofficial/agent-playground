import { Injectable, Logger } from '@nestjs/common';
import type { ActiveTurnEntity } from '../persistence/entities';

export type ReattachOutcome = 'attached' | 'deferred';

export type TurnReattachHandler = (row: ActiveTurnEntity) => Promise<ReattachOutcome>;

@Injectable()
export class TurnReattachRegistry {
  private readonly logger = new Logger(TurnReattachRegistry.name);
  private readonly handlers = new Map<ActiveTurnEntity['kind'], TurnReattachHandler>();

  register(kind: ActiveTurnEntity['kind'], handler: TurnReattachHandler): void {
    if (this.handlers.has(kind)) {
      this.logger.debug(`re-registering reattach handler for kind=${kind}`);
    }
    this.handlers.set(kind, handler);
  }

  handlerFor(kind: ActiveTurnEntity['kind']): TurnReattachHandler | undefined {
    return this.handlers.get(kind);
  }
}
