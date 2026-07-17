export interface SkillFrontmatter {
  name?: string;
  description?: string;
  reviewForTypes?: string[];
  reviewForGlobs?: string[];
}

function parseListValue(raw: string): string[] {
  const stripped = raw.replace(/^\[\s*/, '').replace(/\s*\]$/, '');
  const items: string[] = [];
  let current = '';
  let braceDepth = 0;
  for (const ch of stripped) {
    if (ch === '{') braceDepth++;
    else if (ch === '}' && braceDepth > 0) braceDepth--;
    if (ch === ',' && braceDepth === 0) {
      items.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter((item) => item.length > 0);
}

export function parseSkillFrontmatter(md: string): SkillFrontmatter {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!block) return {};
  const out: SkillFrontmatter = {};
  for (const line of block[1].split('\n')) {
    const kv =
      /^(name|description|reviewForTypes|reviewForGlobs|review_for_types|review_for_globs):\s*(.+?)\s*$/.exec(
        line,
      );
    if (!kv) continue;
    const key = kv[1];
    if (
      key === 'reviewForTypes' ||
      key === 'reviewForGlobs' ||
      key === 'review_for_types' ||
      key === 'review_for_globs'
    ) {
      const list = parseListValue(kv[2]);
      if (list.length > 0) {
        if (key === 'reviewForTypes' || key === 'review_for_types') out.reviewForTypes = list;
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

export function stripSkillFrontmatter(md: string): string {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!block) return md.trim();
  return md.slice(block[0].length).trim();
}
