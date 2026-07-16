import { MigrationInterface, QueryRunner } from "typeorm";

export class AddJobSectionFirstEntered1784227527560 implements MigrationInterface {
    name = 'AddJobSectionFirstEntered1784227527560'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "section_first_entered" jsonb NOT NULL DEFAULT '{}'`);
        await queryRunner.query(`
            UPDATE "jobs"
            SET "section_first_entered" = jsonb_build_object(status, to_jsonb(created_at))
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "section_first_entered"`);
    }

}
