/**
 * With Tty disabled, Docker multiplexes stdout and stderr of an exec over one connection: an
 * 8-byte header of one stream-type byte, three padding bytes and a big-endian u32 length, then
 * the payload. Stream type 0 is stdin, which an attached client never receives.
 * https://docs.docker.com/reference/api/engine/version/v1.51/#tag/Exec/operation/ExecStart
 */
export enum EExecStream {
  Stdout = 1,
  Stderr = 2,
}

export type ExecFrame = {
  readonly stream: EExecStream
  readonly payload: Uint8Array
}

const HEADER_BYTES = 8

export type FrameParser = {
  push: (chunk: Uint8Array) => ExecFrame[]
  rest: () => Uint8Array
}

export function createFrameParser(): FrameParser {
  let buffer = new Uint8Array(0)

  const push = (chunk: Uint8Array): ExecFrame[] => {
    const next = new Uint8Array(buffer.length + chunk.length)
    next.set(buffer, 0)
    next.set(chunk, buffer.length)
    buffer = next

    const frames: ExecFrame[] = []
    for (;;) {
      if (buffer.length < HEADER_BYTES) return frames

      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      const length = view.getUint32(4, false)
      if (buffer.length < HEADER_BYTES + length) return frames

      const stream = view.getUint8(0)
      const payload = buffer.slice(HEADER_BYTES, HEADER_BYTES + length)
      buffer = buffer.slice(HEADER_BYTES + length)

      if (stream === EExecStream.Stdout || stream === EExecStream.Stderr) {
        frames.push({ stream, payload })
      }
    }
  }

  return { push, rest: () => buffer }
}

export type DemuxedExec = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  done: Promise<void>
}

export function demuxExecStream(args: { stream: ReadableStream<Uint8Array> }): DemuxedExec {
  const parser = createFrameParser()
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined
  let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller
    },
  })
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller
    },
  })

  const done = (async () => {
    try {
      const reader = args.stream.getReader()
      for (;;) {
        const { done: finished, value } = await reader.read()
        if (finished) break
        if (value === undefined) continue

        for (const frame of parser.push(value)) {
          if (frame.payload.length === 0) continue
          const controller =
            frame.stream === EExecStream.Stdout ? stdoutController : stderrController
          controller?.enqueue(frame.payload)
        }
      }

      if (parser.rest().length > 0) {
        throw new Error('the exec stream ended in the middle of a frame')
      }

      stdoutController?.close()
      stderrController?.close()
    } catch (error) {
      stdoutController?.error(error)
      stderrController?.error(error)
      throw error
    }
  })()

  return { stdout, stderr, done }
}
