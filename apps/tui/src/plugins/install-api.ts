import { atlasPluginApi } from './api'

export const ATLAS_PLUGIN_SPECIFIER = 'atlas'

// Bun resolves an externally imported module's bare specifiers from the importer's own directory, so
// a repo plugin cannot see the binary's packages. A runtime plugin registered with `build.module`
// hands it the host's own module object instead, and `{ exports, loader: 'object' }` is the shape
// measured on Bun 1.3.14. Modules are cached by path, so this must run before any plugin import().
// https://bun.sh/docs/runtime/plugins
let installed = false

export function installPluginApi(): void {
  if (installed) return
  installed = true

  Bun.plugin({
    name: 'atlas-plugin-api',
    setup(build) {
      build.module(ATLAS_PLUGIN_SPECIFIER, () => ({
        exports: atlasPluginApi,
        loader: 'object',
      }))
    },
  })
}
