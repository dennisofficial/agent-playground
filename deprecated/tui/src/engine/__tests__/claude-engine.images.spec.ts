import { describe, expect, it } from 'bun:test';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeEngineService } from '../claude-engine.service.js';
import type { ClaudeAgentSdk } from '../claude-sdk.provider.js';
import { ClaudeNormaliserService } from '../normalise/claude-normaliser.service.js';
import type { RawTapeService } from '../raw-tape.service.js';

/**
 * What a pasted picture looks like on the wire.
 *
 * The engine is the only place that knows, and it is one function — but it is the function that
 * decides whether an image reaches the model at all, and the failure mode if it is wrong is a turn
 * that silently discusses a picture nobody sent.
 */

const TAPE = { append: () => undefined } as unknown as RawTapeService;

/** Captures the first message pushed into the input stream, then hangs — nothing here runs a turn. */
function capturingSdk(): {
  sdk: ClaudeAgentSdk;
  first: Promise<SDKUserMessage>;
} {
  let resolve: (message: SDKUserMessage) => void = () => undefined;
  const first = new Promise<SDKUserMessage>((done) => {
    resolve = done;
  });

  const sdk = {
    query: (args: { prompt: AsyncIterable<SDKUserMessage> }) => {
      void (async () => {
        for await (const message of args.prompt) {
          resolve(message);
          return;
        }
      })();
      return Object.assign(
        (async function* () {
          // Never yields: the assertion is about what went IN.
          await new Promise(() => undefined);
        })(),
        { interrupt: async () => undefined },
      );
    },
  } as unknown as ClaudeAgentSdk;

  return { sdk, first };
}

function run(args: {
  prompt: string;
  images?: readonly { mediaType: string; data: string }[];
}): Promise<SDKUserMessage> {
  const { sdk, first } = capturingSdk();
  const engine = new ClaudeEngineService(sdk, new ClaudeNormaliserService(), TAPE);
  engine.start({
    prompt: args.prompt,
    ...(args.images ? { images: args.images } : {}),
    cwd: '/tmp',
    model: 'claude-opus-5',
    env: {},
    onEvent: () => undefined,
  });
  return first;
}

describe('a prompt with a picture in it', () => {
  it('sends the words and the image as one user turn', async () => {
    const message = await run({
      prompt: 'what is wrong with [Image #1]?',
      images: [{ mediaType: 'image/png', data: 'AAAB' }],
    });

    expect(message.message.content).toEqual([
      { type: 'text', text: 'what is wrong with [Image #1]?' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAB' },
      },
    ]);
  });

  it('carries every image, in the order the draft referred to them', async () => {
    const message = await run({
      prompt: 'compare [Image #1] with [Image #2]',
      images: [
        { mediaType: 'image/png', data: 'FIRST' },
        { mediaType: 'image/png', data: 'SECOND' },
      ],
    });

    const blocks = message.message.content as { type: string; source?: { data: string } }[];
    expect(blocks.map((block) => block.type)).toEqual(['text', 'image', 'image']);
    expect(blocks[1]?.source?.data).toBe('FIRST');
    expect(blocks[2]?.source?.data).toBe('SECOND');
  });

  /**
   * The overwhelmingly common turn stays a bare string.
   *
   * Not a style preference: every tape, fixture and normaliser test Atlas has ever written contains
   * the string form, and switching unconditionally to a one-element block array would rewrite the
   * wire format of every turn to buy nothing.
   */
  it('leaves an ordinary prompt as a plain string', async () => {
    const message = await run({ prompt: 'no pictures here' });
    expect(message.message.content).toBe('no pictures here');
  });
});
