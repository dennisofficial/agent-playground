import { describe, expect, it } from 'bun:test';
import { ConversationStore } from '../conversation.store.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('tail reveal', () => {
  it('shows a chunk in slices rather than all at once', async () => {
    const store = new ConversationStore();
    store.startTurn();
    store.appendDelta('text', 'the quick brown fox jumps over the lazy dog');

    expect(store.getSnapshot().tail).toBeNull();

    await sleep(50);
    const first = store.getSnapshot().tail?.text ?? '';
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan('the quick brown fox jumps over the lazy dog'.length);
    expect('the quick brown fox jumps over the lazy dog'.startsWith(first)).toBe(true);
  });

  it('delivers every character, in order', async () => {
    const store = new ConversationStore();
    store.startTurn();
    for (const chunk of ['alpha ', 'beta ', 'gamma ', 'delta']) store.appendDelta('text', chunk);

    await sleep(900);
    expect(store.getSnapshot().tail?.text).toBe('alpha beta gamma delta');
  });

  it('keeps draining when no further delta arrives', async () => {
    const store = new ConversationStore();
    store.startTurn();
    store.appendDelta('text', 'x'.repeat(120));

    await sleep(50);
    expect(store.getSnapshot().tail?.text.length).toBeLessThan(120);
    await sleep(900);
    expect(store.getSnapshot().tail?.text.length).toBe(120);
  });

  it('dumps a burst instead of typewriting through it', async () => {
    const store = new ConversationStore();
    store.startTurn();
    store.appendDelta('text', 'y'.repeat(5_000));

    await sleep(50);
    expect(store.getSnapshot().tail?.text.length).toBe(5_000);
  });

  it('counts tokens on arrival, not on reveal', () => {
    const store = new ConversationStore();
    store.startTurn();
    store.appendDelta('text', 'z'.repeat(400));
    expect(store.getSnapshot().outputTokens).toBe(100);
  });

  it('drops the backlog when the block it belonged to commits', async () => {
    const store = new ConversationStore();
    store.startTurn();
    store.appendDelta('text', 'a partially revealed sentence');
    store.commit({ id: 'm1' } as never);

    await sleep(150);
    expect(store.getSnapshot().tail).toBeNull();
  });

  it('does not carry a thinking backlog into the text that replaces it', async () => {
    const store = new ConversationStore();
    store.startTurn();
    store.appendDelta('thinking', 'considering the retry loop');
    store.appendDelta('text', 'Here is what I found.');

    await sleep(900);
    expect(store.getSnapshot().tail).toEqual({ kind: 'text', text: 'Here is what I found.' });
  });
});
