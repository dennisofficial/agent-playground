import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'prisma/config'

// Authoring-time only. `prisma migrate dev` and `prisma generate` read this; the runtime applies the
// committed migration SQL itself through `openAtlasDatabase` and never shells out to the CLI. The
// datasource deliberately does NOT point at ~/.atlas/atlas.db — `migrate dev` offers to reset a
// database whose applied migrations it does not recognise, and that file still holds the previous
// Atlas TUI's data.
const packageRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: `file:${join(packageRoot, 'prisma', 'authoring.db')}` },
})
