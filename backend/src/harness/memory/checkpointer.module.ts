import { EnvService } from '@core/config/env/env.service';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { CreateModule } from '@workspace/nestjs-core';
import { createCheckpointer, pgConnString } from './checkpointer';

/** DI token for the working-memory LangGraph checkpointer (PostgresSaver), set up at module init. */
export const CHECKPOINTER = Symbol('HARNESS_CHECKPOINTER');

/**
 * JUNCTION MODULE — owns the checkpointer token + provider and nothing else, so that consumers
 * (conductor's BotGraphFactory, the langgraph worker engine) can import the token from a leaf file.
 *
 * Why this exists: the token used to live in memory.module.ts, which made every tool/engine file
 * that needs CHECKPOINTER transitively import the MemoryModule *file*. Once a roster employee
 * imported tool classes for its allowlist (employees → tools → sessions → engines), that closed an
 * ES-module cycle back into memory.module.ts and Nest saw `undefined` in an imports array at scan
 * time. This file imports only env + the checkpointer helpers — it must never import another
 * harness module, or the cycle comes back.
 */
@CreateModule({
  services: [
    {
      provide: CHECKPOINTER,
      inject: [EnvService],
      useFactory: (env: EnvService): Promise<PostgresSaver> =>
        createCheckpointer(
          pgConnString({
            host: env.get('POSTGRES_HOST'),
            port: env.get('POSTGRES_PORT'),
            user: env.get('POSTGRES_USER'),
            password: env.get('POSTGRES_PASSWORD'),
            database: env.get('POSTGRES_DB'),
          }),
        ),
    },
  ],
})
export class CheckpointerModule {}
