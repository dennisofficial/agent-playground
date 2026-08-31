import { describe, expect, it } from 'bun:test'

import { classify } from '../classify'
import { EGather } from '../kinds'
import { aShell, CWD } from './fixture'

const reading = (call: Parameters<typeof classify>[0]['call']) => classify({ call, cwd: CWD })

describe('which stage of a shell line the exit code describes', () => {
  it('does not fail a clause on an exit code that belongs to a later stage', () => {
    const shell = reading(
      aShell({
        command: 'grep -rn useClickRegion src | head -20; ls apps; cat missing.json',
        stdout: 'src/ui/hooks/use-click-region.ts:4\nsrc/ui/components/row.tsx:12',
        exitCode: 1,
      }),
    )

    expect(shell.gather).toBe(EGather.Search)
    expect(shell.failed).toBe(false)
    expect(shell.metric).toBe(2)
    expect(shell.note).toBe('2 l')
  })

  it('still fails a clause when the line held one stage, so the code is its own', () => {
    const shell = reading(aShell({ command: 'cat missing.json', stdout: '', exitCode: 1 }))

    expect(shell.gather).toBe(EGather.Read)
    expect(shell.failed).toBe(true)
    expect(shell.note).toBe('exit 1')
    expect(shell.metric).toBeNull()
  })

  it('reads a single stage through the cd that only moved it', () => {
    const shell = reading(aShell({ command: 'cd apps/tui && ls src/gone', exitCode: 1 }))

    expect(shell.gather).toBe(EGather.List)
    expect(shell.failed).toBe(true)
  })

  it('reads a fruitless search as a search that found nothing, not a broken one', () => {
    const shell = reading(aShell({ command: 'grep -rn nowhere src', stdout: '', exitCode: 1 }))

    expect(shell.gather).toBe(EGather.Search)
    expect(shell.failed).toBe(false)
    expect(shell.note).toBe('')
  })

  it('still fails a search that broke rather than one that came back empty', () => {
    const shell = reading(aShell({ command: 'grep -rn pattern /nope', stdout: '', exitCode: 2 }))

    expect(shell.gather).toBe(EGather.Search)
    expect(shell.failed).toBe(true)
    expect(shell.note).toBe('exit 2')
  })
})
