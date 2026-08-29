import {
  ESkipReason,
  PromptFragment,
  promptContextKey,
  type CompiledPrompt,
  type PromptContext,
  type PromptPart,
  type SkippedFragment,
} from '@dltech/atlas-core'

import { injectAll, injectable, portToken } from '../container/injection'

export abstract class PromptRegistry {
  abstract compile(ctx: PromptContext): CompiledPrompt
}

function compileFragments(args: {
  fragments: readonly PromptFragment[]
  ctx: PromptContext
}): CompiledPrompt {
  const parts: PromptPart[] = []
  const skipped: SkippedFragment[] = []

  for (const fragment of args.fragments) {
    if (!fragment.applies(args.ctx)) {
      skipped.push({ id: fragment.id, reason: ESkipReason.Condition })
      continue
    }

    const text = fragment.text(args.ctx).trim()
    if (text.length === 0) {
      skipped.push({ id: fragment.id, reason: ESkipReason.Empty })
      continue
    }

    parts.push({ id: fragment.id, text, chars: text.length })
  }

  if (parts.length === 0) return { blocks: [], parts, skipped }

  return { blocks: [{ text: parts.map((part) => part.text).join('\n\n') }], parts, skipped }
}

// Registration order is prompt order because tsyringe keeps one array per token: `register` pushes
// onto it, `getAll` hands that array back, and `resolveAll` maps over it. A child container that
// registers the token at all shadows its parent's array outright rather than merging into it.
// Verified against tsyringe 4.10.0, `registry-base.ts` and `dependency-container.ts`.
// https://github.com/microsoft/tsyringe/blob/master/src/registry-base.ts
@injectable()
export class InMemoryPromptRegistry extends PromptRegistry {
  private readonly fragments: readonly PromptFragment[]
  private readonly memo = new Map<string, CompiledPrompt>()

  constructor(@injectAll(portToken(PromptFragment)) fragments: readonly PromptFragment[]) {
    super()
    const ids = new Set<string>()
    for (const fragment of fragments) {
      if (ids.has(fragment.id)) {
        throw new Error(`two prompt fragments are registered as "${fragment.id}"`)
      }
      ids.add(fragment.id)
    }
    this.fragments = fragments
  }

  compile(ctx: PromptContext): CompiledPrompt {
    const key = promptContextKey(ctx)
    const remembered = this.memo.get(key)
    if (remembered !== undefined) return remembered

    const compiled = compileFragments({ fragments: this.fragments, ctx })
    this.memo.set(key, compiled)
    return compiled
  }
}
