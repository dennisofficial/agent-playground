export class ModelStreamError extends Error {
  constructor(args: { message: string; cause?: unknown }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause })
    this.name = 'ModelStreamError'
  }
}

export class StreamStallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StreamStallError'
  }
}

export class MessageConversionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MessageConversionError'
  }
}
