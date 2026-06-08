import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { dataFile } from './paths.js';

/**
 * One persistent checkpointer, shared by the chat graph and the langgraph worker engine, so a
 * conversation's (or a job's) message context survives a CLI restart instead of living only in RAM.
 * Each graph keeps its own timeline via its `thread_id`; SqliteSaver namespaces by it, so a single
 * `checkpoints.db` safely backs both.
 *
 * Lazy + memoized (same pattern as `buildModel()`): the file is created on first use, so importing
 * this module never touches disk.
 */
let saver: SqliteSaver | undefined;

export function getCheckpointer(): SqliteSaver {
  return (saver ??= SqliteSaver.fromConnString(dataFile('checkpoints.db')));
}
