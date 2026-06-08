import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../engines/guard.js';

/**
 * Durable local storage for Zero's memory. SQLite files (checkpoints, and later facts/episodic) live
 * here. Sits under the project root (the same boundary `guard.ts` jails worker access to), is
 * gitignored, and is created on first use — no setup step.
 */
export const DATA_DIR = resolve(ROOT, '.data');

/** Absolute path to a file inside the data dir, ensuring the dir exists first. */
export function dataFile(name: string): string {
  mkdirSync(DATA_DIR, { recursive: true });
  return resolve(DATA_DIR, name);
}
