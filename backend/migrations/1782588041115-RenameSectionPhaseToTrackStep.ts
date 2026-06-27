import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Rename the planning data model: sections→tracks, phases→steps. Hand-written because TypeORM's
 * migration:generate emits DROP+CREATE for a rename (data loss). Also: phases.step (cursor) →
 * steps.stage; phases.section_id → steps.track_id; decision_records.section_briefs → track_titles;
 * + new tracks.type (scope type, default 'general'). Constraints/indexes renamed to the new
 * convention so a future generate stays clean.
 */
export class RenameSectionPhaseToTrackStep1782588041115 implements MigrationInterface {
    name = 'RenameSectionPhaseToTrackStep1782588041115'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Tables
        await queryRunner.query(`ALTER TABLE "sections" RENAME TO "tracks"`);
        await queryRunner.query(`ALTER TABLE "phases" RENAME TO "steps"`);
        // Columns
        await queryRunner.query(`ALTER TABLE "steps" RENAME COLUMN "section_id" TO "track_id"`);
        await queryRunner.query(`ALTER TABLE "steps" RENAME COLUMN "step" TO "stage"`);
        await queryRunner.query(`ALTER TABLE "decision_records" RENAME COLUMN "section_briefs" TO "track_titles"`);
        // New scope-type column (default covers existing rows + arg-less callers)
        await queryRunner.query(`ALTER TABLE "tracks" ADD COLUMN "type" text NOT NULL DEFAULT 'general'`);
        // Constraints + indexes on tracks (was sections)
        await queryRunner.query(`ALTER TABLE "tracks" RENAME CONSTRAINT "pk_sections" TO "pk_tracks"`);
        await queryRunner.query(`ALTER TABLE "tracks" RENAME CONSTRAINT "uq_sections_thread_id_ordinal" TO "uq_tracks_thread_id_ordinal"`);
        await queryRunner.query(`ALTER TABLE "tracks" RENAME CONSTRAINT "fk_sections_org_id_organizations" TO "fk_tracks_org_id_organizations"`);
        await queryRunner.query(`ALTER TABLE "tracks" RENAME CONSTRAINT "fk_sections_thread_id_threads" TO "fk_tracks_thread_id_threads"`);
        await queryRunner.query(`ALTER INDEX "idx_sections_thread_id" RENAME TO "idx_tracks_thread_id"`);
        // Constraints + indexes on steps (was phases)
        await queryRunner.query(`ALTER TABLE "steps" RENAME CONSTRAINT "pk_phases" TO "pk_steps"`);
        await queryRunner.query(`ALTER TABLE "steps" RENAME CONSTRAINT "uq_phases_section_id_ordinal" TO "uq_steps_track_id_ordinal"`);
        await queryRunner.query(`ALTER TABLE "steps" RENAME CONSTRAINT "fk_phases_org_id_organizations" TO "fk_steps_org_id_organizations"`);
        await queryRunner.query(`ALTER TABLE "steps" RENAME CONSTRAINT "fk_phases_section_id_sections" TO "fk_steps_track_id_tracks"`);
        await queryRunner.query(`ALTER TABLE "steps" RENAME CONSTRAINT "fk_phases_thread_id_threads" TO "fk_steps_thread_id_threads"`);
        await queryRunner.query(`ALTER INDEX "idx_phases_section_id" RENAME TO "idx_steps_track_id"`);
        await queryRunner.query(`ALTER INDEX "idx_phases_thread_id" RENAME TO "idx_steps_thread_id"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER INDEX "idx_steps_thread_id" RENAME TO "idx_phases_thread_id"`);
        await queryRunner.query(`ALTER INDEX "idx_steps_track_id" RENAME TO "idx_phases_section_id"`);
        await queryRunner.query(`ALTER TABLE "steps" RENAME CONSTRAINT "fk_steps_thread_id_threads" TO "fk_phases_thread_id_threads"`);
        await queryRunner.query(`ALTER TABLE "steps" RENAME CONSTRAINT "fk_steps_track_id_tracks" TO "fk_phases_section_id_sections"`);
        await queryRunner.query(`ALTER TABLE "steps" RENAME CONSTRAINT "fk_steps_org_id_organizations" TO "fk_phases_org_id_organizations"`);
        await queryRunner.query(`ALTER TABLE "steps" RENAME CONSTRAINT "uq_steps_track_id_ordinal" TO "uq_phases_section_id_ordinal"`);
        await queryRunner.query(`ALTER TABLE "steps" RENAME CONSTRAINT "pk_steps" TO "pk_phases"`);
        await queryRunner.query(`ALTER INDEX "idx_tracks_thread_id" RENAME TO "idx_sections_thread_id"`);
        await queryRunner.query(`ALTER TABLE "tracks" RENAME CONSTRAINT "fk_tracks_thread_id_threads" TO "fk_sections_thread_id_threads"`);
        await queryRunner.query(`ALTER TABLE "tracks" RENAME CONSTRAINT "fk_tracks_org_id_organizations" TO "fk_sections_org_id_organizations"`);
        await queryRunner.query(`ALTER TABLE "tracks" RENAME CONSTRAINT "uq_tracks_thread_id_ordinal" TO "uq_sections_thread_id_ordinal"`);
        await queryRunner.query(`ALTER TABLE "tracks" RENAME CONSTRAINT "pk_tracks" TO "pk_sections"`);
        await queryRunner.query(`ALTER TABLE "tracks" DROP COLUMN "type"`);
        await queryRunner.query(`ALTER TABLE "decision_records" RENAME COLUMN "track_titles" TO "section_briefs"`);
        await queryRunner.query(`ALTER TABLE "steps" RENAME COLUMN "stage" TO "step"`);
        await queryRunner.query(`ALTER TABLE "steps" RENAME COLUMN "track_id" TO "section_id"`);
        await queryRunner.query(`ALTER TABLE "steps" RENAME TO "phases"`);
        await queryRunner.query(`ALTER TABLE "tracks" RENAME TO "sections"`);
    }

}
