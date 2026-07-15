import { EnvService } from '@core/config/env/env.service';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { LocalGitService } from '../git/local-git.service';
import { CredentialResolver } from '../onboarding';
import type { McpSurface, SkillUpdatePolicy } from '../persistence/entities';
import { parseSkillFrontmatter } from './skill-frontmatter';
import { skillDirHost } from './skill-store-paths';
import { type SkillView, WorkspaceSkillStore } from './workspace-skill.store';

/** One `.claude-plugin/marketplace.json` — see `anthropics/skills` and the operator's
 *  `context-engineering-collection` for real examples. `skills` is usually an explicit list, but the plugin
 *  spec also allows omitting it entirely and letting consumers scan the plugin's `skills/` subdir (see
 *  `pluginSkillRels`). Only the fields the installer reads; the rest (owner/metadata/strict…) are ignored. */
interface MarketplaceManifest {
  plugins?: Array<{ source?: string; skills?: string[] }>;
}

export interface SkillInstallInput {
  orgId: string;
  /** DB scope — `'*'` (org-wide) or a repo id. Already resolved/validated by the caller (the controller). */
  scope: string;
  sourceUrl: string;
  /** Branch/tag to install. Omitted → the remote's default branch. */
  ref?: string;
  /** Subpath within the repo — a single skill dir, OR a dir containing `.claude-plugin/marketplace.json`. */
  subpath?: string;
  updatePolicy?: SkillUpdatePolicy;
  surfaces?: McpSurface[];
}

/** One row of a {@link SkillInstallerService.preview} dry-run — the REAL name/description that would be
 *  vendored (resolved from the source SKILL.md frontmatter, not a caller guess) + whether it would
 *  overwrite an existing skill of the same name in the target scope. */
export interface SkillPreviewRow {
  name: string;
  description: string;
  overwrites: boolean;
}

