import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'bun:test'

import { EFileLoad, FileBrowser, MAX_MENTION_BYTES, resolveMentionPath } from '../file-browser'

let root: string

const write = ({ at, content }: { at: string; content: string | Uint8Array }): void => {
  const path = join(root, at)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

const browser = (): FileBrowser => new FileBrowser({ root })

const namesUnder = async (directory: string): Promise<readonly string[]> =>
  (await browser().list(directory)).map((entry) => (entry.isDirectory ? `${entry.name}/` : entry.name))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-browse-'))
})

describe('resolveMentionPath', () => {
  it('resolves a relative path against the workspace', () => {
    expect(resolveMentionPath({ root: '/work', path: 'src/app.ts' })).toBe('/work/src/app.ts')
  })

  it('resolves the starting directory itself', () => {
    expect(resolveMentionPath({ root: '/work', path: '' })).toBe('/work')
  })

  it('resolves an absolute path as itself', () => {
    expect(resolveMentionPath({ root: '/work', path: '/etc/hosts' })).toBe('/etc/hosts')
  })

  it('resolves a tilde against the home directory', () => {
    expect(resolveMentionPath({ root: '/work', path: '~/Developer' })).toBe(
      join(homedir(), 'Developer'),
    )
  })

  it('resolves a bare tilde as home itself', () => {
    expect(resolveMentionPath({ root: '/work', path: '~' })).toBe(homedir())
  })

  it('lets a path climb out of the workspace', () => {
    expect(resolveMentionPath({ root: '/work/deep', path: '../sibling' })).toBe('/work/sibling')
  })
})

describe('FileBrowser.list', () => {
  it('lists the first level of the workspace for an empty directory', async () => {
    write({ at: 'apps/tui/app.tsx', content: 'x' })
    write({ at: 'README.md', content: 'x' })

    expect(await namesUnder('')).toEqual(['apps/', 'README.md'])
  })

  it('lists a level below when the directory names one', async () => {
    write({ at: 'apps/tui/app.tsx', content: 'x' })
    write({ at: 'apps/api/main.ts', content: 'x' })

    expect(await namesUnder('apps/')).toEqual(['api/', 'tui/'])
  })

  it('says a directory that is not there holds nothing', async () => {
    expect(await namesUnder('absent/')).toEqual([])
  })

  it('reads a level once and holds it until it is forgotten', async () => {
    write({ at: 'a.ts', content: 'x' })
    const files = browser()
    expect((await files.list('')).map((one) => one.name)).toEqual(['a.ts'])

    write({ at: 'b.ts', content: 'x' })
    expect((await files.list('')).map((one) => one.name)).toEqual(['a.ts'])

    files.forget()
    expect((await files.list('')).map((one) => one.name)).toEqual(['a.ts', 'b.ts'])
  })

  it('keeps what a shell would hide, for the caller to filter', async () => {
    write({ at: '.env', content: 'x' })
    expect(await namesUnder('')).toEqual(['.env'])
  })
})

describe('FileBrowser.exists', () => {
  it('confirms a file that is there', async () => {
    write({ at: 'src/app.ts', content: 'x' })
    expect(await browser().exists('src/app.ts')).toBe(true)
  })

  it('confirms a directory that is there', async () => {
    write({ at: 'src/app.ts', content: 'x' })
    expect(await browser().exists('src/')).toBe(true)
  })

  it('denies what is not there', async () => {
    expect(await browser().exists('src/absent.ts')).toBe(false)
  })

  it('asks the filesystem once per path', async () => {
    const files = browser()
    expect(await files.exists('late.ts')).toBe(false)

    write({ at: 'late.ts', content: 'x' })
    expect(await files.exists('late.ts')).toBe(false)

    files.forget()
    expect(await files.exists('late.ts')).toBe(true)
  })
})

