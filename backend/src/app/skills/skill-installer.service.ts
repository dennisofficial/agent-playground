import { EnvService } from '@core/config/env/env.service';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { LocalGitService } from '../git/local-git.service';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import type { McpSurface, SkillUpdatePolicy } from '../persistence/entities';
import { parseSkillFrontmatter } from './skill-frontmatter';
import { skillDirHost } from './skill-store-paths';
import { type SkillView, WorkspaceSkillStore } from './workspace-skill.store';

interface MarketplaceManifest {
  plugins?: Array<{ source?: string; skills?: string[] }>;
}

export interface SkillInstallInput {
  orgId: string;
  scope: string;
  sourceUrl: string;
  ref?: string;
  subpath?: string;
  updatePolicy?: SkillUpdatePolicy;
  surfaces?: McpSurface[];
}

export interface SkillPreviewRow {
  name: string;
  description: string;
  overwrites: boolean;
}

@Injectable()
export class SkillInstallerService {
  private readonly logger = new Logger(SkillInstallerService.name);

  constructor(
    private readonly env: EnvService,
    private readonly git: LocalGitService,
    private readonly creds: CredentialResolver,
    private readonly store: WorkspaceSkillStore,
  ) {}

  private root(): string | undefined {
    return this.env.get('SKILLS_ROOT');
  }

  async install(input: SkillInstallInput): Promise<SkillView[]> {
    const token = await this.resolveToken(input.sourceUrl, input.orgId);
    const { ref, sha } = await this.git.resolveRemoteRef(input.sourceUrl, input.ref, token);

    const tmpDir = await mkdtemp(join(tmpdir(), 'atlas-skill-install-'));
    try {
      await this.git.shallowCloneToPath(input.sourceUrl, ref, tmpDir, token);
      const root = input.subpath ? join(tmpDir, input.subpath) : tmpDir;
      if (!existsSync(root)) {
        throw new BadRequestException(
          `subpath '${input.subpath}' not found in ${input.sourceUrl}@${ref}`,
        );
      }

      const manifestPath = join(root, '.claude-plugin', 'marketplace.json');
      if (existsSync(manifestPath)) {
        return await this.installMarketplace(input, tmpDir, root, manifestPath, ref, sha);
      }
      if (!existsSync(join(root, 'SKILL.md'))) {
        throw new BadRequestException(
          `no SKILL.md at '${input.subpath ?? '/'}' and no .claude-plugin/marketplace.json — ` +
            `${input.sourceUrl}@${ref} isn't a skill or a marketplace repo`,
        );
      }
      const skill = await this.vendorSkill(input, root, ref, sha, input.subpath ?? null);
      return [skill];
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch((err) =>
        this.logger.warn(`failed to clean up scratch clone ${tmpDir}: ${err}`),
      );
    }
  }

  async preview(input: SkillInstallInput): Promise<SkillPreviewRow[]> {
    const token = await this.resolveToken(input.sourceUrl, input.orgId);
    const { ref } = await this.git.resolveRemoteRef(input.sourceUrl, input.ref, token);
    const tmpDir = await mkdtemp(join(tmpdir(), 'atlas-skill-preview-'));
    try {
      await this.git.shallowCloneToPath(input.sourceUrl, ref, tmpDir, token);
      const root = input.subpath ? join(tmpDir, input.subpath) : tmpDir;
      if (!existsSync(root)) {
        throw new BadRequestException(
          `subpath '${input.subpath}' not found in ${input.sourceUrl}@${ref}`,
        );
      }
      if (existsSync(join(root, '.claude-plugin', 'marketplace.json'))) {
        throw new BadRequestException(
          `'${input.subpath ?? '/'}' is a marketplace root — point subpath at a single skill dir (one SKILL.md); ` +
            'whole-marketplace installs are owner-console only',
        );
      }
      if (!existsSync(join(root, 'SKILL.md'))) {
        throw new BadRequestException(
          `no SKILL.md at '${input.subpath ?? '/'}' in ${input.sourceUrl}@${ref} — not a single skill dir`,
        );
      }
      const frontmatter = parseSkillFrontmatter(readFileSync(join(root, 'SKILL.md'), 'utf8'));
      const name = sanitizeName(frontmatter.name ?? basename(root));
      const description =
        frontmatter.description ??
        `Installed from ${input.sourceUrl}${input.subpath ? `/${input.subpath}` : ''}`;
      const existing = await this.store.get(input.orgId, input.scope, name);
      return [{ name, description, overwrites: Boolean(existing) }];
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch((err) =>
        this.logger.warn(`failed to clean up preview clone ${tmpDir}: ${err}`),
      );
    }
  }

