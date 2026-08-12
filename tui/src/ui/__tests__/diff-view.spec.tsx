import { describe, expect, it } from 'bun:test';
import { TextAttributes } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import type { CapturedFrame } from '@opentui/core';
import { createRoot } from '@opentui/react';
import React from 'react';
import type { DiffHunk } from '../../domain/tool-diff.js';
import { DiffView } from '../components/blocks/diff-view.js';
import { registerGrammars } from '../markdown/grammars/index.js';

// A `TreeSitterClient` takes the default parser set once, at construction — so the grammars have to
// be in place before the first renderer builds one.
await registerGrammars();

/**
 * The tool-block patch, drawn for real and read back off the frame.
 *
 * Asserted here rather than in `domain/` because the thing under test IS the pixels: the block
 * carries the added/removed signal in a BACKGROUND and the removed rows carry it in an ATTRIBUTE,
 * and neither survives as a string. `domain/diff-layout.spec.ts` covers where the columns fall;
 * this covers that the three channels the design depends on actually reach the terminal.
 */

const HUNKS: DiffHunk[] = [
  {
    oldStart: 96,
    newStart: 96,
    lines: [
      '   const raw = isRecord(args.raw) ? args.raw : {};',
      '-  const hunks = parseHunks(raw.structuredPatch);',
      '+  const hunks = parseHunks(raw.patch);',
    ],
  },
  { oldStart: 118, newStart: 120, lines: ['   return { additions, removals };'] },
];

const WIDTH = 76;

async function draw(node: React.ReactNode, settle = 40): Promise<CapturedFrame> {
  const { renderer, renderOnce, captureSpans } = await createTestRenderer({
    width: WIDTH,
    height: 20,
  });
  try {
    createRoot(renderer).render(<>{node}</>);
    await renderOnce();
    // Mounting alone does not append children; a frame has to actually be built. Highlighting needs
    // longer still — it is a round trip to the parser worker, which is the whole reason a row
    // renders plain first and gains its colour a moment later.
    await new Promise((resolve) => setTimeout(resolve, settle));
    await renderOnce();
    return captureSpans();
  } finally {
    renderer.destroy?.();
  }
}

/** The first span of a row that carries a background — the block, wherever the indent ends. */
function block(frame: CapturedFrame, line: number) {
  return frame.lines[line]?.spans.find((span) => span.bg.a > 0);
}

function textOf(frame: CapturedFrame, line: number): string {
  return (frame.lines[line]?.spans ?? []).map((span) => span.text).join('');
}

