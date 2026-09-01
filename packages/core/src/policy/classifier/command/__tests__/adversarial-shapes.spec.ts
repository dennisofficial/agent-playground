import { describe, expect, it } from 'bun:test'

import { ETokenKind, lexCommand } from '../lex'
import { EReadConfidence, readCommand, type CommandReading } from '../read-command'

const project = '/p'

const read = (command: string): CommandReading =>
  readCommand({ command, workdir: undefined, projectDirectory: project })

const programs = (reading: CommandReading): readonly string[] =>
  reading.segments.map((segment) => segment.program)

const words = (command: string): readonly string[] =>
  lexCommand({ command })
    .tokens.filter((token) => token.kind === ETokenKind.Word)
    .map((token) => token.text)

describe('quoting the lexer has to survive', () => {
  it('joins a backslash-newline continuation into one command', () => {
    expect(words('rm -rf \\\n  build')).toEqual(['rm', '-rf', 'build'])
  })

  it('keeps a backslash-escaped space inside one word', () => {
    expect(words('rm my\\ file.txt')).toEqual(['rm', 'my file.txt'])
  })

  it('takes single quotes literally, dollars and all', () => {
    expect(words("echo '$HOME && rm -rf /'")).toEqual(['echo', '$HOME && rm -rf /'])
  })

  it('unescapes a double quote nested inside double quotes', () => {
    expect(words('echo "nested \\"quote\\" here"')).toEqual(['echo', 'nested "quote" here'])
  })

  it('concatenates adjacent quoted and bare fragments into one word', () => {
    expect(words(`rm -rf "/tmp/"'a b'/c`)).toEqual(['rm', '-rf', '/tmp/a b/c'])
  })

  it('does not close a single quote from inside double quotes', () => {
    expect(words(`echo "it's fine"`)).toEqual(['echo', "it's fine"])
  })
})

describe('separators the reader has to honour', () => {
  it('makes one segment per command across every separator', () => {
    expect(programs(read('a; b && c || d | e & f'))).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('treats a newline as a separator', () => {
    expect(programs(read('git add .\ngit commit -m x'))).toEqual(['git', 'git'])
  })

  it('never collapses a pipeline into a single verdict', () => {
    const reading = read('git log | grep secret | head -5')

    expect(reading.segments).toHaveLength(3)
    expect(reading.segments[2]?.flags).toEqual(['-5'])
  })
})

describe('substitution the reader must not pretend to understand', () => {
  it('records a backtick substitution as unread', () => {
    const reading = read('echo `date`')

    expect(reading.segments[0]?.unresolvedExpansions).toEqual(['`date`'])
    expect(reading.confidence).toBe(EReadConfidence.Partial)
  })

  it('records a nested command substitution whole', () => {
    const reading = read('rm -rf $(dirname $(readlink -f x))')

    expect(reading.segments[0]?.unresolvedExpansions).toEqual(['$(dirname $(readlink -f x))'])
    expect(reading.confidence).toBe(EReadConfidence.Opaque)
  })

  it('does not resolve an operand it could not expand', () => {
    const reading = read('ls "$(pwd)"')

    expect(reading.segments[0]?.operands).toEqual(['$(pwd)'])
  })

  it('refuses to invent a home directory for a tilde operand', () => {
    const reading = read('rm -rf ~/Downloads')

    expect(reading.segments[0]?.operands).toEqual(['~/Downloads'])
  })
})

describe('an interpreter handed a script inline', () => {
  it('reads the script bash is given rather than stopping at bash', () => {
    const reading = read('bash -c "rm -rf /var/tmp"')

    expect(programs(reading)).toEqual(['bash', 'rm'])
    expect(reading.segments[1]?.operands).toEqual(['/var/tmp'])
  })

  it('keeps the script itself an operand rather than reading it as a path', () => {
    const reading = read('bash -c "rm -rf /var/tmp"')

    expect(reading.segments[0]?.operands).toEqual(['rm -rf /var/tmp'])
  })

  it('carries the outer directory into the script it reads', () => {
    const reading = read('cd apps && sh -c "rm -rf dist"')

    expect(reading.segments[2]?.operands).toEqual([`${project}/apps/dist`])
  })

  it('is opaque when the script itself is an unread variable', () => {
    expect(read('sh -c "$CMD"').confidence).toBe(EReadConfidence.Opaque)
  })

  it('stops recursing rather than looping forever', () => {
    const reading = read(`bash -c 'bash -c "bash -c \\"bash -c ls\\""'`)

    expect(reading.segments.length).toBeLessThanOrEqual(4)
  })
})

describe('flags that come before the verb', () => {
  it('finds the git verb behind a relocating flag and its value', () => {
    const reading = read('git -c core.pager=cat -C /repo push --force')

    expect(reading.segments[0]?.verb).toBe('push')
    expect(reading.segments[0]?.cwd).toBe('/repo')
    expect(reading.segments[0]?.flags).toEqual(['-c', '-C', '--force'])
  })

  it('does not shred the word flags of a program that uses them', () => {
    const reading = read("find . -name '*.log' -delete")

    expect(reading.segments[0]?.flags).toEqual(['-name', '-delete'])
  })
})

describe('subshells and redirections', () => {
  it('keeps a subshell cd from escaping the subshell', () => {
    const reading = read('(cd /tmp && pwd) && rm -rf build')

    expect(reading.segments[2]?.operands).toEqual([`${project}/build`])
  })

  it('collects an appending redirect target', () => {
    const reading = read('echo x >> logs/out.txt')

    expect(reading.segments[0]?.redirectsInto).toEqual([`${project}/logs/out.txt`])
  })

  it('does not mistake a descriptor duplicate for a file', () => {
    const reading = read('make build > out.log 2>&1')

    expect(reading.segments[0]?.redirectsInto).toEqual([`${project}/out.log`])
  })

  it('is opaque when a redirect target is an unread variable on a destructive program', () => {
    expect(read('tee "$OUT" < a').confidence).toBe(EReadConfidence.Opaque)
  })
})
