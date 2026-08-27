export type OutputDelta = {
  text: string
  nextOffset: number
  droppedCharacters: number
  totalCharacters: number
}

export type OutputBuffer = {
  append(chunk: string): void
  since(offset: number): OutputDelta
  totalCharacters(): number
  tail(limit: number): string
}

export function createOutputBuffer({ retain }: { retain: number }): OutputBuffer {
  let retained = ''
  let dropped = 0

  const totalCharacters = (): number => dropped + retained.length

  return {
    totalCharacters,

    append: (chunk) => {
      retained += chunk
      if (retained.length <= retain) return

      const overflow = retained.length - retain
      retained = retained.slice(overflow)
      dropped += overflow
    },

    since: (offset) => {
      const total = totalCharacters()
      const asked = Math.min(Math.max(Math.trunc(offset), 0), total)
      const readable = Math.max(asked, dropped)

      return {
        text: retained.slice(readable - dropped),
        nextOffset: total,
        droppedCharacters: readable - asked,
        totalCharacters: total,
      }
    },

    tail: (limit) => (limit >= retained.length ? retained : retained.slice(-limit)),
  }
}
