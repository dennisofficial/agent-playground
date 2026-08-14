import { describe, expect, it } from 'bun:test';
import { MessageQueue } from '../message-queue.js';

/**
 * A queue, and nothing more. The steer ack deliberately does NOT live here any more: a pull means
 * the CLI's stdin took the bytes, which is not the same as the model reading them — that ack arrives
 * on the output stream as a replay frame. See `claude-engine.service.ts`.
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

  it('delivers an item pushed while the consumer is already waiting', async () => {
    const queue = new MessageQueue<string>();

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
    queue.push('late');

    expect(await consumed).toEqual(['late']);
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
