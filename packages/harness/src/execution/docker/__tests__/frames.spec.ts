import { describe, expect, it } from 'bun:test'

import { createFrameParser, demuxExecStream, EExecStream } from '../frames'

const bytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

const frame = (stream: EExecStream, payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(8 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint8(0, stream)
  view.setUint32(4, payload.length, false)
  out.set(payload, 8)
  return out
}

const concat = (...chunks: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

const streamOf = (chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

const collected = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) chunks.push(value)
  }
  return concat(...chunks)
}

const CAPTURED = bytes(
  '020000000000001573683a20313a2070733a206e6f7420666f756e640a' +
    '01000000000000107069643d3820706769643d0a6f75740a' +
    '02000000000000046572720a',
)

describe('createFrameParser', () => {
  it('parses bytes captured from a live daemon into their frames', () => {
    const parser = createFrameParser()
    const frames = parser.push(CAPTURED)

    expect(frames.map((one) => one.stream)).toEqual([
      EExecStream.Stderr,
      EExecStream.Stdout,
      EExecStream.Stderr,
    ])
    expect(new TextDecoder().decode(frames[0]?.payload)).toBe('sh: 1: ps: not found\n')
    expect(new TextDecoder().decode(frames[1]?.payload)).toBe('pid=8 pgid=\nout\n')
    expect(new TextDecoder().decode(frames[2]?.payload)).toBe('err\n')
    expect(parser.rest()).toHaveLength(0)
  })

  it('holds a header split across two reads until the rest arrives', () => {
    const parser = createFrameParser()
    const whole = frame(EExecStream.Stdout, text('hello'))

    expect(parser.push(whole.slice(0, 3))).toEqual([])
    expect(parser.push(whole.slice(3, 8))).toEqual([])

    const frames = parser.push(whole.slice(8))
    expect(frames).toHaveLength(1)
    expect(new TextDecoder().decode(frames[0]?.payload)).toBe('hello')
  })

  it('holds a payload split across two reads until it completes', () => {
    const parser = createFrameParser()
    const whole = frame(EExecStream.Stderr, text('a payload delivered in two pieces'))

    expect(parser.push(whole.slice(0, 12))).toEqual([])
    const frames = parser.push(whole.slice(12))

    expect(frames).toHaveLength(1)
    expect(new TextDecoder().decode(frames[0]?.payload)).toBe('a payload delivered in two pieces')
  })

  it('passes a zero-length frame through without inventing payload', () => {
    const parser = createFrameParser()
    const frames = parser.push(
      concat(frame(EExecStream.Stdout, new Uint8Array(0)), frame(EExecStream.Stdout, text('x'))),
    )

    expect(frames).toHaveLength(2)
    expect(frames[0]?.payload).toHaveLength(0)
    expect(new TextDecoder().decode(frames[1]?.payload)).toBe('x')
  })

  it('drops frames addressed to stdin, which an attached client never reads back', () => {
    const parser = createFrameParser()
    const frames = parser.push(frame(0 as EExecStream, text('stdin-echo')))

    expect(frames).toEqual([])
  })
})

describe('demuxExecStream', () => {
  it('splits one framed stream into two clean streams', async () => {
    const { stdout, stderr } = demuxExecStream({ stream: streamOf([CAPTURED]) })

    expect(new TextDecoder().decode(await collected(stdout))).toBe('pid=8 pgid=\nout\n')
    expect(new TextDecoder().decode(await collected(stderr))).toBe('sh: 1: ps: not found\nerr\n')
  })

  it('reassembles frames dribbled in one byte at a time', async () => {
    const dribbled: Uint8Array[] = []
    for (let i = 0; i < CAPTURED.length; i += 1) dribbled.push(CAPTURED.slice(i, i + 1))
    const { stdout, stderr } = demuxExecStream({ stream: streamOf(dribbled) })

    expect(new TextDecoder().decode(await collected(stdout))).toBe('pid=8 pgid=\nout\n')
    expect(new TextDecoder().decode(await collected(stderr))).toBe('sh: 1: ps: not found\nerr\n')
  })

  it('keeps a multibyte character whole when a frame boundary cuts through it', async () => {
    const snowman = text('a ☃ b')
    const framed = concat(
      frame(EExecStream.Stdout, snowman.slice(0, 3)),
      frame(EExecStream.Stdout, snowman.slice(3)),
    )
    const { stdout } = demuxExecStream({ stream: streamOf([framed]) })

    expect(concat(...[await collected(stdout)])).toEqual(snowman)
  })

  it('errors both streams when the connection dies mid-frame', async () => {
    const truncated = CAPTURED.slice(0, CAPTURED.length - 2)
    const { stdout, stderr, done } = demuxExecStream({ stream: streamOf([truncated]) })

    await expect(done).rejects.toThrow()
    await expect(collected(stdout)).rejects.toThrow()
    await expect(collected(stderr)).rejects.toThrow()
  })

  it('closes both streams when the framed stream ends cleanly', async () => {
    const { stdout, stderr, done } = demuxExecStream({ stream: streamOf([CAPTURED]) })

    await done
    expect(new TextDecoder().decode(await collected(stdout))).toBe('pid=8 pgid=\nout\n')
    expect(new TextDecoder().decode(await collected(stderr))).toBe('sh: 1: ps: not found\nerr\n')
  })
})
