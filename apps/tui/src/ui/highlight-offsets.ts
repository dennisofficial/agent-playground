export type OffsetRange = { start: number; end: number }

/**
 * `EditBufferRenderable.addHighlightByCharRange` addresses the buffer by character offset with the
 * line breaks taken out, while a span parsed out of the draft counts them like any other character.
 * Every newline before an offset therefore shifts the paint one cell to the right unless it is
 * subtracted here. Observed against @opentui/core 0.4.5.
 */
export function charRangeOf(args: { text: string; span: OffsetRange }): OffsetRange {
  let breaks = 0
  let start = args.span.start
  let end = args.span.end

  for (let index = 0; index < Math.min(args.span.end, args.text.length); index += 1) {
    if (args.text[index] !== '\n') continue

    breaks += 1
    if (index < args.span.start) start -= 1
    end -= 1
  }

  return { start, end }
}
