import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillFileWriter } from './skill-file-writer.service';
import { skillDirHost } from './skill-store-paths';

describe('SkillFileWriter — forkSkillDir (fork-to-custom)', () => {
  let storeRoot: string;
  let writer: SkillFileWriter;

  beforeEach(() => {
    storeRoot = mkdtempSync(join(tmpdir(), 'atlas-skill-fork-'));
    const env = { get: (key: string) => (key === 'SKILLS_ROOT' ? storeRoot : undefined) } as never;
    writer = new SkillFileWriter(env);
  });

  afterEach(() => rmSync(storeRoot, { recursive: true, force: true }));

  it('copies the whole dir (multi-file, full fidelity) to the new name and rewrites the frontmatter name', () => {
    const src = skillDirHost(storeRoot, 'org1', '*', 'aws-cdk');
    mkdirSync(join(src, 'references'), { recursive: true });
    writeFileSync(
      join(src, 'SKILL.md'),
      '---\nname: aws-cdk\ndescription: Use when deploying CDK stacks\n---\n\nBody text.\n',
    );
    writeFileSync(join(src, 'references', 'x.md'), '# reference\n');

    writer.forkSkillDir('org1', '*', 'aws-cdk', 'aws-cdk-custom');

    const dest = skillDirHost(storeRoot, 'org1', '*', 'aws-cdk-custom');
    expect(existsSync(join(dest, 'references', 'x.md'))).toBe(true);
    const forkedMd = readFileSync(join(dest, 'SKILL.md'), 'utf8');
    expect(forkedMd).toContain('name: aws-cdk-custom');
    expect(forkedMd).toContain('description: Use when deploying CDK stacks');
    expect(forkedMd).toContain('Body text.');

    // The original is untouched — still named `aws-cdk`, still in place (stays clean + updatable).
    const originalMd = readFileSync(join(src, 'SKILL.md'), 'utf8');
    expect(originalMd).toContain('name: aws-cdk');
    expect(existsSync(join(src, 'references', 'x.md'))).toBe(true);
  });

  it('is a no-op when the source skill has nothing on disk', () => {
    writer.forkSkillDir('org1', '*', 'missing-skill', 'missing-skill-custom');
    expect(existsSync(skillDirHost(storeRoot, 'org1', '*', 'missing-skill-custom'))).toBe(false);
  });

  it('leaves a SKILL.md with no `name:` frontmatter line untouched (defensive — never crashes)', () => {
    const src = skillDirHost(storeRoot, 'org1', '*', 'no-name-skill');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), '---\ndescription: no name field here\n---\n\nBody.\n');

    writer.forkSkillDir('org1', '*', 'no-name-skill', 'no-name-skill-custom');

    const dest = skillDirHost(storeRoot, 'org1', '*', 'no-name-skill-custom');
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('description: no name field here');
  });
});