  private async installMarketplace(
    input: SkillInstallInput,
    cloneRoot: string,
    marketplaceRoot: string,
    manifestPath: string,
    ref: string,
    sha: string,
  ): Promise<SkillView[]> {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MarketplaceManifest;
    const results: SkillView[] = [];
    for (const plugin of manifest.plugins ?? []) {
      const pluginDir = join(marketplaceRoot, plugin.source ?? './');
      for (const skillRel of pluginSkillRels(plugin, pluginDir)) {
        const skillDir = join(pluginDir, skillRel);
        if (!existsSync(join(skillDir, 'SKILL.md'))) {
          this.logger.warn(`marketplace ${input.sourceUrl}: skipping '${skillRel}' — no SKILL.md`);
          continue;
        }
        const subpath = relative(cloneRoot, skillDir);
        results.push(await this.vendorSkill(input, skillDir, ref, sha, subpath));
      }
    }
    if (results.length === 0) {
      throw new BadRequestException(
        `marketplace manifest at ${manifestPath} listed no valid skills`,
      );
    }
    return results;
  }

  private async vendorSkill(
    input: SkillInstallInput,
    srcDir: string,
    ref: string,
    sha: string,
    subpath: string | null,
  ): Promise<SkillView> {
    const md = readFileSync(join(srcDir, 'SKILL.md'), 'utf8');
    const frontmatter = parseSkillFrontmatter(md);
    const name = sanitizeName(frontmatter.name ?? basename(srcDir));
    const description =
      frontmatter.description ?? `Installed from ${input.sourceUrl}${subpath ? `/${subpath}` : ''}`;

    const dest = skillDirHost(this.root(), input.orgId, input.scope, name);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(srcDir, dest, { recursive: true }); // full fidelity — binaries, scripts, nested dirs, all of it

    await this.store.write(input.orgId, input.scope, name, {
      description,
      provenance: 'git',
      source_url: input.sourceUrl,
      source_ref: ref,
      source_subpath: subpath,
      installed_sha: sha,
      update_policy: input.updatePolicy ?? 'track-ref',
      surfaces: input.surfaces,
      reviewForTypes: frontmatter.reviewForTypes,
      reviewForGlobs: frontmatter.reviewForGlobs,
      enabled: true,
    });
    this.logger.log(
      `installed skill '${name}' org=${input.orgId} scope=${input.scope} from ${input.sourceUrl}@${ref}`,
    );
    const view = await this.store.get(input.orgId, input.scope, name);
    if (!view)
      throw new Error(`skill '${name}' vanished immediately after write — should be unreachable`);
    return view;
  }

  private async resolveToken(sourceUrl: string, orgId: string): Promise<string | undefined> {
    if (!sourceUrl.startsWith('https://github.com/')) return undefined;
    return this.creds.hostGithubToken(orgId);
  }
}

function sanitizeName(name: string): string {
  return (
    name
      .trim()
      .replace(/[^a-z0-9_-]/gi, '-')
      .replace(/^-+|-+$/g, '') || 'skill'
  );
}

function pluginSkillRels(plugin: { skills?: string[] }, pluginDir: string): string[] {
  if (plugin.skills && plugin.skills.length > 0) return plugin.skills;
  const skillsDir = join(pluginDir, 'skills');
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md')))
    .map((e) => join('skills', e.name));
}
