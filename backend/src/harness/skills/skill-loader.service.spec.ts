import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillLoaderService } from './skill-loader.service';
import type { SkillSource } from './skill.types';

// A bare EnvService stub — the loader only reads AGENT_HOME_ROOT (and only for git sources).
const env = { get: () => undefined } as never;

function skillDir(frontmatter: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'skill-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), frontmatter);
  return dir;
}

describe('SkillLoaderService.resolve (local sources)', () => {
  const loader = new SkillLoaderService(env);

  it('parses name + description from a local SKILL.md', async () => {
    const dir = skillDir(
      `---\nname: pdf-filler\ndescription: Fills PDF forms\n---\n# body`,
    );
    const [skill] = await loader.resolve([{ kind: 'local', path: dir }]);
    expect(skill).toMatchObject({
      name: 'pdf-filler',
      description: 'Fills PDF forms',
      dir,
    });
  });

  it('SKIPS a source with no SKILL.md or no name, rather than throwing', async () => {
    const noName = skillDir(`---\ndescription: nameless\n---`);
    const missing: SkillSource = {
      kind: 'local',
      path: '/nope/does/not/exist',
    };
    const resolved = await loader.resolve([
      { kind: 'local', path: noName },
      missing,
    ]);
    expect(resolved).toEqual([]); // both skipped, boot survives
  });
});
