import { spawnSync } from 'node:child_process'

/**
 * The telemetry payload carries the revision that produced it so a hot window can be read as
 * "this instance predates the fix" without anyone correlating boot times by hand. A source
 * launch answers from git; the compiled binary has no repository to ask and reports undefined.
 */
export function atlasRevision(): string | undefined {
  try {
    const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: import.meta.dir,
      encoding: 'utf8',
      timeout: 2_000,
    })
    const revision = result.stdout?.trim()
    return result.status === 0 && revision ? revision : undefined
  } catch {
    return undefined
  }
}
