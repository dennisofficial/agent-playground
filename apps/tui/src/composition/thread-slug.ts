const SLUG_LIMIT = 48

const SEPARATORS = /[^a-z0-9]+/g

const EDGES = /^-+|-+$/g

export function slugOfTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(SEPARATORS, '-')
    .replace(EDGES, '')
    .slice(0, SLUG_LIMIT)
    .replace(EDGES, '')
}

export function threadHandle(args: { threadId: string; title: string | null }): string {
  if (args.title === null) return args.threadId

  const slug = slugOfTitle(args.title)
  return slug.length === 0 ? args.threadId : slug
}
