/* Dev-only: render every system prompt (for its representative context) to files so they can be read/reviewed.
 * Not shipped — lives under scripts/. Run: npx tsx scripts/dump-prompts.ts <outDir>
 *
 * Every prompt is assembled from fragments via the pure `renderPreview` (no Nest DI). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_PROMPTS, renderPreview } from '../src/app/prompt-kit';

const outDir = process.argv[2] ?? '/tmp/atlas-prompts';
mkdirSync(outDir, { recursive: true });
const index: string[] = [];

for (const { id, agent, note, ctx } of AGENT_PROMPTS) {
  const text = renderPreview(id) ?? '';
  writeFileSync(join(outDir, `${id}.txt`), text);
  const kind = ctx.jobKind ? ` · ${ctx.jobKind}` : '';
  index.push(`${id}\t[${String(agent)}${kind}]\t${note}\t${text.length} chars`);
}

writeFileSync(join(outDir, '_index.tsv'), index.join('\n') + '\n');
console.log(`wrote ${index.length} prompts to ${outDir}`);
console.log(index.join('\n'));
