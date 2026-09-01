const OPEN = 'untrusted-content'

const NEUTRALISED = 'untrusted‑content'

/**
 * A page that writes `</untrusted-content>` into its own body would otherwise close the envelope
 * around it and continue as though it were the harness talking. Both halves of the tag are rewritten
 * with a non-breaking hyphen, which reads identically and parses as ordinary prose.
 */
export const neutraliseEnvelope = (body: string): string =>
  body.replaceAll(/<(\/?)untrusted-content/gi, `<$1${NEUTRALISED}`)

export function wrapUntrusted(args: { source: string; body: string }): string {
  return [
    `<${OPEN} source="${args.source.replaceAll('"', '%22')}">`,
    neutraliseEnvelope(args.body),
    `</${OPEN}>`,
  ].join('\n')
}