describe('FileBrowser.load', () => {
  it('reads a file the developer mentioned', async () => {
    write({ at: 'src/app.ts', content: 'export const app = 1\n' })

    expect(await browser().load('src/app.ts')).toEqual({
      type: EFileLoad.Text,
      path: 'src/app.ts',
      content: 'export const app = 1\n',
      truncated: false,
    })
  })

  it('reads a file outside the workspace, because that is the point', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'atlas-elsewhere-'))
    writeFileSync(join(elsewhere, 'notes.md'), 'borrowed')

    expect(await browser().load(join(elsewhere, 'notes.md'))).toMatchObject({
      type: EFileLoad.Text,
      content: 'borrowed',
    })
  })

  it('lists a directory rather than reading it', async () => {
    write({ at: 'pkg/one.ts', content: 'x' })
    write({ at: 'pkg/nested/two.ts', content: 'x' })

    expect(await browser().load('pkg')).toEqual({
      type: EFileLoad.Listing,
      path: 'pkg',
      content: 'nested/\none.ts',
    })
  })

  it('truncates a file too large to spend the context on', async () => {
    write({ at: 'big.txt', content: 'a'.repeat(MAX_MENTION_BYTES + 10) })

    const loaded = await browser().load('big.txt')
    if (loaded.type !== EFileLoad.Text) throw new Error('expected text')

    expect(loaded.truncated).toBe(true)
    expect(loaded.content).toHaveLength(MAX_MENTION_BYTES)
  })

  it('refuses a path that does not exist', async () => {
    expect(await browser().load('absent.ts')).toEqual({
      type: EFileLoad.Refused,
      path: 'absent.ts',
      reason: 'it does not exist',
    })
  })

  it('refuses a binary file', async () => {
    write({ at: 'logo.png', content: new Uint8Array([0x89, 0x50, 0x00, 0x01]) })

    expect(await browser().load('logo.png')).toEqual({
      type: EFileLoad.Refused,
      path: 'logo.png',
      reason: 'it is binary',
    })
  })
})

describe('FileBrowser behind a reachable set, as a container thread sees it', () => {
  let mount: string
  let elsewhere: string

  beforeEach(() => {
    mount = mkdtempSync(join(tmpdir(), 'atlas-mount-'))
    elsewhere = mkdtempSync(join(tmpdir(), 'atlas-outside-'))
    writeFileSync(join(mount, 'shared.ts'), 'shared')
    writeFileSync(join(elsewhere, 'notes.md'), 'borrowed')
  })

  const sandboxed = (): FileBrowser =>
    new FileBrowser({ root, reachableRoots: () => [root, mount] })

  it('lists the project and a declared mount, the two things the container can reach', async () => {
    write({ at: 'app.ts', content: 'x' })

    expect((await sandboxed().list('')).map((one) => one.name)).toEqual(['app.ts'])
    expect((await sandboxed().list(mount)).map((one) => one.name)).toEqual(['shared.ts'])
  })

  it('shows nothing for a directory outside the roots, however real it is on the host', async () => {
    expect(await sandboxed().list(elsewhere)).toEqual([])
  })

  it('offers only the branches that lead to a root when browsing above one', async () => {
    const base = mkdtempSync(join(tmpdir(), 'atlas-base-'))
    mkdirSync(join(base, 'kept'))
    mkdirSync(join(base, 'dropped'))
    writeFileSync(join(base, 'loose.md'), 'x')

    const files = new FileBrowser({ root, reachableRoots: () => [root, join(base, 'kept')] })

    expect((await files.list(base)).map((one) => one.name)).toEqual(['kept'])
  })

  it('denies exists for a real file outside the roots, so the mention never paints', async () => {
    expect(await sandboxed().exists(join(elsewhere, 'notes.md'))).toBe(false)
    expect(await sandboxed().exists(join(mount, 'shared.ts'))).toBe(true)
  })

  it('refuses to attach a real file outside the roots, naming the sandbox boundary', async () => {
    expect(await sandboxed().load(join(elsewhere, 'notes.md'))).toEqual({
      type: EFileLoad.Refused,
      path: join(elsewhere, 'notes.md'),
      reason: 'it is outside what the sandbox can reach',
    })
  })

  it('answers from the current roots, not the roots at construction', async () => {
    let roots: readonly string[] = [root]
    const files = new FileBrowser({ root, reachableRoots: () => roots })

    expect(await files.exists(join(mount, 'shared.ts'))).toBe(false)

    files.forget()
    roots = [root, mount]
    expect(await files.exists(join(mount, 'shared.ts'))).toBe(true)
  })

  it('reads the whole host again when the reachable set is undefined', async () => {
    const host = new FileBrowser({ root, reachableRoots: () => undefined })

    expect(await host.load(join(elsewhere, 'notes.md'))).toMatchObject({
      type: EFileLoad.Text,
      content: 'borrowed',
    })
  })
})
