import type { WebSearchFindings } from './search'
import { wrapUntrusted } from './untrusted'

const SNIPPET_CELLS = 400

const clip = (text: string, cells: number): string =>
  text.length <= cells ? text : `${text.slice(0, cells).trimEnd()}…`

export type FetchedPage = {
  url: string
  finalUrl: string
  title?: string | undefined
  bytes: number
  body: string
  truncated: boolean
}

export function renderFetchedPage(page: FetchedPage): string {
  const heading = [
    page.title === undefined ? undefined : `Title: ${page.title}`,
    page.finalUrl === page.url ? undefined : `Redirected to: ${page.finalUrl}`,
    page.truncated ? 'The page was longer than the limit and has been cut off.' : undefined,
  ].filter((line): line is string => line !== undefined)

  const envelope = wrapUntrusted({ source: page.finalUrl, body: page.body })
  return heading.length === 0 ? envelope : [heading.join('\n'), envelope].join('\n\n')
}

/**
 * Results are wrapped as one envelope rather than one per result, because a search that returns page
 * text is otherwise mostly delimiter.
 */
export function renderFindings(findings: WebSearchFindings): string {
  if (findings.results.length === 0) {
    return `No results for "${findings.query}" from ${findings.backend}.`
  }

  const body = findings.results
    .map((result, index) => {
      const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`]
      if (result.publishedAt !== undefined) lines.push(`   published ${result.publishedAt}`)
      if (result.snippet !== undefined) lines.push(`   ${clip(result.snippet, SNIPPET_CELLS)}`)
      if (result.content !== undefined) lines.push('', result.content)
      return lines.join('\n')
    })
    .join('\n\n')

  return wrapUntrusted({ source: `${findings.backend} search: ${findings.query}`, body })
}
