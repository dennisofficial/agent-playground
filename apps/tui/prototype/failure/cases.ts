// PROTOTYPE — throwaway. Controlled cases, so the rules can be judged on shapes the real threads
// happen not to contain as well as the ones they do.

import type { ToolCall } from '../../src/store'
import { aCall, aShell, CWD } from '../../src/store/tools/__tests__/fixture'

export type Case = { name: string; calls: readonly ToolCall[] }

const aRead = (path: string, lines: number): ToolCall =>
  aCall({ name: 'read', input: { path: `${CWD}/${path}` }, output: { lines } })

const anLs = (path: string): ToolCall => aShell({ command: `ls -la ${path}`, stdout: 'a\nb\nc' })

export const SYNTHETIC: readonly Case[] = [
  {
    name: 'the screenshot — 1 genuinely failed of 13',
    calls: [
      ...Array.from({ length: 10 }, (_unused, index) =>
        aRead(`src/file-${index}.ts`, 10 + index * 2),
      ),
      anLs('src/store'),
      anLs('src/ui'),
      aShell({ command: 'node scripts/verify-manifest.mjs', exitCode: 1, stdout: 'manifest drift: 3 entries' }),
    ],
  },
  {
    name: 'the false alarm — a multi-stage search that worked',
    calls: [
      aRead('a.ts', 40),
      aRead('b.ts', 92),
      aShell({
        command: 'grep -rn "testRender" apps/tui/src | head -20; ls apps/tui; cat apps/tui/x.json',
        exitCode: 1,
        stdout: 'src/ui/__tests__/transcript-render.spec.tsx:12: testRender(...)',
      }),
      aRead('c.ts', 18),
    ],
  },
  {
    name: 'a failure in the middle — does the sentence fragment?',
    calls: [
      aRead('a.ts', 40),
      aRead('b.ts', 92),
      aShell({ command: 'node scripts/verify-manifest.mjs', exitCode: 1, stdout: 'manifest drift' }),
      aRead('c.ts', 18),
      anLs('src/ui'),
      aShell({ command: 'ls -la src/gone', stdout: 'ls: src/gone: No such file' }),
    ],
  },
  {
    name: 'everything failed',
    calls: [
      aShell({ command: 'node scripts/verify-manifest.mjs', exitCode: 1, stdout: 'manifest drift' }),
      aShell({ command: './scripts/check-env.sh', exitCode: 1, stdout: 'ATLAS_DB unset' }),
    ],
  },
]
