import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHostStatsSample1783900000000 implements MigrationInterface {
  name = 'AddHostStatsSample1783900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "host_stats_sample" ("id" bigint GENERATED ALWAYS AS IDENTITY, "sampled_at" TIMESTAMP WITH TIME ZONE NOT NULL, "cpu_pct" real NOT NULL, "mem_pct" real NOT NULL, "disk_pct" real NOT NULL, "containers_running" integer NOT NULL, "containers_total" integer NOT NULL, CONSTRAINT "pk_host_stats_sample" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_host_stats_sample_sampled_at" ON "host_stats_sample" ("sampled_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_host_stats_sample_sampled_at"`);
    await queryRunner.query(`DROP TABLE "host_stats_sample"`);
  }
}
