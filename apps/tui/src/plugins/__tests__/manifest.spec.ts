import { describe, expect, it } from 'bun:test'
import { dirname } from 'node:path'

import { NATIVE_PLUGIN_IDS } from '../manifest.generated'

const pluginsDir = new URL('..', import.meta.url).pathname

const directoriesOnDisk = (): readonly string[] =>
  [...new Bun.Glob('*/index.ts').scanSync(pluginsDir)]
    .map(dirname)
    .filter((directory) => directory !== '__tests__')
    .sort()

describe('the generated native-plugin manifest', () => {
  it('lists exactly the plugin directories on disk', () => {
    expect([...NATIVE_PLUGIN_IDS].sort()).toEqual([...directoriesOnDisk()])
  })
})
