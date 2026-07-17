import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropBlockedSeedMessage1784239837915 implements MigrationInterface {
  name = 'DropBlockedSeedMessage1784239837915';

  /**
   * `jobs.blocked_seed_message` is retired — the block CONTEXT is now modeled as ordinary queued
   * `main`-lane `stimuli` (see `StimulusStoreService.recordBornBlockedSeedsIfAbsent` /
   * `recordBlockedNoteIfAbsent`), drained as one coalesced turn on wake. Any job still `status='blocked'`
   * at deploy time was parked by the OLD code path, which stored its opening seed ONLY in this column —
   * it has NO corresponding stimulus rows, so `pumpUnblockedJob`'s drain would silently lose its opening
   * brief once its blockers resolve. Before dropping the column, backfill an idempotent equivalent of the
   * new queued rows (born-blocked provenance note + brief, or the mid-flight "blocked" note) for every such
   * job, mirroring `recordBornBlockedSeedsIfAbsent`/`recordBlockedNoteIfAbsent` byte-for-byte. Guarded so a
   * retried/partial run never double-inserts.
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        r RECORD;
        v_thread_id uuid;
        v_provenance_body text;
        v_provenance_meta jsonb;
        v_blocknote_meta jsonb;
      BEGIN
        FOR r IN
          SELECT j.id AS job_id, j.org_id, j.repo_id, j.blocked_seed_message,
                 j.created_by ->> 'title' AS parent_title,
                 j.created_by ->> 'jobId' AS parent_job_id
            FROM jobs j
           WHERE j.status = 'blocked'
        LOOP
          -- Every job gets its planning thread group + thread at creation (job-bootstrap); skip
          -- defensively (nothing to anchor a transcript row to) if somehow absent.
          SELECT th.id INTO v_thread_id
            FROM threads th
            JOIN thread_groups tg ON tg.id = th.thread_group_id
           WHERE tg.job_id = r.job_id AND tg.kind = 'planning'
           ORDER BY tg.ordinal ASC, th.ordinal ASC
           LIMIT 1;
          IF v_thread_id IS NULL THEN
            CONTINUE;
          END IF;

          IF r.blocked_seed_message IS NOT NULL THEN
            -- BORN-BLOCKED -- mirrors recordBornBlockedSeedsIfAbsent: a provenance pill + the opening
            -- brief, both undelivered main-lane chat stimuli. Guarded on the provenance row's
            -- bornBlockedSeed stamp (same signal hasChatStimulusForSeedTarget reads).
            IF NOT EXISTS (
              SELECT 1 FROM inbound_messages s
               WHERE s.kind = 'chat' AND s.job_id = r.job_id
                 AND s.reply_route ->> 'bornBlockedSeed' = 'true'
            ) THEN
              v_provenance_body := CASE WHEN r.parent_job_id IS NULL THEN
                'This job was CREATED already blocked — it is held until the job(s) it depends on resolve. You have NOT started any work yet; the brief below is your starting point once it unblocks.'
              ELSE
                'This job was CREATED already blocked, and was spawned by ANOTHER Atlas job via create_job — a human operator did NOT start it. Spawning job: "' || COALESCE(r.parent_title, 'untitled') || '" (job ' || r.parent_job_id || '). It is held until the job(s) it depends on resolve. The opening brief below was written by that job''s Atlas, not by the operator, so don''t assume the operator has seen it or is waiting on you — treat it as your starting point once it unblocks, and scope it with the operator from there.'
              END;

              v_provenance_meta := jsonb_build_object(
                'source', 'system_notice',
                'chunkKey', 'seed:born-blocked:' || r.job_id::text,
                'seedType', 'follow_up_job_seed',
                'fullBody', v_provenance_body
              );

              -- The provenance note: a curated pill (writeSystemChunk shape -- visible text is the
              -- short label, the full note rides meta.fullBody).
              INSERT INTO transcript_messages
                (job_id, thread_id, author, author_id, author_bot_id, text, kind, card, meta)
              VALUES
                (r.job_id, v_thread_id, 'System', 'U-SYSTEM', NULL,
                 'Queued — starts when unblocked', 'chat', NULL, v_provenance_meta);

              INSERT INTO inbound_messages
                (org_id, repo_id, kind, type, trust, body, job_id, lane, author_id, author_name, reply_route)
              VALUES
                (r.org_id, r.repo_id, 'chat', 'follow_up_job_seed', 'trusted', v_provenance_body,
                 r.job_id, 'main', 'U-SYSTEM', 'System',
                 jsonb_build_object('surfaceId', 'web', 'jobRef', r.job_id::text, 'bornBlockedSeed', true));

              -- The opening brief: a plain System bubble carrying the operator's original body verbatim.
              INSERT INTO transcript_messages
                (job_id, thread_id, author, author_id, author_bot_id, text, kind, card)
              VALUES
                (r.job_id, v_thread_id, 'System', 'U-SYSTEM', NULL,
                 r.blocked_seed_message, 'chat', NULL);

              INSERT INTO inbound_messages
                (org_id, repo_id, kind, type, trust, body, job_id, lane, author_id, author_name, reply_route)
              VALUES
                (r.org_id, r.repo_id, 'chat', 'follow_up_job_seed', 'trusted', r.blocked_seed_message,
                 r.job_id, 'main', 'U-SYSTEM', 'System',
                 jsonb_build_object('surfaceId', 'web', 'jobRef', r.job_id::text));
            END IF;
          ELSE
            -- MID-FLIGHT block (no seed to replay) -- mirrors recordBlockedNoteIfAbsent: one undelivered
            -- "you've been blocked" pill. Guarded on the blockNote stamp.
            IF NOT EXISTS (
              SELECT 1 FROM inbound_messages s
               WHERE s.kind = 'chat' AND s.job_id = r.job_id
                 AND s.reply_route ->> 'blockNote' = 'true'
            ) THEN
              v_blocknote_meta := jsonb_build_object(
                'source', 'system_notice',
                'chunkKey', 'seed:blocked:' || r.job_id::text,
                'fullBody', 'This job was BLOCKED mid-flight and is held until the job(s) it depends on resolve. Work is paused — nothing further runs until it unblocks.'
              );

              INSERT INTO transcript_messages
                (job_id, thread_id, author, author_id, author_bot_id, text, kind, card, meta)
              VALUES
                (r.job_id, v_thread_id, 'System', 'U-SYSTEM', NULL, 'Blocked', 'chat', NULL, v_blocknote_meta);

              INSERT INTO inbound_messages
                (org_id, repo_id, kind, type, trust, body, job_id, lane, author_id, author_name, reply_route)
              VALUES
                (r.org_id, r.repo_id, 'chat', 'seed', 'trusted',
                 'This job was BLOCKED mid-flight and is held until the job(s) it depends on resolve. Work is paused — nothing further runs until it unblocks.',
                 r.job_id, 'main', 'U-SYSTEM', 'System',
                 jsonb_build_object('surfaceId', 'web', 'jobRef', r.job_id::text, 'blockNote', true));
            END IF;
          END IF;
        END LOOP;
      END $$;
    `);

    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "blocked_seed_message"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" ADD "blocked_seed_message" text`);
  }
}
