import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Restore referential integrity. The 27 FK constraints are GENERATED from the entities' `@ManyToOne`
 * relations (`db:migration:generate`). Two things the generator can't emit are HAND-ADDED per the repo
 * convention (see CLAUDE.md): the pgvector HNSW index, and an orphan pre-clean so `ADD CONSTRAINT` can't
 * fail on legacy rows that accumulated while the schema had no FKs. The spurious
 * `decisions SET DEFAULT` line the generator emits (a jsonb function-default round-trip quirk) was pruned.
 */
export class RestoreReferentialIntegrity1782341329664 implements MigrationInterface {
  name = 'RestoreReferentialIntegrity1782341329664';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── HAND-ADDED: orphan pre-clean (parent-before-child so a deleted orphan parent's children are
    //    caught next). Cascade children → delete danglers; SET NULL refs → null the dangling pointer.
    await queryRunner.query(
      `DELETE FROM "repos" AS r WHERE NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = r.org_id)`,
    );
    await queryRunner.query(
      `DELETE FROM "threads" AS t WHERE NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = t.org_id) OR NOT EXISTS (SELECT 1 FROM "repos" r WHERE r.id = t.repo_id)`,
    );
    await queryRunner.query(
      `DELETE FROM "sections" AS s WHERE NOT EXISTS (SELECT 1 FROM "threads" t WHERE t.id = s.thread_id) OR NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = s.org_id)`,
    );
    await queryRunner.query(
      `DELETE FROM "phases" AS p WHERE NOT EXISTS (SELECT 1 FROM "sections" s WHERE s.id = p.section_id) OR NOT EXISTS (SELECT 1 FROM "threads" t WHERE t.id = p.thread_id) OR NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = p.org_id)`,
    );
    await queryRunner.query(
      `DELETE FROM "messages" AS m WHERE NOT EXISTS (SELECT 1 FROM "threads" t WHERE t.id = m.thread_id)`,
    );
    await queryRunner.query(
      `DELETE FROM "decision_records" AS d WHERE NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = d.org_id) OR NOT EXISTS (SELECT 1 FROM "repos" r WHERE r.id = d.repo_id) OR NOT EXISTS (SELECT 1 FROM "threads" t WHERE t.id = d.thread_id)`,
    );
    await queryRunner.query(
      `DELETE FROM "stimuli" AS s WHERE NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = s.org_id) OR NOT EXISTS (SELECT 1 FROM "repos" r WHERE r.id = s.repo_id) OR (s.thread_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "threads" t WHERE t.id = s.thread_id))`,
    );
    await queryRunner.query(
      `DELETE FROM "thread_sandboxes" AS ts WHERE NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = ts.org_id) OR NOT EXISTS (SELECT 1 FROM "threads" t WHERE t.id = ts.thread_id) OR NOT EXISTS (SELECT 1 FROM "repos" r WHERE r.id = ts.repo_id)`,
    );
    await queryRunner.query(
      `DELETE FROM "memory" AS mm WHERE mm.org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = mm.org_id)`,
    );
    await queryRunner.query(
      `DELETE FROM "organization_members" AS m WHERE NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = m.org_id) OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = m.user_id)`,
    );
    await queryRunner.query(
      `DELETE FROM "org_invites" AS i WHERE NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = i.org_id)`,
    );
    await queryRunner.query(
      `DELETE FROM "org_credentials" AS c WHERE NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = c.org_id)`,
    );
    await queryRunner.query(
      `UPDATE "org_invites" AS i SET "invited_by" = NULL WHERE i.invited_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = i.invited_by)`,
    );
    await queryRunner.query(
      `UPDATE "org_invites" AS i SET "accepted_by" = NULL WHERE i.accepted_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = i.accepted_by)`,
    );
    await queryRunner.query(
      `UPDATE "decision_records" AS d SET "approved_by" = NULL WHERE d.approved_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = d.approved_by)`,
    );
    await queryRunner.query(
      `UPDATE "threads" AS t SET "decision_record_id" = NULL WHERE t.decision_record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "decision_records" d WHERE d.id = t.decision_record_id)`,
    );

    // ── GENERATED: the 27 FK constraints (from the entities' @ManyToOne relations).
    await queryRunner.query(
      `ALTER TABLE "organization_members" ADD CONSTRAINT "fk_organization_members_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_members" ADD CONSTRAINT "fk_organization_members_user_id_users" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_invites" ADD CONSTRAINT "fk_org_invites_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_invites" ADD CONSTRAINT "fk_org_invites_invited_by_users" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_invites" ADD CONSTRAINT "fk_org_invites_accepted_by_users" FOREIGN KEY ("accepted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "repos" ADD CONSTRAINT "fk_repos_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "decision_records" ADD CONSTRAINT "fk_decision_records_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "decision_records" ADD CONSTRAINT "fk_decision_records_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "decision_records" ADD CONSTRAINT "fk_decision_records_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "decision_records" ADD CONSTRAINT "fk_decision_records_approved_by_users" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_decision_record_id_decision_records" FOREIGN KEY ("decision_record_id") REFERENCES "decision_records"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD CONSTRAINT "fk_messages_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stimuli" ADD CONSTRAINT "fk_stimuli_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stimuli" ADD CONSTRAINT "fk_stimuli_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stimuli" ADD CONSTRAINT "fk_stimuli_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sections" ADD CONSTRAINT "fk_sections_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sections" ADD CONSTRAINT "fk_sections_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "phases" ADD CONSTRAINT "fk_phases_section_id_sections" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "phases" ADD CONSTRAINT "fk_phases_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "phases" ADD CONSTRAINT "fk_phases_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "memory" ADD CONSTRAINT "fk_memory_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_credentials" ADD CONSTRAINT "fk_org_credentials_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_sandboxes" ADD CONSTRAINT "fk_thread_sandboxes_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_sandboxes" ADD CONSTRAINT "fk_thread_sandboxes_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_sandboxes" ADD CONSTRAINT "fk_thread_sandboxes_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // ── HAND-ADDED: the pgvector HNSW cosine index (matches the store's `embedding <=> q`); the
    //    generator can't emit a vector index. `vector` extension is guarded for DBs predating the Init edit.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_memory_embedding_hnsw" ON "memory" USING hnsw ("embedding" vector_cosine_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_memory_embedding_hnsw"`);
    await queryRunner.query(
      `ALTER TABLE "thread_sandboxes" DROP CONSTRAINT "fk_thread_sandboxes_repo_id_repos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_sandboxes" DROP CONSTRAINT "fk_thread_sandboxes_thread_id_threads"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_sandboxes" DROP CONSTRAINT "fk_thread_sandboxes_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_credentials" DROP CONSTRAINT "fk_org_credentials_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "memory" DROP CONSTRAINT "fk_memory_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "phases" DROP CONSTRAINT "fk_phases_org_id_organizations"`,
    );
    await queryRunner.query(`ALTER TABLE "phases" DROP CONSTRAINT "fk_phases_thread_id_threads"`);
    await queryRunner.query(`ALTER TABLE "phases" DROP CONSTRAINT "fk_phases_section_id_sections"`);
    await queryRunner.query(
      `ALTER TABLE "sections" DROP CONSTRAINT "fk_sections_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sections" DROP CONSTRAINT "fk_sections_thread_id_threads"`,
    );
    await queryRunner.query(`ALTER TABLE "stimuli" DROP CONSTRAINT "fk_stimuli_thread_id_threads"`);
    await queryRunner.query(`ALTER TABLE "stimuli" DROP CONSTRAINT "fk_stimuli_repo_id_repos"`);
    await queryRunner.query(
      `ALTER TABLE "stimuli" DROP CONSTRAINT "fk_stimuli_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "fk_messages_thread_id_threads"`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" DROP CONSTRAINT "fk_threads_decision_record_id_decision_records"`,
    );
    await queryRunner.query(`ALTER TABLE "threads" DROP CONSTRAINT "fk_threads_repo_id_repos"`);
    await queryRunner.query(
      `ALTER TABLE "threads" DROP CONSTRAINT "fk_threads_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "decision_records" DROP CONSTRAINT "fk_decision_records_approved_by_users"`,
    );
    await queryRunner.query(
      `ALTER TABLE "decision_records" DROP CONSTRAINT "fk_decision_records_thread_id_threads"`,
    );
    await queryRunner.query(
      `ALTER TABLE "decision_records" DROP CONSTRAINT "fk_decision_records_repo_id_repos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "decision_records" DROP CONSTRAINT "fk_decision_records_org_id_organizations"`,
    );
    await queryRunner.query(`ALTER TABLE "repos" DROP CONSTRAINT "fk_repos_org_id_organizations"`);
    await queryRunner.query(
      `ALTER TABLE "org_invites" DROP CONSTRAINT "fk_org_invites_accepted_by_users"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_invites" DROP CONSTRAINT "fk_org_invites_invited_by_users"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_invites" DROP CONSTRAINT "fk_org_invites_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_members" DROP CONSTRAINT "fk_organization_members_user_id_users"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_members" DROP CONSTRAINT "fk_organization_members_org_id_organizations"`,
    );
  }
}
