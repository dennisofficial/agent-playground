import { describe, expect, it } from 'bun:test'

import { CachingTreeSitterClient } from '../renderers/highlight-client'
import { lexicalRows } from '../renderers/lexical'
import { grammarsReady } from './harness'

await grammarsReady()

const TS = 'const answer: number = 42\nexport { answer }'

describe('fence highlight caches', () => {
  it('answers a repeated tree-sitter body with the very same highlight', async () => {
    const client = new CachingTreeSitterClient()
    const first = client.highlightOnce(TS, 'typescript')
    const again = client.highlightOnce(TS, 'typescript')

    expect(again).toBe(first)
    expect((await first).highlights?.length ?? 0).toBeGreaterThan(0)
    expect(client.highlightOnce(`${TS}\n`, 'typescript')).not.toBe(first)
    expect(client.highlightOnce(TS, 'javascript')).not.toBe(first)
  })

  it('answers a repeated lexical body with the very same rows', () => {
    const source = '(defn hello [name]\n  (str "hi " name))'
    const first = lexicalRows({ source, language: 'clojure' })

    expect(first).not.toBeNull()
    expect(lexicalRows({ source, language: 'clojure' })).toBe(first)
    expect(lexicalRows({ source: `${source}\n`, language: 'clojure' })).not.toBe(first)
  })
})
