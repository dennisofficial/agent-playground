import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { WebSurfaceController } from './web-surface.controller';

/**
 * The owner-gated `skill-proposals/:id/approve` endpoint — the ONLY place a brain skill write lands. Covers
 * the three modes: `install` (routes to the git installer), `create` (vendors the FROZEN staging copy, not
 * the live draft, and clears the draft), and `remove`. Pure unit — mocked collaborators; the owner guard is
 * asserted via route metadata (Nest applies it, not exercised in a direct call).
 */
const OWNER = { id: 'org-1', role: 'owner' } as unknown as CurrentOrgCtx;
const ALL_SURFACES = ['brain', 'build', 'review'];

function makeController(card: unknown, ctxRoot: string) {
  const m = {
    seedSystemNotification: vi.fn(() => 'ts-1'),
    getSkillProposalCard: vi.fn(async () => card),
    markSkillProposalApproved: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    vendorDir: vi.fn(() => undefined),
    removeStaging: vi.fn(() => undefined),
    removeSkillDir: vi.fn(() => undefined),
    install: vi.fn(async () => [{ name: 'x' }]),
  };
  const threads = {
    findOne: vi.fn(
      async ({ where }: { where: { id: string; org_id: string } }) => ({
        id: where.id,
        org_id: where.org_id,
        repo_id: 'repo-1',
      }),
    ),
  };
  const controller = new WebSurfaceController(
    { seedSystemNotification: m.seedSystemNotification, name: 'web' } as never, // surface
    {} as never, // liveTurns
    {} as never, // driverStore
    { contextDirHost: () => ctxRoot } as never, // threadLifecycle
    {} as never, // autoMerge
    {} as never, // orgService
    threads as never,
    {} as never, // messages
    {} as never, // repos
    {} as never, // threadTitle
    {} as never, // usageBus
    { available: false } as never, // realtime
    {} as never, // election
    {} as never, // dispatcher
    {} as never, // secrets
    {
      getSkillProposalCard: m.getSkillProposalCard,
      markSkillProposalApproved: m.markSkillProposalApproved,
    } as never, // store
    {} as never, // brain
    {} as never, // mcpStore
    {} as never, // mcpProbe
    {} as never, // conventions
    { write: m.write, delete: m.delete } as never, // skillStore
    {
      vendorDir: m.vendorDir,
      removeStaging: m.removeStaging,
      removeSkillDir: m.removeSkillDir,
    } as never, // skillFiles
    { install: m.install } as never, // skillInstaller
    {} as never, // git (LocalGitService)
    {} as never, // jobDeps (JobDependencyService)
    {} as never, // moduleRef (ModuleRef)
  );
  return { controller, m };
}

describe('WebSurfaceController — skill proposal approve (owner-gated)', () => {
  let ctxRoot: string;
  let staging: string;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'atlas-skill-ctx-'));
    staging = mkdtempSync(join(tmpdir(), 'atlas-skill-staging-'));
  });
  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  });

  it('is guarded by OrgOwnerGuard', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      WebSurfaceController.prototype.approveSkillProposal,
    ) as unknown[];
    expect(guards).toContain(OrgOwnerGuard);
  });

  it('install mode routes to SkillInstallerService.install with the card source fields + all surfaces', async () => {
    const card = {
      type: 'skill_proposal_card',
      mode: 'install',
      scope: 'repo',
      repoId: 'repo-1',
      name: 'nestjs',
      description: '',
      sourceUrl: 'https://github.com/anthropics/skills',
      sourceRef: 'main',
      sourceSubpath: 'skills/nestjs',
    };
    const { controller, m } = makeController(card, ctxRoot);
    const res = await controller.approveSkillProposal(
      OWNER,
      'job-1',
      'skill-1',
    );

    expect(res.ok).toBe(true);
    expect(m.install).toHaveBeenCalledWith({
      orgId: 'org-1',
      scope: 'repo-1',
      sourceUrl: 'https://github.com/anthropics/skills',
      ref: 'main',
      subpath: 'skills/nestjs',
      surfaces: ALL_SURFACES,
    });
    expect(m.markSkillProposalApproved).toHaveBeenCalled();
  });

  it(
    'create mode vendors the FROZEN staging copy (not the live draft), writes a custom all-surfaces row, ' +
      'and clears the /context draft',
    async () => {
      writeFileSync(
        join(staging, 'SKILL.md'),
        '---\nname: house-x\ndescription: Use when X\n---\nBody.\n',
      );
      const draftDir = join(ctxRoot, 'skill-drafts', 'house-x');
      mkdirSync(draftDir, { recursive: true });
      writeFileSync(
        join(draftDir, 'SKILL.md'),
        'stale draft the brain kept editing',
      );

      const card = {
        type: 'skill_proposal_card',
        mode: 'create',
        scope: 'org',
        repoId: 'repo-1',
        name: 'house-x',
        description: 'Use when X',
        stagingPath: staging,
      };
      const { controller, m } = makeController(card, ctxRoot);
      await controller.approveSkillProposal(OWNER, 'job-1', 'skill-2');

      // Vendors from the frozen staging dir, org scope ('*').
      expect(m.vendorDir).toHaveBeenCalledWith(
        staging,
        'org-1',
        '*',
        'house-x',
      );
      expect(m.write).toHaveBeenCalledWith('org-1', '*', 'house-x', {
        description: 'Use when X',
        provenance: 'custom',
        surfaces: ALL_SURFACES,
      });
      expect(m.removeStaging).toHaveBeenCalledWith('org-1', 'skill-2');
      // The now-stale /context draft is removed so later edits go to the durable store.
      expect(existsSync(draftDir)).toBe(false);
    },
  );

  it('remove mode deletes the row + the skill dir', async () => {
    const card = {
      type: 'skill_proposal_card',
      mode: 'remove',
      scope: 'repo',
      repoId: 'repo-1',
      name: 'old',
      description: '',
    };
    const { controller, m } = makeController(card, ctxRoot);
    await controller.approveSkillProposal(OWNER, 'job-1', 'skill-3');

    expect(m.delete).toHaveBeenCalledWith('org-1', 'repo-1', 'old');
    expect(m.removeSkillDir).toHaveBeenCalledWith('org-1', 'repo-1', 'old');
    expect(m.install).not.toHaveBeenCalled();
  });
});
