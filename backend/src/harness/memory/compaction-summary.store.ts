import { CompactionSummary } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';

/**
 * Write-only audit store for rolling compaction events. Each call to `record` appends one row
 * to `compaction_summaries` — the full summary text, which thread it covers, and how many
 * messages have been folded in. Rows are append-only and never mutated after insert (the audit
 * trail must stay intact even after subsequent compactions supersede earlier summaries).
 */
export class CompactionSummaryStore {
  constructor(private readonly repo: Repository<CompactionSummary>) {}

  /** Append an audit row for a completed compaction pass. Fire-and-forget — callers do not await
   * a meaningful return value; the in-state `summary` / `summarizedUpTo` are the live source of
   * truth; this row is for observability and replayability only. */
  async record(
    thread: string,
    version: number,
    coveredUpTo: number,
    summary: string,
  ): Promise<void> {
    await this.repo.save(
      this.repo.create({ thread, version, covered_up_to: coveredUpTo, summary }),
    );
  }
}
