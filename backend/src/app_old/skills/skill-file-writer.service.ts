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

@Injectable()
export class SkillFileWriter {
  constructor(private readonly env: EnvService) {}

  private root(): string | undefined {
    return this.env.get('SKILLS_ROOT');
  }

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

  readSkillBody(orgId: string, scope: string, name: string): string | undefined {
    const file = join(skillDirHost(this.root(), orgId, scope, name), 'SKILL.md');
    if (!existsSync(file)) return undefined;
    const raw = readFileSync(file, 'utf8');
    const match = /^---\n[\s\S]*?\n---\n/.exec(raw);
    return (match ? raw.slice(match[0].length) : raw).trim();
  }

  removeSkillDir(orgId: string, scope: string, name: string): void {
    rmSync(skillDirHost(this.root(), orgId, scope, name), {
      recursive: true,
      force: true,
    });
  }

  listSkillFiles(orgId: string, scope: string, name: string): string[] {
    const dir = skillDirHost(this.root(), orgId, scope, name);
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir, { recursive: true }) as string[];
    return entries
      .filter((rel) => statSync(join(dir, rel)).isFile())
      .map((rel) => rel.split(sep).join('/'))
      .sort();
  }

  freezeDraft(srcDir: string, orgId: string, requestId: string): string {
    const dest = pendingSkillDirHost(this.root(), orgId, requestId);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(srcDir, dest, { recursive: true });
    return dest;
  }

  removeStaging(orgId: string, requestId: string): void {
    rmSync(pendingSkillDirHost(this.root(), orgId, requestId), {
      recursive: true,
      force: true,
    });
  }

  vendorDir(srcDir: string, orgId: string, scope: string, name: string): void {
    const dest = skillDirHost(this.root(), orgId, scope, name);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(srcDir, dest, { recursive: true });
  }

  previewDir(dir: string): { skillMd: string; files: string[] } | null {
    const skillMd = join(dir, 'SKILL.md');
    if (!existsSync(skillMd)) return null;
    const entries = existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]) : [];
    const files = entries
      .filter((rel) => statSync(join(dir, rel)).isFile())
      .map((rel) => rel.split(sep).join('/'))
      .sort();
    return { skillMd: readFileSync(skillMd, 'utf8'), files };
  }

  forkSkillDir(orgId: string, scope: string, fromName: string, toName: string): void {
    const src = skillDirHost(this.root(), orgId, scope, fromName);
    if (!existsSync(src)) return;
    const dest = skillDirHost(this.root(), orgId, scope, toName);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    const skillMd = join(dest, 'SKILL.md');
    if (existsSync(skillMd)) {
      const raw = readFileSync(skillMd, 'utf8');
      const block = /^---\r?\n[\s\S]*?\r?\n---/.exec(raw);
      if (block && /^name:.*$/m.test(block[0])) {
        writeFileSync(
          skillMd,
          raw.replace(block[0], block[0].replace(/^name:.*$/m, `name: ${toName}`)),
        );
      }
    }
  }
}
