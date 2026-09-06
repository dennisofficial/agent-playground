import { getTreeSitterClient, TreeSitterClient } from '@opentui/core'

type Highlighted = Awaited<ReturnType<TreeSitterClient['highlightOnce']>>

const CACHE_LIMIT = 128

/**
 * A `<code>` renderable asks its client to highlight the whole body afresh every time `content`
 * changes, and the same body comes round often: on every mount of a settled transcript, and on
 * every republish of a streamed fence that has not gained a newline. This client never starts a
 * worker of its own. It answers repeats from a content-keyed cache and forwards misses to the
 * process-wide client — looked up per call, because the renderer tears that one down and rebuilds
 * it. @opentui/core 0.5.9 reads only `highlightOnce` off the client a CodeRenderable is given.
 */
export class CachingTreeSitterClient extends TreeSitterClient {
  private readonly answers = new Map<string, Promise<Highlighted>>()

  constructor() {
    super({ dataPath: '' }, { autoStartWorker: false })
  }

  override highlightOnce(content: string, filetype: string): Promise<Highlighted> {
    const key = `${filetype}\0${content}`
    const hit = this.answers.get(key)
    if (hit !== undefined) return hit

    const answer = getTreeSitterClient()
      .highlightOnce(content, filetype)
      .then((result) => {
        if (result.error !== undefined || result.warning !== undefined) this.answers.delete(key)
        return result
      })
    answer.catch(() => this.answers.delete(key))

    if (this.answers.size >= CACHE_LIMIT) {
      const oldest = this.answers.keys().next()
      if (!oldest.done) this.answers.delete(oldest.value)
    }
    this.answers.set(key, answer)
    return answer
  }
}

let shared: CachingTreeSitterClient | null = null

export function cachingTreeSitterClient(): CachingTreeSitterClient {
  shared ??= new CachingTreeSitterClient()
  return shared
}
