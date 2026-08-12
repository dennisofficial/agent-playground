import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { EAtlasTool } from '../../domain/tool-surface.js';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import type { ContextEntry, ContextFolderService } from '../context-folder.service.js';
import {
  EMissingAttachment,
  describeAttachments,
  gatherAttachments,
} from '../tools/attach.js';
import { atlasToolsFor } from '../tools/registry.js';
import { cleanupWorlds, world } from './advance-phase.fixture.js';

/**
 * A file the agent named that is not there.
 *
 * The failure this guards against is the quiet one: the successor is handed a hand-off that says
 * "see the slice spec", the slice spec was never inlined, and nothing anywhere says so — it shows up
 * hours later as a thread that mysteriously does not know something. So the seam refuses while the
 * agent still has the turn to fix the name, and delivery time reports instead, because by then there
 * is nobody left to fix anything and sinking Dennis's confirmation would be the worse answer.
 */

const ROOTS: string[] = [];

/** A listing that can name a file the disk does not have, which is the mid-gather race. */
function entries(
  refs: readonly { bucket: string; path: string }[],
): ContextEntry[] {
  return refs.map((ref) => ({
    ...ref,
    bytes: 1,
    modifiedAt: new Date(0),
    isDirectory: false,
  })) as ContextEntry[];
}

function gathererOver(args: {
  files: Record<string, string>;
  listing: readonly { bucket: string; path: string }[];
}): ContextFolderService {
  const root = mkdtempSync(join(tmpdir(), 'atlas-attach-missing-'));
  ROOTS.push(root);
  mkdirSync(join(root, 'specs'), { recursive: true });
  mkdirSync(join(root, 'charting'), { recursive: true });
  for (const [path, body] of Object.entries(args.files)) {
    writeFileSync(join(root, path), body);
  }
  return {
    list: (): ContextEntry[] => entries(args.listing),
    resolveInside: (ref: { relativePath: string }): string =>
      join(root, ref.relativePath),
  } as unknown as ContextFolderService;
}

afterEach(() => {
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(cleanupWorlds);

describe('gatherAttachments, on a declared file that is not there', () => {
  it('refuses by default, naming the file — the seam is where the mistake can still be fixed', () => {
    const contextFolderService = gathererOver({
      files: { 'specs/plan.md': 'the plan' },
      listing: [{ bucket: 'specs', path: 'plan.md' }],
    });

    expect(() =>
      gatherAttachments({
        contextFolderService,
        jobId: 'job-1',
        phase: EPhaseKind.build,
        declared: ['specs/gone.md'],
      }),
    ).toThrow('context/specs/gone.md');
  });

  it('reports instead when asked to, so a confirmation hours later still lands', () => {
    const contextFolderService = gathererOver({
      files: { 'specs/plan.md': 'the plan' },
      listing: [{ bucket: 'specs', path: 'plan.md' }],
    });

    const gathered = gatherAttachments({
      contextFolderService,
      jobId: 'job-1',
      phase: EPhaseKind.build,
      declared: ['specs/gone.md'],
      onMissing: EMissingAttachment.report,
    });

    expect(gathered.missing.map((ref) => ref.path)).toEqual(['gone.md']);
    // Told, never dropped: a successor that knows something was meant to be here can go and look.
    expect(gathered.text).toContain('MISSING');
    expect(gathered.parts.find((part) => part.label.endsWith('gone.md'))?.body).toBeNull();
    // And the reply stops claiming it as attached, which is the silent drop one layer up.
    const described = describeAttachments(gathered);
    expect(described).toContain('MISSING, not attached: context/specs/gone.md');
    expect(described).not.toContain('attached context/specs/gone.md');
  });

  it('does NOT refuse over a FLOOR file that vanished mid-gather — that is a race, not a mistake', () => {
    // The listing names it; the disk does not have it. Nobody declared it, so nobody can fix it, and
    // refusing here would let one tidied-up file block every advance out of the phase.
    const contextFolderService = gathererOver({
      files: { 'specs/plan.md': 'the plan' },
      listing: [
        { bucket: 'specs', path: 'plan.md' },
        { bucket: 'specs', path: 'swept.md' },
      ],
    });

    const gathered = gatherAttachments({
      contextFolderService,
      jobId: 'job-1',
      phase: EPhaseKind.build,
      declared: [],
    });

    expect(gathered.missing).toEqual([]);
    expect(gathered.text).toContain('the plan');
    expect(gathered.text).toContain('MISSING');
  });

  it('carries the manifest beside the inlined text, sized and counted', () => {
    const contextFolderService = gathererOver({
      files: { 'specs/plan.md': 'the plan\nin two lines' },
      listing: [{ bucket: 'specs', path: 'plan.md' }],
    });

    const gathered = gatherAttachments({
      contextFolderService,
      jobId: 'job-1',
      phase: EPhaseKind.build,
      declared: [],
    });

    expect(gathered.parts).toEqual([
      {
        label: 'context/specs/plan.md',
        lines: 2,
        bytes: 21,
        body: 'the plan\nin two lines',
      },
    ]);
  });
});

describe('every seam tool declares what it hands over', () => {
  /**
   * Required, across the whole surface at once rather than tool by tool: the outgoing thread always
   * says what the incoming one reads, so `[]` is a statement and an omission is not. The floor still
   * sits underneath — a declaration adds to it and never replaces it — so the cost of the discipline
   * is nothing, and relaxing it later is one word where re-adding it after agents have been trained
   * to declare everything is not.
   */
  it.each([
    [EAtlasTool.advance_thread],
    [EAtlasTool.advance_phase],
    [EAtlasTool.open_thread],
  ])('%s requires attach', (name) => {
    const { service, ctx } = world();
    const tool = atlasToolsFor({ ctx, actions: service }).find(
      (candidate) => candidate.name === name,
    );
    const attach = tool?.shape['attach'];

    expect(attach).toBeDefined();
    expect(attach && z.object({ attach }).safeParse({}).success).toBe(false);
  });

  it('rotate takes attach and does not require it — the one deliberate exception', () => {
    // Rotation is the same agent, one leg later: it is already holding whatever it declared on the
    // way in, so a required declaration would be a ceremony against itself.
    const { service, ctx } = world();
    const rotate = atlasToolsFor({ ctx, actions: service }).find(
      (candidate) => candidate.name === EAtlasTool.rotate,
    );
    const attach = rotate?.shape['attach'];

    expect(attach).toBeDefined();
    expect(attach && z.object({ attach }).safeParse({}).success).toBe(true);
  });
});

describe('the seam refuses before it moves anything', () => {
  it('advance_phase writes NO proposal when an attachment does not exist', async () => {
    const { service, ctx, rows, turns } = world();

    await expect(
      service.advancePhase({
        ctx,
        kind: EPhaseKind.build,
        reason: 'done',
        handoff: 'go',
        attach: ['specs/never-written.md'],
      }),
    ).rejects.toThrow('cannot attach');

    // The whole point of gathering before raising: Dennis is never asked to confirm a hand-off that
    // has already lost half of what it promised.
    expect(rows).toEqual([]);
    expect(turns).toEqual([]);
  });

  it('advance_thread closes nothing when an attachment does not exist', async () => {
    const { service, ctx, threads, closed } = world();

    await expect(
      service.advanceThread({
        ctx,
        role: EThreadRole.planner,
        handoff: 'go',
        attach: ['specs/never-written.md'],
      }),
    ).rejects.toThrow('cannot attach');

    expect(closed).toEqual([]);
    expect(threads).toHaveLength(1);
  });
});
