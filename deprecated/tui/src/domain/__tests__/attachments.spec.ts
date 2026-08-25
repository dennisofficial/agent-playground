import { describe, expect, it } from 'bun:test';
import type { ContextFileRef } from '../phase-spec.js';
import {
  attachmentChip,
  attachmentExpandKey,
  attachmentLabel,
  attachmentParts,
  mergeAttachments,
  parseContextRef,
  renderAttachmentParts,
  renderAttachments,
} from '../attachments.js';
import { EThreadRole } from '../../generated/prisma/enums.js';
import { successorSeed } from '../thread-handoff.js';

describe('parseContextRef', () => {
  it('accepts every form the agent will honestly type', () => {
    const expected: ContextFileRef = { bucket: 'specs', path: '03-slice.md' };
    expect(parseContextRef('specs/03-slice.md')).toEqual(expected);
    expect(parseContextRef('context/specs/03-slice.md')).toEqual(expected);
    expect(parseContextRef('./specs/03-slice.md')).toEqual(expected);
    expect(parseContextRef('  specs/03-slice.md  ')).toEqual(expected);
  });

  it('keeps nested paths inside a bucket — artifacts/ is where bundles live', () => {
    expect(parseContextRef('artifacts/design/tokens.json')).toEqual({
      bucket: 'artifacts',
      path: 'design/tokens.json',
    });
  });

  it('refuses an unknown bucket rather than guessing — that is a typo or an invention', () => {
    expect(parseContextRef('generated/handoff.md')).toBeNull();
    expect(parseContextRef('README.md')).toBeNull();
    expect(parseContextRef('specs/')).toBeNull();
  });
});

describe('mergeAttachments', () => {
  it('puts the phase floor first, then the declaration — orientation before specifics', () => {
    const merged = mergeAttachments({
      floor: [{ bucket: 'specs', path: 'spec.md' }],
      declared: [{ bucket: 'specs', path: '03-slice.md' }],
    });
    expect(merged.map(attachmentLabel)).toEqual([
      'context/specs/spec.md',
      'context/specs/03-slice.md',
    ]);
  });

  it('never inlines the same file twice when the agent re-declares the floor', () => {
    const merged = mergeAttachments({
      floor: [{ bucket: 'specs', path: 'spec.md' }],
      declared: [{ bucket: 'specs', path: 'spec.md' }],
    });
    expect(merged.length).toBe(1);
  });

  it('keeps the floor even when the agent declares nothing — a forgotten attachment is silent', () => {
    const merged = mergeAttachments({
      floor: [{ bucket: 'charting', path: 'map.md' }],
      declared: [],
    });
    expect(merged.map(attachmentLabel)).toEqual(['context/charting/map.md']);
  });
});

describe('renderAttachments', () => {
  it('inlines the whole body — Read truncates silently, and a lost tail is a failure nobody sees', () => {
    const rendered = renderAttachments([
      { ref: { bucket: 'specs', path: 'spec.md' }, body: 'line one\nline two' },
    ]);
    expect(rendered).toContain('context/specs/spec.md (2 lines)');
    expect(rendered).toContain('line one\nline two');
    expect(rendered).toContain('--- end context/specs/spec.md ---');
  });

  it('reports a missing file rather than dropping it — the successor can go and look', () => {
    const rendered = renderAttachments([
      { ref: { bucket: 'specs', path: 'gone.md' }, body: null },
    ]);
    expect(rendered).toContain('MISSING');
  });

  it('is empty when nothing is attached, so the seed grows no empty heading', () => {
    expect(renderAttachments([])).toBe('');
  });
});

describe('the attachment manifest', () => {
  it('counts lines and BYTES, so a chip does not under-report a file full of ’ and —', () => {
    const [part] = attachmentParts([
      { ref: { bucket: 'specs', path: 'spec.md' }, body: 'one\ntwo — ’' },
    ]);
    expect(part?.label).toBe('context/specs/spec.md');
    expect(part?.lines).toBe(2);
    // 9 ASCII characters, plus a 3-byte em dash and a 3-byte right quote.
    expect(part?.bytes).toBe(15);
  });

  it('composes the SAME wire form the inlining path always produced', () => {
    const files = [
      { ref: { bucket: 'specs', path: 'spec.md' } as const, body: 'plan\nmore' },
      { ref: { bucket: 'specs', path: 'gone.md' } as const, body: null },
    ];
    // The stored parts and the string the model receives are two views of one list, and this is the
    // assertion that keeps them that way — the manifest is not a second, drifting copy.
    expect(renderAttachmentParts(attachmentParts(files))).toBe(renderAttachments(files));
  });

  it('keeps the whole body, because expanding a chip must not re-read a file that has moved on', () => {
    const [part] = attachmentParts([
      { ref: { bucket: 'specs', path: 'spec.md' }, body: 'first\nsecond' },
    ]);
    expect(part?.body).toBe('first\nsecond');
  });
});

describe('attachmentChip', () => {
  it('drops the shared prefix and sizes the file the way a reader asks about it', () => {
    const [part] = attachmentParts([
      { ref: { bucket: 'specs', path: 'spec.md' }, body: `${'x'.repeat(5_500)}\ny` },
    ]);
    expect(part && attachmentChip(part)).toBe('specs/spec.md (2 lines) 5.4 KB');
  });

  it('measures a small file in bytes rather than claiming 0 KB', () => {
    const [part] = attachmentParts([
      { ref: { bucket: 'charting', path: 'map.md' }, body: 'tiny' },
    ]);
    expect(part && attachmentChip(part)).toBe('charting/map.md (1 line) 4 B');
  });

  it('still draws a chip for a file that was not there — a silent drop is the failure', () => {
    const [part] = attachmentParts([
      { ref: { bucket: 'specs', path: 'gone.md' }, body: null },
    ]);
    expect(part && attachmentChip(part)).toBe('specs/gone.md — missing');
  });
});

describe('attachmentExpandKey', () => {
  it('namespaces the key so a manifest can share the transcript’s one expansion set', () => {
    // A `toolUseId` is what else lives in that set; the prefix is what stops the two colliding.
    expect(attachmentExpandKey('m-1')).toBe('attach:m-1');
    expect(attachmentExpandKey('m-1')).not.toBe('m-1');
  });
});

describe('successorSeed', () => {
  it('orients, then hands over, then attaches', () => {
    const seed = successorSeed({
      opening: 'You are building against the specs.',
      handoff: 'Slice 2 is done. Tried a shared cache, rejected it.',
      fromRole: EThreadRole.builder,
      attachments: '# Attached\n\n--- context/specs/spec.md (1 line) ---\nplan\n--- end context/specs/spec.md ---',
    });

    expect(seed.indexOf('You are building')).toBeLessThan(seed.indexOf('Hand-off from'));
    expect(seed.indexOf('Hand-off from')).toBeLessThan(seed.indexOf('# Attached'));
    expect(seed).toContain('builder thread before you');
    expect(seed).toContain('Tried a shared cache, rejected it.');
  });

  it('leaves no empty section behind when nothing was attached', () => {
    const seed = successorSeed({
      opening: 'Opening.',
      handoff: 'Done.',
      fromRole: EThreadRole.planner,
      attachments: '',
    });
    expect(seed.endsWith('Done.')).toBe(true);
  });
});
