import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
import { AppModule } from "./app.module.js";
import { App } from "./ui/app.js";
import { registerGrammars } from "./ui/markdown/grammars/index.js";
import { ServicesProvider, resolveServices } from "./ui/services.js";

/**
 * argv → boot the Nest context → take the screen → render.
 *
 * `createApplicationContext` builds the DI graph with no HTTP adapter — measured at ~4ms, against a
 * process that lives for hours. Migration runs inside it (PrismaService.onModuleInit), so by the
 * time React mounts the database is already at the current schema. "Migrate, then run" is the whole
 * startup story; the binary is self-installing and there is no `db:migrate` step for the user.
 *
 * The container is built BEFORE the renderer takes the screen: a migration that throws should print
 * its stack to the user's actual terminal, not into a buffer that is discarded milliseconds later.
 *
 * Atlas runs on Bun rather than Node because OpenTUI's renderer is a Zig native library reachable
 * only through Bun's FFI. `bun build --compile` embeds both, so the shipped binary is self-contained
 * and users never install a runtime.
 */
async function main(): Promise<void> {
  const context = await NestFactory.createApplicationContext(AppModule, {
    // Nest's logger writes straight to stdout, which would corrupt the frame. Errors still throw.
    logger: process.env.ATLAS_DEBUG ? ["log", "warn", "error"] : false,
  });
  await context.init();

  const services = resolveServices(context);
  const initialProjectPath = argPath();

  // Before the renderer, because the first Tree-sitter client takes the default parser set as it
  // finds it — a grammar registered afterwards would not reach it.
  await registerGrammars();

  // The renderer owns the alternate buffer, the cursor and mouse reporting, and restores all three
  // on exit — the whole of the old `alt-screen` module, including its crash paths.
  const renderer = await createCliRenderer({
    // Wheel and click events, delivered to whichever renderable is under the pointer.
    useMouse: true,
    // Ctrl+C is handled in-app so the session lock is released before the process dies.
    exitOnCtrlC: false,
    targetFps: 120,
  });

  renderer.on?.("destroy", () => {
    void context.close();
  });

  createRoot(renderer).render(
    <ServicesProvider services={services}>
      <App {...(initialProjectPath ? { initialProjectPath } : {})} />
    </ServicesProvider>,
  );
}

/** `atlas` uses cwd; `atlas <path>` opens that folder. */
function argPath(): string | undefined {
  const arg = process.argv[2];
  if (arg && !arg.startsWith("-")) return arg;
  return process.argv.includes("--here") ? process.cwd() : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
