import { Injectable } from "@nestjs/common";
import type { Message, TurnSummary } from "../domain/message.js";
import { ConversationStore } from "./conversation.store.js";

@Injectable()
export class ConversationStoreRegistry {
  private readonly stores = new Map<string, ConversationStore>();

  for(threadId: string): ConversationStore {
    const existing = this.stores.get(threadId);
    if (existing) return existing;
    const store = new ConversationStore();
    this.stores.set(threadId, store);
    return store;
  }

  hydrate(
    threadId: string,
    messages: Message[],
    closed: boolean,
    lastTurn?: TurnSummary | null,
  ): ConversationStore {
    const store = this.for(threadId);
    store.hydrate(messages, closed, lastTurn);
    return store;
  }

  forget(threadIds: readonly string[]): void {
    for (const threadId of threadIds) this.stores.delete(threadId);
  }
}
