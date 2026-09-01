import { describe, expect, it } from 'bun:test'

import { classify } from '../classify'
import { sentenceOf } from '../aggregate'
import { EDetail, EGather, EToolClass } from '../kinds'
import { aCall, CWD } from './fixture'

const MEMORY = '/Users/d/.atlas/projects/-Users-d-code-atlas/memory/bun-deflate.md'
const INDEX = '/Users/d/.atlas/projects/-Users-d-code-atlas/memory/MEMORY.md'
const ORDINARY = '/Users/d/code/atlas/src/ui/theme.ts'
const DIR = '/Users/d/.atlas/projects/-Users-d-code-atlas/memory'

const readOf = (path: string, extra: Record<string, unknown> = {}) =>
  classify({
    call: aCall({ name: 'read', input: { path }, output: { path, lines: 12, ...extra } }),
    cwd: CWD,
  })

const writeOf = (path: string, output: Record<string, unknown>) =>
  classify({
    call: aCall({ name: 'write', input: { path, content: 'x' }, output: { path, ...output } }),
    cwd: CWD,
  })

describe('reading a memory', () => {
  it('is a recall, not a file read', () => {
    const reading = readOf(MEMORY)

    expect(reading.gather).toBe(EGather.Recall)
    expect(reading.klass).toBe(EToolClass.Gathered)
    expect(reading.line).toBe('bun-deflate')
    expect(reading.alone).toBe('Recalled bun-deflate')
  })

  it('names the index rather than showing MEMORY.md', () => {
    expect(readOf(INDEX).alone).toBe('Recalled the memory index')
  })

  it('leaves an ordinary file read alone', () => {
    const reading = readOf(ORDINARY)

    expect(reading.gather).toBe(EGather.Read)
    expect(reading.alone).toContain('Read ')
  })

  it('counts into the sentence as a memory', () => {
    const reads = [MEMORY, INDEX].map((path) => ({
      call: aCall({ name: 'read' }),
      reading: readOf(path),
    }))

    expect(sentenceOf(reads)).toBe('Recalled 2 memories')
  })

  it('leads the sentence, ahead of what it merely read', () => {
    const reads = [
      { call: aCall({ name: 'read' }), reading: readOf(ORDINARY) },
      { call: aCall({ name: 'read' }), reading: readOf(MEMORY) },
    ]

    expect(sentenceOf(reads)).toBe('Recalled 1 memory, read 1 file')
  })
})

describe('saving a memory', () => {
  it('remembers when the file is new', () => {
    const reading = writeOf(MEMORY, { created: true })

    expect(reading.klass).toBe(EToolClass.Change)
    expect(reading.line).toBe('Remembered bun-deflate')
    expect(reading.note).toBe('new')
    expect(reading.detail).toBe(EDetail.Created)
  })

  it('revises when the memory already existed', () => {
    expect(writeOf(MEMORY, { created: false }).line).toBe('Revised bun-deflate')
  })

  it('calls the index an update, since it is bookkeeping', () => {
    expect(writeOf(INDEX, { created: false }).line).toBe('Updated the memory index')
  })

  it('leaves an ordinary write alone', () => {
    expect(writeOf(ORDINARY, { created: true }).line).toContain('Created ')
  })
})

describe('the browse clause', () => {
  it('reaches the sentence rather than vanishing from it', () => {
    const browsed = classify({
      call: aCall({
        name: 'web_fetch',
        input: { url: 'https://example.com/a' },
        output: { finalUrl: 'https://example.com/a' },
      }),
      cwd: CWD,
    })

    expect(sentenceOf([{ call: aCall({ name: 'web_fetch' }), reading: browsed }])).toBe(
      'Browsed 1 page',
    )
  })
})

describe('memory reached through the shell', () => {
  const shellOf = (command: string, description = '', exitCode = 0) =>
    classify({
      call: aCall({
        name: 'bash',
        input: { command, description },
        output: { command, description, stdout: 'a\nb', exitCode },
      }),
      cwd: CWD,
    })

  it('recalls when the model cats an index instead of reading it', () => {
    const reading = shellOf(`ls -la ${DIR} && cat ${INDEX} 2>/dev/null`, 'Read memory indexes')

    expect(reading.gather).toBe(EGather.Recall)
    expect(reading.line).toBe('Read memory indexes')
  })

  it('recalls a grep over the memory directory rather than calling it a search', () => {
    expect(shellOf(`grep -rn zlib ${DIR}`).gather).toBe(EGather.Recall)
  })

  it('names the memory a removal dropped', () => {
    const reading = shellOf(`rm ${MEMORY}`)

    expect(reading.klass).toBe(EToolClass.Command)
    expect(reading.line).toBe('Forgot bun-deflate')
    expect(reading.note).toBe('forgotten')
  })

  it('reads a quoted path too', () => {
    expect(shellOf(`rm '${MEMORY}'`).line).toBe('Forgot bun-deflate')
  })

  it('remembers when a heredoc writes a memory', () => {
    expect(shellOf(`cat > ${MEMORY} <<'EOF'`).line).toBe('Remembered bun-deflate')
  })

  it('calls an append to the index an update', () => {
    expect(shellOf(`echo x >> ${INDEX}`).line).toBe('Updated the memory index')
  })

  it('carries a failure through', () => {
    const reading = shellOf(`rm ${MEMORY}`, '', 1)

    expect(reading.failed).toBe(true)
    expect(reading.note).toBe('failed')
  })

  it('leaves a repository directory called memory alone', () => {
    const reading = shellOf('ls packages/core/src/memory', 'List the core memory module')

    expect(reading.gather).toBe(EGather.List)
  })

  it('leaves an ordinary removal alone', () => {
    expect(shellOf('rm -rf dist', 'Clean build output').line).not.toContain('Forgot')
  })
})
