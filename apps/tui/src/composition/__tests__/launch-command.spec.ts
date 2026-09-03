import { describe, expect, it } from 'bun:test'

import { launchCommand } from '../launch-command'

describe('the command an operator would type to get this launch back', () => {
  it('names the shipped binary when the entry point came off the compiled filesystem', () => {
    const command = launchCommand({
      execPath: '/Users/dennis/.local/bin/atlas',
      entry: '/$bunfs/root/main.tsx',
    })

    expect(command).toBe('atlas')
  })

  it('names the binary under whatever it was installed as', () => {
    const command = launchCommand({
      execPath: '/Users/dennis/Developer/atlas/apps/tui/bin/atlas-nightly',
      entry: '/$bunfs/root/main.tsx',
    })

    expect(command).toBe('atlas-nightly')
  })

  it('names the dev launcher for a source run, because bun is not what an operator types', () => {
    const command = launchCommand({
      execPath: '/Users/dennis/.bun/bin/bun',
      entry: '/Users/dennis/Developer/atlas/apps/tui/src/main.tsx',
    })

    expect(command).toBe('atlas-dev')
  })

  it('falls back to the dev launcher when there is no entry point to read', () => {
    expect(launchCommand({ execPath: '/usr/local/bin/bun', entry: undefined })).toBe('atlas-dev')
  })
})
