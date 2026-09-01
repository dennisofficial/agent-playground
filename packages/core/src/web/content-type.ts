export enum EContentVerdict {
  Text = 'text',
  Binary = 'binary',
  Document = 'document',
}

export type ContentTypeVerdict =
  | { verdict: EContentVerdict.Text; html: boolean }
  | { verdict: EContentVerdict.Binary | EContentVerdict.Document; reason: string }

const TEXTUAL_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
  'application/ecmascript',
  'application/rss+xml',
  'application/atom+xml',
  'image/svg+xml',
])

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])

const DOCUMENTS: Record<string, string> = {
  'application/pdf': 'a PDF',
  'application/msword': 'a Word document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'a Word document',
  'application/vnd.ms-excel': 'a spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'a spreadsheet',
  'application/epub+zip': 'an ePub',
}

export const essenceOf = (contentType: string): string =>
  (contentType.split(';')[0] ?? '').trim().toLowerCase()

/**
 * Whether what came back is prose at all.
 *
 * Decoding a PDF or a photograph as UTF-8 does not fail, it succeeds and yields mojibake, so the
 * check has to happen before the bytes are turned into text rather than after.
 */
export function acceptContentType(contentType: string): ContentTypeVerdict {
  const essence = essenceOf(contentType)
  if (essence.length === 0) return { verdict: EContentVerdict.Text, html: false }

  const document = DOCUMENTS[essence]
  if (document !== undefined) {
    return {
      verdict: EContentVerdict.Document,
      reason: `that url is ${document}, which web_fetch cannot read. Only web pages and plain text can be fetched.`,
    }
  }

  if (essence.startsWith('image/') && essence !== 'image/svg+xml') {
    return {
      verdict: EContentVerdict.Binary,
      reason: 'that url is an image rather than a page, and web_fetch reads text',
    }
  }

  if (essence.startsWith('video/') || essence.startsWith('audio/') || essence.startsWith('font/')) {
    return {
      verdict: EContentVerdict.Binary,
      reason: `that url served ${essence}, which is not readable as text`,
    }
  }

  if (
    essence.startsWith('text/') ||
    TEXTUAL_TYPES.has(essence) ||
    essence.endsWith('+json') ||
    essence.endsWith('+xml')
  ) {
    return { verdict: EContentVerdict.Text, html: HTML_TYPES.has(essence) }
  }

  return {
    verdict: EContentVerdict.Binary,
    reason: `that url served ${essence}, which is not text and cannot be read as a page`,
  }
}

const SAMPLE = 1024

/**
 * A server that mislabels a binary as text is caught here instead: a NUL byte does not occur in
 * decoded text, so one in the opening kilobyte means the body is not prose whatever it claimed.
 */
export const looksBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, SAMPLE).includes(0)
