export enum EWebSearchBackend {
  DuckDuckGo = 'duckduckgo',
  Jina = 'jina',
  Tavily = 'tavily',
  Exa = 'exa',
  Brave = 'brave',
  SearXNG = 'searxng',
}

export type WebSearchResult = {
  title: string
  url: string
  snippet?: string | undefined
  content?: string | undefined
  publishedAt?: string | undefined
}

export type WebSearchFindings = {
  query: string
  backend: EWebSearchBackend
  results: readonly WebSearchResult[]
}

export type BackendTraits = {
  backend: EWebSearchBackend
  label: string
  /** What the backend calls the value it needs, when it needs one at all. */
  keyLabel?: string
  keyRequired: boolean
  /** SearXNG wants the address of an instance, which is configuration rather than a secret. */
  masked: boolean
  /** Whether results carry extracted page text rather than a snippet. */
  returnsContent: boolean
}

export const BACKEND_TRAITS: Record<EWebSearchBackend, BackendTraits> = {
  [EWebSearchBackend.DuckDuckGo]: {
    backend: EWebSearchBackend.DuckDuckGo,
    label: 'DuckDuckGo',
    keyRequired: false,
    masked: true,
    returnsContent: false,
  },
  [EWebSearchBackend.Jina]: {
    backend: EWebSearchBackend.Jina,
    label: 'Jina',
    keyLabel: 'API key',
    keyRequired: false,
    masked: true,
    returnsContent: true,
  },
  [EWebSearchBackend.Tavily]: {
    backend: EWebSearchBackend.Tavily,
    label: 'Tavily',
    keyLabel: 'API key',
    keyRequired: true,
    masked: true,
    returnsContent: true,
  },
  [EWebSearchBackend.Exa]: {
    backend: EWebSearchBackend.Exa,
    label: 'Exa',
    keyLabel: 'API key',
    keyRequired: true,
    masked: true,
    returnsContent: true,
  },
  [EWebSearchBackend.Brave]: {
    backend: EWebSearchBackend.Brave,
    label: 'Brave',
    keyLabel: 'API key',
    keyRequired: true,
    masked: true,
    returnsContent: false,
  },
  [EWebSearchBackend.SearXNG]: {
    backend: EWebSearchBackend.SearXNG,
    label: 'SearXNG',
    keyLabel: 'Instance URL',
    keyRequired: true,
    masked: false,
    returnsContent: false,
  },
}

const SECRET_PREFIX = 'search.'

export const secretNameOf = (backend: EWebSearchBackend): string =>
  `${SECRET_PREFIX}${backend}`

export const backendOf = (value: string): EWebSearchBackend | undefined =>
  Object.values(EWebSearchBackend).find((backend) => backend === value)
