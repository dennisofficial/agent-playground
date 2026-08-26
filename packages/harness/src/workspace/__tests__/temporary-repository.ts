import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM point git at an alternative config file, so /dev/null
 * isolates a test repository from whatever the developer running the suite has configured.
 * https://git-scm.com/docs/git-config#ENVIRONMENT
 */
const hermetic: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Atlas Test',
  GIT_AUTHOR_EMAIL: 'test@atlas.invalid',
  GIT_COMMITTER_NAME: 'Atlas Test',
  GIT_COMMITTER_EMAIL: 'test@atlas.invalid',
}

export type TemporaryRepository = {
  root: string
  git(args: readonly string[]): Promise<string>
  write(args: { path: string; content: string }): Promise<void>
  read(args: { path: string }): Promise<string>
  remove(args: { path: string }): Promise<void>
  observableState(): Promise<ObservableState>
  dispose(): Promise<void>
}

export type ObservableState = {
  status: string
  head: string
  index: string
  stagedEntries: string
  refs: string
}

export async function createTemporaryRepository(): Promise<TemporaryRepository> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'atlas-workspace-')))

  const git = async (args: readonly string[]): Promise<string> => {
    const process = Bun.spawn({
      cmd: ['git', ...args],
      cwd: root,
      env: { ...Bun.env, ...hermetic },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`)
    return stdout
  }

  const write = async ({ path, content }: { path: string; content: string }): Promise<void> => {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }

  await git(['init', '--initial-branch=main'])
  await git(['config', 'core.autocrlf', 'false'])
  await git(['config', 'commit.gpgsign', 'false'])
  await write({ path: 'tracked.ts', content: 'export const a = 1\n' })
  await write({ path: '.gitignore', content: 'ignored/\n' })
  await git(['add', '.'])
  await git(['commit', '--message', 'initial'])

  return {
    root,
    git,
    write,
    read: ({ path }) => readFile(join(root, path), 'utf8'),
    remove: ({ path }) => rm(join(root, path), { recursive: true }),
    observableState: async () => ({
      status: await git(['status', '--porcelain=v2', '--untracked-files=all', '--branch']),
      head: await readFile(join(root, '.git', 'HEAD'), 'utf8'),
      index: (await readFile(join(root, '.git', 'index'))).toString('base64'),
      stagedEntries: await git(['ls-files', '--stage']),
      refs: await git(['for-each-ref', '--format=%(refname) %(objectname)']),
    }),
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}
