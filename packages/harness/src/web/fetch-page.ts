import {
  acceptContentType,
  acceptUrl,
  EContentVerdict,
  looksBinary,
  sameHost,
  type FetchedPage,
} from '@dltech/atlas-core'

import { htmlToMarkdown, htmlToText, titleOf } from './extract'

export enum EPageFormat {
  Markdown = 'markdown',
  Text = 'text',
  Html = 'html',
}

const MAX_BYTES = 5 * 1024 * 1024

const MAX_CHARACTERS = 120_000

export const DEFAULT_TIMEOUT_SECONDS = 30

export const MAX_TIMEOUT_SECONDS = 120

const BROWSER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const HARNESS_AGENT = 'atlas'

// Cloudflare marks an interactive bot challenge with this header rather than a distinct status, and
// serves a plain response to a client that stops pretending to be a browser.
// https://developers.cloudflare.com/waf/reference/cf-mitigated/
const CHALLENGE_HEADER = 'cf-mitigated'

const ACCEPT: Record<EPageFormat, string> = {
  [EPageFormat.Markdown]:
    'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1',
  [EPageFormat.Text]: 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1',
  [EPageFormat.Html]: 'text/html;q=1.0, application/xhtml+xml;q=0.9, */*;q=0.1',
}

export type PageFailure = { ok: false; reason: string }

export type PageSuccess = { ok: true; page: FetchedPage }

export type PageOutcome = PageSuccess | PageFailure

const headersFor = (args: { format: EPageFormat; agent: string }): Record<string, string> => ({
  accept: ACCEPT[args.format],
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': args.agent,
})

function convert(args: { body: string; html: boolean; format: EPageFormat }): string {
  if (!args.html) return args.body.trim()
  if (args.format === EPageFormat.Html) return args.body.trim()
  if (args.format === EPageFormat.Text) return htmlToText(args.body)
  return htmlToMarkdown(args.body)
}

async function readCapped(response: Response): Promise<string | PageFailure> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return {
      ok: false,
      reason: `the page declares ${declared} bytes, above the ${MAX_BYTES} limit`,
    }
  }

  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > MAX_BYTES) {
    return {
      ok: false,
      reason: `the page is ${buffer.byteLength} bytes, above the ${MAX_BYTES} limit`,
    }
  }

  return new TextDecoder().decode(buffer)
}

export async function fetchPage(args: {
  url: string
  format: EPageFormat
  timeoutSeconds?: number | undefined
  signal: AbortSignal
  /** The url the caller asked for, carried through redirects so the page can name both. */
  requested?: string | undefined
}): Promise<PageOutcome> {
  const verdict = acceptUrl(args.url)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }

  const requested = args.requested ?? verdict.url

  const seconds = Math.min(args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)
  const timer = AbortSignal.timeout(seconds * 1000)
  const signal = AbortSignal.any([args.signal, timer])

  const request = async (agent: string): Promise<Response> =>
    await fetch(verdict.url, {
      headers: headersFor({ format: args.format, agent }),
      redirect: 'manual',
      signal,
    })

  let response: Response
  try {
    response = await request(BROWSER_AGENT)
    if (response.status === 403 && response.headers.has(CHALLENGE_HEADER)) {
      response = await request(HARNESS_AGENT)
    }
  } catch (error) {
    if (timer.aborted)
      return { ok: false, reason: `${verdict.host} did not answer within ${seconds}s` }
    if (args.signal.aborted)
      return { ok: false, reason: 'the developer interrupted the turn while fetching' }
    return {
      ok: false,
      reason: `could not reach ${verdict.host}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const location = response.headers.get('location')
  if (response.status >= 300 && response.status < 400 && location !== null) {
    const target = new URL(location, verdict.url).toString()
    if (!sameHost(target, verdict.url)) {
      return {
        ok: false,
        reason: `${verdict.url} redirects to another host, ${target}. Fetch that url directly if you want it.`,
      }
    }
    return await fetchPage({ ...args, url: target, requested })
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: `${verdict.host} answered ${response.status} ${response.statusText}`.trim(),
    }
  }

  const accepted = acceptContentType(response.headers.get('content-type') ?? '')
  if (accepted.verdict !== EContentVerdict.Text) return { ok: false, reason: accepted.reason }

  const read = await readCapped(response)
  if (typeof read !== 'string') return read

  const converted = convert({ body: read, html: accepted.html, format: args.format })
  const truncated = converted.length > MAX_CHARACTERS

  return {
    ok: true,
    page: {
      url: requested,
      finalUrl: verdict.url,
      ...(accepted.html ? { title: titleOf(read) } : {}),
      bytes: read.length,
      body: truncated ? converted.slice(0, MAX_CHARACTERS) : converted,
      truncated,
    },
  }
}