describe('DiffView', () => {
  it('puts the sign in a coloured block and the code in a fixed column', async () => {
    const frame = await draw(<DiffView hunks={HUNKS} width={WIDTH} expanded />);

    // Context, removed, added, gap, context — the gutter is 3 wide (`120` is the widest number).
    // The removed line is `97` in the OLD file and the added one `97` in the NEW one — the same
    // number twice, which is what keeps a replacement in line with what it replaced.
    expect(textOf(frame, 0)).toStartWith('      96     const raw');
    expect(textOf(frame, 1)).toStartWith('      97 -   const hunks');
    expect(textOf(frame, 2)).toStartWith('      97 +   const hunks');

    // The code starts at the same column on every row, which is the whole point of moving the sign
    // off the content: a `+` in front of the text would push added lines one column right.
    const codeAt = (line: number) => textOf(frame, line).indexOf('const');
    expect(codeAt(1)).toBe(codeAt(2));
    expect(codeAt(0)).toBe(codeAt(1));
  });

  it('spends background on the gutter and nothing on the code', async () => {
    const frame = await draw(<DiffView hunks={HUNKS} width={WIDTH} expanded />);

    const removed = block(frame, 1);
    const added = block(frame, 2);
    expect(removed?.text.trimEnd()).toEndWith('-');
    expect(added?.text.trimEnd()).toEndWith('+');
    // Two different blocks, or the block says "changed" without saying which way.
    expect(removed?.bg).not.toEqual(added?.bg);

    // The code itself is untinted — a wash under syntax highlighting is the thing this design
    // exists to avoid, so a theme quietly gaining one should fail here.
    for (const line of [0, 1, 2]) {
      const spans = frame.lines[line]?.spans ?? [];
      const afterBlock = spans.slice(spans.findIndex((span) => span.bg.a > 0) + 1);
      expect(afterBlock.every((span) => span.bg.a === 0)).toBe(true);
    }
  });

  it('dims removed code rather than colouring it, leaving hue to the syntax', async () => {
    const frame = await draw(<DiffView hunks={HUNKS} width={WIDTH} expanded />);

    const dimmed = (line: number) =>
      (frame.lines[line]?.spans ?? [])
        .filter((span) => span.text.includes('const'))
        .every((span) => (span.attributes & TextAttributes.DIM) !== 0);

    expect(dimmed(1)).toBe(true);
    // Added and context rows keep full weight; only the past is quietened.
    expect(dimmed(2)).toBe(false);
    expect(dimmed(0)).toBe(false);
  });

  it('marks the elision between hunks instead of butting distant lines together', async () => {
    const frame = await draw(<DiffView hunks={HUNKS} width={WIDTH} expanded />);
    expect(textOf(frame, 3)).toContain('⋯');
    expect(textOf(frame, 4)).toStartWith('     120');
  });

  it('syntax-highlights the code when the path names a language', async () => {
    const frame = await draw(
      <DiffView hunks={HUNKS} width={WIDTH} expanded path="src/domain/tool-diff.ts" />,
      400,
    );

    const colours = (line: number) =>
      new Set(
        (frame.lines[line]?.spans ?? [])
          .filter((span) => span.bg.a === 0 && span.text.trim().length > 0)
          .map((span) => `${span.fg.r},${span.fg.g},${span.fg.b}`),
      );

    // `const` / `hunks` / `parseHunks` are a keyword, a variable and a call — three roles the theme
    // gives three colours. One colour on the row would mean the pass ran and captured nothing.
    expect(colours(1).size).toBeGreaterThan(2);
    expect(colours(2).size).toBeGreaterThan(2);

    // The text still reads exactly as the patch said it did. Highlighting rewrites a row into many
    // spans, and a dropped or conceal-substituted character would slide the code off its number.
    const code = (frame.lines[2]?.spans ?? [])
      .map((span) => span.text)
      .join('')
      .slice('      97 + '.length);
    expect(code).toStartWith('  const hunks = parseHunks(raw.patch);');
  });

  it('keeps the removed row dim even once the syntax owns its colours', async () => {
    // The two systems have to compose: the grammar sets hue per chunk, the row sets weight across
    // all of them. Either one flattening the other is the failure this guards.
    const frame = await draw(
      <DiffView hunks={HUNKS} width={WIDTH} expanded path="src/domain/tool-diff.ts" />,
      400,
    );

    const code = (line: number) =>
      (frame.lines[line]?.spans ?? []).filter(
        (span) => span.bg.a === 0 && span.text.trim().length > 0,
      );

    expect(code(1).every((span) => (span.attributes & TextAttributes.DIM) !== 0)).toBe(true);
    expect(code(2).some((span) => (span.attributes & TextAttributes.DIM) !== 0)).toBe(false);
  });

  it('leaves the code plain when no path names a language, rather than guessing one', async () => {
    const frame = await draw(<DiffView hunks={HUNKS} width={WIDTH} expanded />, 400);
    const colours = new Set(
      (frame.lines[2]?.spans ?? [])
        .filter((span) => span.bg.a === 0 && span.text.trim().length > 0)
        .map((span) => `${span.fg.r},${span.fg.g},${span.fg.b}`),
    );
    expect(colours.size).toBe(1);
  });

  it('collapses to a notice when not expanded', async () => {
    const long: DiffHunk[] = [
      {
        oldStart: 1,
        newStart: 1,
        lines: Array.from({ length: 20 }, (_, index) => `+line ${index}`),
      },
    ];
    const frame = await draw(<DiffView hunks={long} width={WIDTH} expanded={false} />);
    const all = frame.lines.map((_, index) => textOf(frame, index)).join('\n');
    expect(all).toContain('line 7');
    expect(all).not.toContain('line 9');
  });
});
