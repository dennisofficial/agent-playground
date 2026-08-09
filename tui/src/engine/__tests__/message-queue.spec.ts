import { describe, expect, it } from 'bun:test';
import { MessageQueue } from '../message-queue.js';

/**
 * The steer ack. A queued item must leave the UI because the engine TOOK it, not because we hoped
 * it did — so `onConsumed` has to fire on pull, never on push.
 */
describe('MessageQueue', () => {
  it('delivers buffered items in order', async () => {
    const queue = new MessageQueue<string>();
    queue.push('a');
    queue.push('b');
    queue.close();

    const seen: string[] = [];
    for await (const item of queue) seen.push(item);
    expect(seen).toEqual(['a', 'b']);
  });

  it('does NOT ack on push — only when the consumer pulls', async () => {
    const queue = new MessageQueue<string>();
    let acked = false;
    queue.push('steer', () => {
      acked = true;
    });

    expect(acked).toBe(false);
    expect(queue.pending).toBe(1);

    queue.close();
    for await (const _ of queue) {
      // pulling is what acks
    }
    expect(acked).toBe(true);
  });

  it('acks an item pushed while the consumer is already waiting', async () => {
    const queue = new MessageQueue<string>();
    const acks: string[] = [];

    const consumed = (async () => {
      const seen: string[] = [];
      for await (const item of queue) {
        seen.push(item);
        if (seen.length === 1) queue.close();
      }
      return seen;
    })();

    // Give the consumer a tick to park on the waiting promise.
    await new Promise((resolve) => setImmediate(resolve));
    queue.push('late', () => acks.push('late'));

    expect(await consumed).toEqual(['late']);
    expect(acks).toEqual(['late']);
  });

  it('reports how many steers are still pending', () => {
    const queue = new MessageQueue<string>();
    expect(queue.pending).toBe(0);
    queue.push('a');
    queue.push('b');
    expect(queue.pending).toBe(2);
  });

  it('ignores pushes after close rather than delivering them into a dead turn', async () => {
    const queue = new MessageQueue<string>();
    queue.close();
    queue.push('too late');

    const seen: string[] = [];
    for await (const item of queue) seen.push(item);
    expect(seen).toEqual([]);
  });
});
