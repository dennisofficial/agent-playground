/* Dev-only: render every registered system prompt (for a representative job kind) to files so they can be
 * read/reviewed. Not shipped — lives under scripts/. Run: npx tsx scripts/dump-prompts.ts <outDir> */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listPromptIds, renderSystemPrompt } from '../src/app/prompt-kit';

const outDir = process.argv[2] ?? '/tmp/atlas-prompts';
mkdirSync(outDir, { recursive: true });

// A representative job kind per prompt id so composed prompts show their job-kind block.
const KIND_FOR: Record<string, 'feature' | 'onboarding' | 'event' | null> = {
  'brain-onboarding': 'onboarding',
};

const index: string[] = [];
for (const { id, audience, usedBy } of listPromptIds()) {
  const jobKind = KIND_FOR[id] ?? (audience === 'raw' ? null : 'feature');
  const text = renderSystemPrompt(id, { jobKind }) ?? '';
  const file = join(outDir, `${id}.txt`);
  writeFileSync(file, text);
  index.push(`${id}\t[${audience}${jobKind ? ` · ${jobKind}` : ''}]\t${usedBy}\t${text.length} chars`);
}
writeFileSync(join(outDir, '_index.tsv'), index.join('\n') + '\n');
console.log(`wrote ${index.length} prompts to ${outDir}`);
console.log(index.join('\n'));