/**
 * Installs skills from a git repo into the central host skills store (§3 of the skills-redesign plan).
 * Shallow-clones `sourceUrl@ref` to a scratch temp dir, vendors (copies — never a submodule) either ONE
 * skill dir or, for a marketplace repo, every skill dir its manifest lists, and upserts a `workspace_skills`
 * registry row per skill with `provenance:'git'` + the source/sha it landed on. Reused unchanged by
 * `SkillUpdaterService` for re-vendoring on update.
 */
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

  /** Install (or re-install, on update) `input.sourceUrl` — returns every vendored skill's registry row. */
  async install(input: SkillInstallInput): Promise<SkillView[]> {
    const token = await this.resolveToken(input.sourceUrl, input.orgId);
    const { ref, sha } = await this.git.resolveRemoteRef(
      input.sourceUrl,
      input.ref,
      token,
    );

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
        // MUST be `await`ed here — a bare `return this.installMarketplace(...)` inside this try/finally
        // returns the pending promise WITHOUT waiting on it, so the `finally` below starts deleting
        // `tmpDir` while the expansion loop below is still reading skill dirs out of it. With a slow
        // enough per-skill DB round trip (real Postgres, not a test's in-memory fake) the cleanup wins
        // the race and every skill after the first reports "no SKILL.md" — exactly what happened
        // installing the real `anthropics/skills` marketplace (17 skills in the manifest, 1 vendored).
        return await this.installMarketplace(
          input,
          tmpDir,
          root,
          manifestPath,
          ref,
          sha,
        );
      }
      if (!existsSync(join(root, 'SKILL.md'))) {
        throw new BadRequestException(
          `no SKILL.md at '${input.subpath ?? '/'}' and no .claude-plugin/marketplace.json — ` +
            `${input.sourceUrl}@${ref} isn't a skill or a marketplace repo`,
        );
      }
      const skill = await this.vendorSkill(
        input,
        root,
        ref,
        sha,
        input.subpath ?? null,
      );
      return [skill];
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch((err) =>
        this.logger.warn(`failed to clean up scratch clone ${tmpDir}: ${err}`),
      );
    }
  }

  /**
   * Read-only dry-run of a SINGLE-skill install — clones, reads the source `SKILL.md` frontmatter for the
   * REAL name + description that `install` would vendor, and checks whether that name already exists in the
   * target scope (would be overwritten). Rejects a marketplace-root subpath: the brain's
   * `propose_skill_install` is single-skill only, so the owner's approve card is exactly 1:1 with what
   * lands. Whole-marketplace installs stay on the owner-console `POST /skills/install` path. Writes nothing.
   */
  async preview(input: SkillInstallInput): Promise<SkillPreviewRow[]> {
    const token = await this.resolveToken(input.sourceUrl, input.orgId);
    const { ref } = await this.git.resolveRemoteRef(
      input.sourceUrl,
      input.ref,
      token,
    );
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
      const frontmatter = parseSkillFrontmatter(
        readFileSync(join(root, 'SKILL.md'), 'utf8'),
      );
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

  /** Expand a marketplace repo's `plugins[].skills[]` into one vendored skill dir + row per entry. */
  private async installMarketplace(
    input: SkillInstallInput,
    cloneRoot: string,
    marketplaceRoot: string,
    manifestPath: string,
    ref: string,
    sha: string,
  ): Promise<SkillView[]> {
    const manifest = JSON.parse(
      readFileSync(manifestPath, 'utf8'),
    ) as MarketplaceManifest;
    const results: SkillView[] = [];
    for (const plugin of manifest.plugins ?? []) {
      const pluginDir = join(marketplaceRoot, plugin.source ?? './');
      for (const skillRel of pluginSkillRels(plugin, pluginDir)) {
        const skillDir = join(pluginDir, skillRel);
        if (!existsSync(join(skillDir, 'SKILL.md'))) {
          this.logger.warn(
            `marketplace ${input.sourceUrl}: skipping '${skillRel}' — no SKILL.md`,
          );
          continue;
        }
        // Store the subpath relative to the CLONE ROOT (not the marketplace root) so a re-install with the
        // same `input.subpath` finds the manifest again, and the updater's re-expand walks the same tree.
        const subpath = relative(cloneRoot, skillDir);
        results.push(
          await this.vendorSkill(input, skillDir, ref, sha, subpath),
        );
      }
    }
    if (results.length === 0) {
      throw new BadRequestException(
        `marketplace manifest at ${manifestPath} listed no valid skills`,
      );
    }
    return results;
  }

  /** Copy one skill dir into the central store + upsert its registry row. Overwrites any prior copy. */
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
      frontmatter.description ??
      `Installed from ${input.sourceUrl}${subpath ? `/${subpath}` : ''}`;

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
      throw new Error(
        `skill '${name}' vanished immediately after write — should be unreachable`,
      );
    return view;
  }

  /** Anonymous for public repos / non-GitHub remotes; the org's PAT for private GitHub repos. */
  private async resolveToken(
    sourceUrl: string,
    orgId: string,
  ): Promise<string | undefined> {
    if (!sourceUrl.startsWith('https://github.com/')) return undefined;
    return this.creds.hostGithubToken(orgId);
  }
}

/** Never let a derived name (frontmatter or dir-basename, both untrusted repo content) escape the store's
 *  path segment or collide with the registry's PK shape. */
function sanitizeName(name: string): string {
  return (
    name
      .trim()
      .replace(/[^a-z0-9_-]/gi, '-')
      .replace(/^-+|-+$/g, '') || 'skill'
  );
}

/**
 * A plugin's skill paths (relative to `pluginDir`), covering both real-world marketplace shapes: an
 * explicit `skills: ["./skills/foo", …]` list (`anthropics/skills`, `context-engineering-collection`), or
 * — when a plugin omits `skills` entirely — the plugin-spec convention of a `skills/` subdir where every
 * child directory containing a `SKILL.md` IS a skill (github.com/anthropics/claude-code plugin marketplace
 * spec). A present-but-empty `skills: []` is treated as "none" (explicit opt-out), not a signal to scan.
 */
function pluginSkillRels(
  plugin: { skills?: string[] },
  pluginDir: string,
): string[] {
  if (plugin.skills && plugin.skills.length > 0) return plugin.skills;
  const skillsDir = join(pluginDir, 'skills');
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md')),
    )
    .map((e) => join('skills', e.name));
}
