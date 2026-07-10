/**
 * Minimal `SKILL.md` frontmatter reader — just the two fields the installer/updater need to derive a
 * skill's identity from its files (`name`, `description`). Deliberately NOT a general YAML parser (no lib
 * dependency, matches `SkillFileWriter`'s equally minimal frontmatter handling); a skill with richer
 * frontmatter (`allowed-tools`, etc.) is untouched — those fields aren't registry columns.
 */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  /** Which `ThreadType`s (see `thread-kind/thread-types.ts`) this skill's review lens applies to. Kept as
   *  plain `string[]` here — the frontmatter/DB boundary never imports the `ThreadType` union. */
  reviewForTypes?: string[];
  /** File globs matched against a thread's changed files — the path-based review-applicability axis. */
  reviewForGlobs?: string[];
}

/** Parse a single-line list value: `[a, b]` or bare `a, b` -> trimmed, unquoted, non-empty items. */
function parseListValue(raw: string): string[] {
  const stripped = raw.replace(/^\[\s*/, '').replace(/\s*\]$/, '');
  return stripped
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter((item) => item.length > 0);
}

/** Parse the `---\n…\n---` block at the top of a `SKILL.md`, if any. Single-line `key: value` pairs only. */
export function parseSkillFrontmatter(md: string): SkillFrontmatter {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!block) return {};
  const out: SkillFrontmatter = {};
  for (const line of block[1].split('\n')) {
    const kv = /^(name|description|reviewForTypes|reviewForGlobs):\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    if (key === 'reviewForTypes' || key === 'reviewForGlobs') {
      const list = parseListValue(kv[2]);
      if (list.length > 0) {
        if (key === 'reviewForTypes') out.reviewForTypes = list;
        else out.reviewForGlobs = list;
      }
      continue;
    }
    const value = kv[2].replace(/^['"]|['"]$/g, '');
    if (key === 'name') out.name = value;
    else out.description = value;
  }
  return out;
}

/** Strip a leading `---\n…\n---` frontmatter block (if any) and return the trimmed body — used to read a
 *  skill's SKILL.md content for injection without leaking its frontmatter into the model's context. */
export function stripSkillFrontmatter(md: string): string {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!block) return md.trim();
  return md.slice(block[0].length).trim();
}
