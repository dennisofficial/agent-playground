import 'reflect-metadata';

import { toSql } from 'pgvector';
import { AppDataSource } from '../cli/data-source';
import { decryptSecret, loadSecretsKey } from '../src/app/onboarding/secret-cipher';
import { EMBED_MODEL } from '../src/app/memory/embedding';

/**
 * THROWAWAY one-off — DELETE after running once. Backfills `tickets.embedding` for tickets created before
 * semantic dedup existed, so they become dedup-eligible immediately (otherwise they stay invisible to
 * similarity search until next edited). Deliberately standalone (no AppModule → no second app instance,
 * no `@core` path aliases): it talks to the Atlas datasource directly, decrypts each org's OpenAI key
 * from `org_credentials`, and calls the OpenAI embeddings API over plain fetch (same model as the app).
 * Skips cancelled tickets and any org without a usable key (fail-soft).
 *
 *   pnpm env:inject -- ts-node --project tsconfig.cli.json scripts/backfill-ticket-embeddings.ts
 */
async function embed(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data[0].embedding;
}

async function main(): Promise<void> {
  const secretsKey = loadSecretsKey(process.env.SECRETS_ENCRYPTION_KEY);
  const ds = await AppDataSource.initialize();
  try {
    // Resolve each org's OpenAI key once (decrypted from org_credentials, scope '*').
    const credRows: Array<{ org_id: string; openai_api_key_enc: string | null }> = await ds.query(
      `SELECT org_id, openai_api_key_enc FROM org_credentials WHERE scope = '*'`,
    );
    const keyByOrg = new Map<string, string>();
    for (const c of credRows) {
      if (!c.openai_api_key_enc) continue;
      try {
        keyByOrg.set(c.org_id, decryptSecret(c.openai_api_key_enc, secretsKey));
      } catch (err) {
        console.warn(`  org ${c.org_id}: could not decrypt OpenAI key — ${String(err)}`);
      }
    }

    const rows: Array<{ id: string; org_id: string; title: string; body: string | null }> =
      await ds.query(
        `SELECT id, org_id, title, body FROM tickets
         WHERE embedding IS NULL AND status <> 'cancelled'
         ORDER BY created_at ASC`,
      );
    console.log(`backfill: ${rows.length} ticket(s) need an embedding`);

    let embedded = 0;
    let skipped = 0;
    for (const r of rows) {
      const key = keyByOrg.get(r.org_id);
      const text = `${r.title}\n\n${r.body ?? ''}`.trim();
      if (!key || !text) {
        skipped++;
        continue;
      }
      let vec: number[];
      try {
        vec = await embed(text, key);
      } catch (err) {
        console.warn(`  skip ${r.id} (org ${r.org_id}): ${String(err)}`);
        skipped++;
        continue;
      }
      await ds.query(`UPDATE tickets SET embedding = $1::vector WHERE id = $2`, [toSql(vec), r.id]);
      embedded++;
      console.log(`  embedded ${r.id} — ${r.title.slice(0, 60)}`);
    }
    console.log(`backfill done: embedded ${embedded}, skipped ${skipped}`);
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
