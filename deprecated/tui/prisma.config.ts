import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "prisma/config";

/**
 * Authoring-time config only — `prisma migrate dev` / `generate` read this. At runtime the TUI
 * applies the committed migration SQL itself (src/store/migrator.service.ts) and never shells out
 * to the Prisma CLI, so nothing here is on the user's boot path.
 *
 * NOTE: `PrismaConfig` in 7.9.1 has no `adapter` field — `datasource.url` alone drives the CLI, and
 * the runtime adapter is constructed in PrismaService instead. (The design docs claimed both were
 * required; that was wrong, and an `adapter` key here is silently ignored at runtime and a type
 * error under `tsc`.)
 */
const url = `file:${join(homedir(), ".atlas", "atlas.db")}`;

export default defineConfig({
  schema: "prisma/schema",
  migrations: { path: "prisma/migrations" },
  datasource: { url },
});
