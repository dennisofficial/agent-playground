import { describe, expect, it } from 'bun:test'

import { EReadConfidence, readCommand, type CommandReading } from '../read-command'

const project = '/p'

const read = (command: string): CommandReading =>
  readCommand({ command, workdir: undefined, projectDirectory: project })

const lastSegment = (reading: CommandReading): CommandReading['segments'][number] | undefined =>
  reading.segments.at(-1)

describe('a variable a command sets for itself', () => {
  it('resolves a literal assignment the next command reads', () => {
    const reading = read('T=/tmp/fixed && rm -rf "$T"')

    expect(lastSegment(reading)?.operands).toEqual(['/tmp/fixed'])
    expect(reading.confidence).toBe(EReadConfidence.Read)
  })

  it('keeps reading the assignments that follow one it cannot resolve', () => {
    const reading = read('A=$(date) B=/tmp/safe && rm -rf "$B"')

    expect(lastSegment(reading)?.operands).toEqual(['/tmp/safe'])
    expect(lastSegment(reading)?.unresolvedExpansions).toEqual([])
  })

  it('resolves an assignment made after a pipeline it did not run in', () => {
    const reading = read('git status | wc -l && D=/tmp/out && rm -rf "$D"')

    expect(lastSegment(reading)?.operands).toEqual(['/tmp/out'])
  })

  it('leaves a command substitution unresolved rather than guessing its output', () => {
    const reading = read('T=$(mktemp -d /tmp/check-XXXX) && rm -rf "$T"')

    expect(lastSegment(reading)?.unresolvedExpansions).toEqual(['$T'])
    expect(reading.confidence).toBe(EReadConfidence.Opaque)
  })
})

describe('a variable set where the shell might never set it', () => {
  it('does not carry an assignment across || into the flags of a later command', () => {
    const reading = read('true || FLAG=--dry-run && rm -rf $FLAG /tmp/x')

    expect(lastSegment(reading)?.flags).not.toContain('--dry-run')
    expect(lastSegment(reading)?.unresolvedExpansions).toEqual(['$FLAG'])
    expect(reading.confidence).toBe(EReadConfidence.Opaque)
  })

  it('does not carry an assignment out of a pipeline stage, which runs in a subshell', () => {
    const reading = read('echo hi | P=/tmp/p true && rm -rf "$P"')

    expect(lastSegment(reading)?.operands).toEqual(['$P'])
    expect(lastSegment(reading)?.unresolvedExpansions).toEqual(['$P'])
  })

  it('does not carry an assignment out of a backgrounded clause', () => {
    const reading = read('B=/tmp/bg true & rm -rf "$B"')

    expect(lastSegment(reading)?.unresolvedExpansions).toEqual(['$B'])
  })
})

describe('a value that would not survive being spliced into an argument', () => {
  it('refuses a value carrying a glob, which the shell would expand', () => {
    const reading = read('P=/etc/* && rm -rf $P')

    expect(lastSegment(reading)?.unresolvedExpansions).toEqual(['$P'])
  })

  it('refuses a value carrying a space, which the shell would split', () => {
    const reading = read('P="/tmp/a /tmp/b" && rm -rf $P')

    expect(lastSegment(reading)?.unresolvedExpansions).toEqual(['$P'])
  })

  it('refuses an empty value rather than reading it as the current directory', () => {
    const reading = read('P= && rm -rf "$P"')

    expect(lastSegment(reading)?.unresolvedExpansions).toEqual(['$P'])
  })
})
