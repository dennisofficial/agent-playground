import { bootAtlas } from './composition/boot'
import { launchCommand } from './composition/launch-command'

export const APP_PACKAGE_NAME = '@dltech/atlas'

const STARTUP_FAILED = 1

const report = (error: unknown): void => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : 'Atlas failed to start.'
  process.stderr.write(`${detail}\n`)
}

if (import.meta.main) {
  bootAtlas({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    command: launchCommand({ execPath: process.execPath, entry: process.argv[1] }),
  })
    .then((exitCode) => {
      if (exitCode !== 0) process.exitCode = exitCode
    })
    .catch((error: unknown) => {
      report(error)
      process.exitCode = STARTUP_FAILED
    })
}
