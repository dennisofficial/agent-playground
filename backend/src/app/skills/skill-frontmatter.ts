/**
 * Minimal `SKILL.md` frontmatter reader — just the two fields the installer/updater need to derive a
 * skill's identity from its files (`name`, `description`). Deliberately NOT a general YAML parser (no lib
 * dependency, matches `SkillFileWriter`'s equally minimal frontmatter handling); a skill with richer
 * frontmatter (`allowed-tools`, etc.) is untouched — those fields aren't registry columns.
 */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

/** Parse the `---\n…\n---` block at the top of a `SKILL.md`, if any. Single-line `key: value` pairs only. */
export function parseSkillFrontmatter(md: string): SkillFrontmatter {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!block) return {};
  const out: SkillFrontmatter = {};
  for (const line of block[1].split('\n')) {
    const kv = /^(name|description):\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    const value = kv[2].replace(/^['"]|['"]$/g, '');
    if (kv[1] === 'name') out.name = value;
    else out.description = value;
  }
  return out;
}
