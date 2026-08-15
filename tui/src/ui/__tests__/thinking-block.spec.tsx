import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import React from 'react';
import { ThinkingBlock } from '../components/blocks/thinking-block.js';
import { registerGrammars } from '../markdown/grammars/index.js';

// A `TreeSitterClient` takes the default parser set once, at construction — so the grammars have to
// be in place before the first renderer builds one.
await registerGrammars();

const WIDTH = 60;

const MARKDOWN = [
  '## Two options',
  '',
  'Rotation is **stateless**, so the resume id survives.',
].join('\n');

async function draw(
  node: React.ReactNode,
): Promise<{ drawn: string; destroy: () => void }> {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={16}>
      {node}
    </box>,
    { width: WIDTH, height: 16 },
  );
  await setup.flush();
  // Highlighting is a round trip to the parser worker — a frame captured too early is unparsed.
  await new Promise((resolve) => setTimeout(resolve, 40));
  await setup.flush();
  return {
    drawn: setup.captureCharFrame(),
    destroy: () => setup.renderer.destroy(),
  };
}

describe('ThinkingBlock', () => {
  it('renders the opened block as markdown', async () => {
    const { drawn, destroy } = await draw(
      <ThinkingBlock text={MARKDOWN} expanded width={WIDTH} />,
    );
    try {
      expect(drawn).toContain('Two options');
      expect(drawn).toContain('stateless');
      // The evidence: the syntax was consumed rather than printed.
      expect(drawn).not.toContain('##');
      expect(drawn).not.toContain('**');
    } finally {
      destroy();
    }
  }, 30_000);

  /**
   * The live tail is the one path that stays verbatim, and it has to: it is CUT at the top so the
   * working line stays on screen, and a document sliced mid-fence is not a document. Asserted so
   * that "make everything markdown" does not later take this branch with it by accident.
   */
  it('leaves the streaming tail hand-wrapped, and still cuts its head', async () => {
    const long = Array.from(
      { length: 40 },
      (_, i) => `## reasoning line ${i}`,
    ).join('\n');
    const { drawn, destroy } = await draw(
      <ThinkingBlock text={long} streaming width={WIDTH} />,
    );
    try {
      expect(drawn).toContain('##');
      expect(drawn).toContain('lines above');
      expect(drawn).toContain('reasoning line 39');
      expect(drawn).not.toContain('reasoning line 0 ');
    } finally {
      destroy();
    }
  }, 30_000);

  it('collapses to one line that says nothing about markup', async () => {
    const { drawn, destroy } = await draw(
      <ThinkingBlock text={MARKDOWN} width={WIDTH} />,
    );
    try {
      expect(drawn).not.toContain('stateless');
      expect(drawn.split('\n').filter((line) => line.trim()).length).toBe(1);
    } finally {
      destroy();
    }
  }, 30_000);
});
