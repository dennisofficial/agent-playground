import 'reflect-metadata';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppDataSource } from './data-source';
import { MessageEntity, ThreadGroupEntity, ThreadEntity } from '../src/app/persistence/entities';
import { atlasAgentHomeBase } from '../src/app/engine/engine-home';
import { parseSessionTranscriptTurns } from '../src/app/brain/session-transcript';
import { backfillThreadFromTurns } from '../src/app/brain/turn-backfill';

/**
 * ONE-OFF back-fill of a brain thread's durable transcript from its SDK session JSONL — the manual twin of
 * the boot backstop (`TurnRecoveryService`). Restores turns that ran in-sandbox but never reached `messages`
 * (a mid-turn restart the Redis re-attach/watchdog dropped, a turn superseded by a new prompt). Idempotent:
 * re-running inserts nothing new (final-reply + sdkUuid + tool-id dedup live in `backfillThreadFromTurns`).
 *
 *   pnpm db:recover-turn <threadId> [jsonlPath]
 *
 * With no explicit path, it locates the thread's newest session JSONL under the agent-home sandbox bind.
 */
function projectsDirForThread(jobId: string): string | null {
  const sandboxesRoot = join(atlasAgentHomeBase(process.env.AGENT_HOME_ROOT), 'sandboxes');
  let dirs: string[];
  try {
    dirs = readdirSync(sandboxesRoot);
  } catch {
    return null;
  }
  const sandboxDir = dirs.find((d) => {
    const i = d.lastIndexOf('-thread-');
    if (i < 0) return false;
    const suffix = d.slice(i + '-thread-'.length);
    return suffix.length > 0 && jobId.startsWith(suffix);
  });
  if (!sandboxDir) return null;
  const home = join(sandboxesRoot, sandboxDir);
  const brain = safeReaddir(home).find((d) => d.startsWith('brain_'));
  return brain ? join(home, brain, 'claude', 'projects') : null;
}

/** Newest `.jsonl` under the projects dir (a thread can have several session files from resets). */
function newestJsonl(projectsDir: string): string | null {
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const slug of safeReaddir(projectsDir)) {
    for (const name of safeReaddir(join(projectsDir, slug))) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(projectsDir, slug, name);
      try {
        const mtimeMs = statSync(path).mtimeMs;
        if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
      } catch {
        /* vanished between readdir and stat — skip */
      }
    }
  }
  return newest?.path ?? null;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const jobId = process.argv[2];
  const explicitPath = process.argv[3];
  if (!jobId) {
    console.error('usage: pnpm db:recover-turn <threadId> [jsonlPath]');
    process.exit(1);
  }

  const jsonlPath =
    explicitPath ??
    (() => {
      const dir = projectsDirForThread(jobId);
      return dir ? newestJsonl(dir) : null;
    })();
  if (!jsonlPath || !existsSync(jsonlPath)) {
    console.error(`recover-turn: no session JSONL found for thread ${jobId} (pass an explicit path as arg 2)`);
    process.exit(1);
  }

  const { turns } = parseSessionTranscriptTurns(readFileSync(jsonlPath, 'utf8'));
  // Mirror the boot backstop: back-fill superseded/earlier turns always; include the LAST turn only when it
  // reached end_turn (a not-yet-clean tail may still be generating). Unpaired tool calls are dropped inside.
  const recoverable = turns.filter((t, i) => t.endedClean || i < turns.length - 1);
  console.log(
    `recover-turn: ${jsonlPath}\n  ${turns.length} turn(s) parsed, ${recoverable.length} recoverable → thread ${jobId} (db ${process.env.POSTGRES_DB})`,
  );

  await AppDataSource.initialize();
  try {
    const messages = AppDataSource.getRepository(MessageEntity);
    const threadGroup = await AppDataSource.getRepository(ThreadGroupEntity).findOne({
      where: { job_id: jobId, kind: 'planning' },
      order: { ordinal: 'ASC' },
    });
    const planningThread = threadGroup
      ? await AppDataSource.getRepository(ThreadEntity).findOne({
          where: { thread_group_id: threadGroup.id },
          order: { ordinal: 'ASC' },
        })
      : null;
    if (!planningThread) {
      console.error(`recover-turn: job ${jobId} has no planning thread group thread to anchor recovered messages`);
      process.exit(1);
    }
    const inserted = await backfillThreadFromTurns(messages, jobId, planningThread.id, recoverable);
    console.log(`recover-turn: back-filled ${inserted} block(s) into messages`);
  } finally {
    await AppDataSource.destroy();
  }
}

void main();
