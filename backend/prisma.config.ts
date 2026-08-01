import { defineConfig } from 'prisma/config';

/**
 * Prisma wants one connection URL; atlas's env schema is discrete POSTGRES_* vars (see
 * _lib/config/env). Composing the URL here rather than adding a DATABASE_URL to the schema keeps
 * that schema the single source of truth — otherwise the two could disagree and the CLI would
 * silently migrate a different database than the app connects to.
 *
 * The values arrive via dotenvx, so every Prisma command has to run under `pnpm env:inject --`
 * exactly like the TypeORM CLI scripts did. Run bare and this throws instead of falling back to a
 * default host, which is the difference between a clear error and migrating the wrong database.
 */
function databaseUrl(): string {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      throw new Error(
        `${name} is not set. Prisma commands read the same POSTGRES_* env as the app, so run them ` +
          `through dotenvx: \`pnpm env:inject -- prisma <command>\` (or \`pnpm db:<script>\`).`,
      );
    }
    return value;
  };

  const user = encodeURIComponent(required('POSTGRES_USER'));
  const password = encodeURIComponent(required('POSTGRES_PASSWORD'));
  const host = required('POSTGRES_HOST');
  const port = required('POSTGRES_PORT');
  const database = required('POSTGRES_DB');

  // `disable` matches DatabaseModule.resolveSsl's dev default; prod sets POSTGRES_SSL_MODE.
  const sslmode = process.env.POSTGRES_SSL_MODE ?? 'disable';

  return `postgresql://${user}:${password}@${host}:${port}/${database}?sslmode=${sslmode}`;
}

export default defineConfig({
  schema: './prisma',
  datasource: {
    url: databaseUrl(),
  },
});
