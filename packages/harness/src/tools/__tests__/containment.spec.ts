import { mkdtemp, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import { createWorkspaceContainment } from '../containment'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-containment-'))
  await symlink('/etc', join(root, 'link-to-etc'))
})

describe('createWorkspaceContainment', () => {
  it('contains the root itself and anything beneath it', async () => {
    const containment = createWorkspaceContainment({ root })

    expect(await containment.contains(root)).toBe(true)
    expect(await containment.contains(join(root, 'src', 'a.ts'))).toBe(true)
  })

  it('contains a path that does not exist yet, deciding on its nearest existing ancestor', async () => {
    const containment = createWorkspaceContainment({ root })

    expect(await containment.contains(join(root, 'nested', 'deeper', 'brand-new.ts'))).toBe(true)
  })

  it('does not contain a sibling whose name merely starts with the root', async () => {
    const containment = createWorkspaceContainment({ root })

    expect(await containment.contains(`${root}-evil`)).toBe(false)
  })

  it('resolves symlinks before deciding, and names where the path really lands', async () => {
    const throughLink = join(root, 'link-to-etc', 'passwd')

    expect(throughLink.startsWith(`${root}${sep}`)).toBe(true)

    const containment = createWorkspaceContainment({ root })

    expect(await containment.contains(throughLink)).toBe(false)
    expect(await containment.escapeeOf(throughLink)).toBe(join(await realpath('/etc'), 'passwd'))
  })

  it('contains a path written through the real path of a root that is itself a symlink', async () => {
    const realRoot = await realpath(root)

    expect(realRoot).not.toBe(root)

    const containment = createWorkspaceContainment({ root })

    expect(await containment.escapeeOf(join(realRoot, 'src', 'a.ts'))).toBeUndefined()
  })
})
