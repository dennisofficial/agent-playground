import { EnvService } from '@core/config/env/env.service';
import { Injectable } from '@nestjs/common';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { pendingSkillDirHost, skillDirHost } from './skill-store-paths';

/**
 * Writes a CUSTOM skill's `SKILL.md` to the central host store — the minimal slice of "authoring" the
 * skills-registry reshape needs to keep `propose_skill`'s create-only flow WORKING (the `workspace_skills`
 * row is metadata-only; this is what actually persists the content). `writeSkillMd`/`readSkillBody` are
 * deliberately minimal (one file, no supporting `references/`/`scripts/`) — a skill NEEDING more than one
 * file is authored iteratively via `Edit`/`Write` under a `request_skill_edit_access` grant instead.
 * `forkSkillDir` (§P3 fork-to-custom) copies a whole dir, so it's full-fidelity by construction.
 */
@Injectable()
export class SkillFileWriter {
  constructor(private readonly env: EnvService) {}

  private root(): string | undefined {
    return this.env.get('SKILLS_ROOT');
  }

  /** Write (or overwrite) `<store>/…/<name>/SKILL.md` with a `description` frontmatter block + `body`. */
  writeSkillMd(
    orgId: string,
    scope: string,
    name: string,
    description: string,
    body: string,
  ): void {
    const dir = skillDirHost(this.root(), orgId, scope, name);
    mkdirSync(dir, { recursive: true });
    const frontmatter = `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\n---\n`;
    writeFileSync(join(dir, 'SKILL.md'), `${frontmatter}\n${body}\n`);
  }

  /** The current `SKILL.md` body (frontmatter stripped), or undefined when nothing's on disk yet — used
   *  to show the owner what an `update` proposal would replace (`WebSkillProposalCard.priorBody`). */
  readSkillBody(
    orgId: string,
    scope: string,
    name: string,
  ): string | undefined {
    const file = join(
      skillDirHost(this.root(), orgId, scope, name),
      'SKILL.md',
    );
    if (!existsSync(file)) return undefined;
    const raw = readFileSync(file, 'utf8');
    const match = /^---\n[\s\S]*?\n---\n/.exec(raw);
    return (match ? raw.slice(match[0].length) : raw).trim();
  }

  /** Remove a skill's whole dir (a `propose_skill_removal` approval). No-op if nothing's on disk. */
  removeSkillDir(orgId: string, scope: string, name: string): void {
    rmSync(skillDirHost(this.root(), orgId, scope, name), {
      recursive: true,
      force: true,
    });
  }

  /** Every FILE (not dir) under a skill's dir, as POSIX-style paths relative to its root, sorted — the
   *  console's read-only viewer file tree. Empty array if nothing's on disk (a registry row with no files
   *  yet, or one that's drifted from the store). */
  listSkillFiles(orgId: string, scope: string, name: string): string[] {
    const dir = skillDirHost(this.root(), orgId, scope, name);
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir, { recursive: true }) as string[];
    return entries
      .filter((rel) => statSync(join(dir, rel)).isFile())
      .map((rel) => rel.split(sep).join('/'))
      .sort();
  }

  /**
   * FREEZE a `propose_skill` draft: copy the whole authored draft dir (from the brain's writable
   * `/context/skill-drafts/<name>`) into the immutable, request-scoped `.pending/<orgId>/<requestId>`
   * staging dir the brain cannot touch, and return that staging path. Approval vendors from THIS copy, so
   * the owner reviews and installs exactly what existed at propose time (no TOCTOU on the live draft).
   */
  freezeDraft(srcDir: string, orgId: string, requestId: string): string {
    const dest = pendingSkillDirHost(this.root(), orgId, requestId);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(srcDir, dest, { recursive: true });
    return dest;
  }

  /** Remove a proposal's frozen staging dir (on approve OR dismiss). No-op if nothing's there. */
  removeStaging(orgId: string, requestId: string): void {
    rmSync(pendingSkillDirHost(this.root(), orgId, requestId), {
      recursive: true,
      force: true,
    });
  }

  /** Vendor an already-authored skill dir (the frozen staging copy) into the durable store at
   *  `(orgId, scope, name)`, full fidelity — the `propose_skill` approval's write path (replaces the old
   *  single-file `writeSkillMd(body)` create). Overwrites any prior copy at that name. */
  vendorDir(srcDir: string, orgId: string, scope: string, name: string): void {
    const dest = skillDirHost(this.root(), orgId, scope, name);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(srcDir, dest, { recursive: true });
  }

  /** A read-only preview of an authored skill dir (the frozen staging copy) for the owner's approve card:
   *  the `SKILL.md` text + every file path (POSIX-relative, sorted). null when the dir has no `SKILL.md`. */
  previewDir(dir: string): { skillMd: string; files: string[] } | null {
    const skillMd = join(dir, 'SKILL.md');
    if (!existsSync(skillMd)) return null;
    const entries = existsSync(dir)
      ? (readdirSync(dir, { recursive: true }) as string[])
      : [];
    const files = entries
      .filter((rel) => statSync(join(dir, rel)).isFile())
      .map((rel) => rel.split(sep).join('/'))
      .sort();
    return { skillMd: readFileSync(skillMd, 'utf8'), files };
  }

  /**
   * Fork-to-custom: copy a `git`-provenance skill's WHOLE dir (full fidelity — references, scripts,
   * binaries) to a new name in the SAME scope, so the original stays untouched (clean + updatable) while
   * the fork becomes the brain's edit target (`request_skill_edit_access`'s approval flow). Rewrites the
   * copy's `SKILL.md` frontmatter `name:` line to `toName` (a stale `name:` would make the SDK-visible
   * identity disagree with the on-disk dir it's symlinked as). No-op-safe on a missing source (nothing to
   * fork — the caller's registry write is the one that would fail loudly instead).
   */
  forkSkillDir(
    orgId: string,
    scope: string,
    fromName: string,
    toName: string,
  ): void {
    const src = skillDirHost(this.root(), orgId, scope, fromName);
    if (!existsSync(src)) return;
    const dest = skillDirHost(this.root(), orgId, scope, toName);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    const skillMd = join(dest, 'SKILL.md');
    if (existsSync(skillMd)) {
      const raw = readFileSync(skillMd, 'utf8');
      // Rewrite ONLY a `name:` line inside the frontmatter block (between the two `---` fences) — never
      // touch a line that merely starts with "name:" in the body. `block[0]` is the exact matched fence
      // substring at its found position, so a plain `replace` (first-occurrence) targets just that block.
      const block = /^---\r?\n[\s\S]*?\r?\n---/.exec(raw);
      if (block && /^name:.*$/m.test(block[0])) {
        writeFileSync(
          skillMd,
          raw.replace(
            block[0],
            block[0].replace(/^name:.*$/m, `name: ${toName}`),
          ),
        );
      }
    }
  }
}
