import { describe, expect, it } from 'bun:test';
import { ConversationStoreRegistry } from '../conversation-store.registry.js';

describe('drafts', () => {
  it('survives leaving and re-opening the thread', () => {
    const registry = new ConversationStoreRegistry();
    registry.for('thread-1').draft = 'half a sentence about the retry loop';

    const reopened = registry.hydrate('thread-1', [], false);
    expect(reopened.draft).toBe('half a sentence about the retry loop');
  });

  it('keeps one thread out of another thread’s composer', () => {
    const registry = new ConversationStoreRegistry();
    registry.for('thread-1').draft = 'for the builder';
    expect(registry.for('thread-2').draft).toBe('');
  });

  it('forgets the draft of a deleted job', () => {
    const registry = new ConversationStoreRegistry();
    registry.for('thread-1').draft = 'about to be irrelevant';
    registry.forget(['thread-1']);
    expect(registry.for('thread-1').draft).toBe('');
  });
});
