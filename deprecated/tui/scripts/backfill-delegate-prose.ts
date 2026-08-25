#!/usr/bin/env bun
/**
 * Retire the delegate prose that a tagging hole let into other threads' transcripts.
 *
 * `claude-normaliser.service.ts` tagged `tool_use` with `parent_tool_use_id` and dropped the tag on
 * `text` and `thinking`, so a subagent's summarized reasoning persisted as the parent's own — five
 * consecutive "Thinking…" blocks in a thread that had produced one. The code is fixed; this deletes
 * what the bug already wrote.
 *
 * ## Why the tape is the authority and the database is not
 *
 * A `ThreadMessage` row carries no record of who authored it — that is the bug, stated as a schema
 * fact. The raw tape does: every frame kept its `parent_tool_use_id` whether or not the normaliser
 * read it. So this reads the tapes, collects the prose that arrived UNDER a delegate, and deletes the
 * rows in that session whose text matches. Nothing is inferred from the row itself.
 *
 * Two guards, because a false positive here deletes a thought the agent really had:
 *
 *   1. A text is a candidate only if it appears PARENTED and never UNPARENTED in the same tape. A
 *      string that arrived both ways is ambiguous, and ambiguity resolves in favour of keeping it.
 *   2. Matching is exact on the whole block, after `trim()`. Substring or prefix matching would fold
 *      a delegate's opening line into a parent's longer one.
 *
 * Ordinals are left with gaps. They order rows and nothing else — `append` takes `max + 1` — so
 * renumbering would rewrite every row after each deletion to buy nothing.
 *
 * ## Running it
 *
 *   bun scripts/backfill-delegate-prose.ts           # dry run: report, touch nothing
 *   bun scripts/backfill-delegate-prose.ts --apply   # back up, then delete
 *
 * Run it with no Atlas instance live. It writes outside the app's own transactions, and a running
 * turn holds a `ConversationStore` in memory whose committed rows this would delete underneath it.
 */

import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ATLAS_PATHS, databaseBackupDir, sessionTapeFile } from '../src/domain/paths.js';

const APPLY = process.argv.includes('--apply');

/** The prose blocks one tape saw, split by who produced them. */
type TapeProse = { parented: Set<string>; own: Set<string> };

/** Read whole rather than streamed — a long turn's tape is a few megabytes, and this runs once. */
async function readTape(engineSessionId: string): Promise<TapeProse> {
  const parented = new Set<string>();
  const own = new Set<string>();
  const file = sessionTapeFile(engineSessionId);
  if (!existsSync(file)) return { parented, own };

  const text = await Bun.file(file).text();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      continue; // A half-written last line is normal on a tape whose process was killed.
    }
    if (typeof frame !== 'object' || frame === null) continue;
    const record = frame as {
      type?: string;
      parent_tool_use_id?: string | null;
      message?: { content?: unknown };
    };
    if (record.type !== 'assistant') continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;

    const bucket = record.parent_tool_use_id ? parented : own;
    for (const block of content as { type?: string; text?: string; thinking?: string }[]) {
      const body = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : undefined;
      if (body === undefined || body.trim() === '') continue;
      bucket.add(body.trim());
    }
  }
  return { parented, own };
}

type Candidate = {
  id: string;
  threadId: string;
  ordinal: number;
  type: string;
  text: string;
};

async function main(): Promise<void> {
  if (!existsSync(ATLAS_PATHS.database)) {
    console.error(`no database at ${ATLAS_PATHS.database}`);
    process.exit(1);
  }

  // Bun rejects `{ readonly: false }` outright rather than reading it as read-write, so the flag has
  // to be chosen rather than negated. Read-only on a dry run is the point: it makes "touches nothing"
  // a property of the handle instead of a promise about the code below.
  const db = new Database(
    ATLAS_PATHS.database,
    APPLY ? { readwrite: true, create: false } : { readonly: true },
  );
  db.exec('PRAGMA busy_timeout = 5000');

  const sessions = db
    .query<{ id: string; engineSessionId: string | null }, []>(
      'select id, engineSessionId from EngineSession where engineSessionId is not null',
    )
    .all();

  const candidates: Candidate[] = [];
  let tapesRead = 0;

  for (const session of sessions) {
    if (!session.engineSessionId) continue;
    const prose = await readTape(session.engineSessionId);
    if (prose.parented.size === 0) continue;
    tapesRead += 1;

    const rows = db
      .query<{ id: string; threadId: string; ordinal: number; type: string; payload: string }, [string]>(
        "select id, threadId, ordinal, type, payload from ThreadMessage where sessionId = ? and type in ('thinking','assistant')",
      )
      .all(session.id);

    for (const row of rows) {
      let text: unknown;
      try {
        text = (JSON.parse(row.payload) as { text?: unknown }).text;
      } catch {
        continue;
      }
      if (typeof text !== 'string') continue;
      const body = text.trim();
      // Guard 1: parented in this tape, and never this thread's own words.
      if (!prose.parented.has(body) || prose.own.has(body)) continue;
      candidates.push({ id: row.id, threadId: row.threadId, ordinal: row.ordinal, type: row.type, text: body });
    }
  }

  const byThread = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    byThread.set(candidate.threadId, [...(byThread.get(candidate.threadId) ?? []), candidate]);
  }

  console.log(`${sessions.length} sessions, ${tapesRead} tapes with delegate prose`);
  console.log(`${candidates.length} rows to retire across ${byThread.size} threads\n`);
  for (const [threadId, rows] of byThread) {
    console.log(`  ${threadId}  ${rows.length} rows`);
    for (const row of rows.sort((a, b) => a.ordinal - b.ordinal)) {
      console.log(`    [${row.ordinal}] ${row.type}  ${row.text.slice(0, 78).replace(/\n/g, ' ')}…`);
    }
  }

  if (candidates.length === 0) return;
  if (!APPLY) {
    console.log('\ndry run — pass --apply to delete these rows');
    return;
  }

  // The app backs itself up before every migration for the same reason: this is a destructive write
  // with no undo, and the moment before it is the only cheap place to protect the data.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = databaseBackupDir();
  mkdirSync(directory, { recursive: true });
  const backup = join(directory, `atlas-${stamp}-pre-delegate-prose.db`);
  copyFileSync(ATLAS_PATHS.database, backup);
  console.log(`\nbacked up to ${backup}`);

  const remove = db.prepare('delete from ThreadMessage where id = ?');
  db.transaction(() => {
    for (const candidate of candidates) remove.run(candidate.id);
  })();
  console.log(`deleted ${candidates.length} rows`);
}

await main();
