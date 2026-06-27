import { MigrationInterface, QueryRunner } from "typeorm";

export class AddThreadAwaitingQuestion1782602615502 implements MigrationInterface {
    name = 'AddThreadAwaitingQuestion1782602615502'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "threads" ADD "awaiting_question_id" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "awaiting_question_id"`);
    }

}
