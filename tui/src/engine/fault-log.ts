import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ATLAS_PATHS } from '../domain/paths.js';

/**
 * Append one harness fault to `~/.atlas/faults.log`.
 *
 * Not a service, and not the Nest logger: the logger is disabled unless `ATLAS_DEBUG` is set, so on
 * a default install `Logger.error` writes a stack to nowhere. A plain append needs no container,
 * which also means the transport can call it without growing a constructor.
 *
 * Stamped here rather than in `domain/tool-fault.ts` so the classifier stays pure and table-testable.
 */
export function recordToolFault(detail: string, at: Date = new Date()): void {
  try {
    mkdirSync(dirname(ATLAS_PATHS.faults), { recursive: true });
    appendFileSync(ATLAS_PATHS.faults, `${at.toISOString()} ${detail}\n\n`);
  } catch {
    // The same rule the raw tape follows: a debugging aid must never take a turn down with it.
  }
}
