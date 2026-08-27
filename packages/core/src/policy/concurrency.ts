import { EToolEffect, type ToolDeclaration } from '../tools/tool'

/**
 * A tool that changes the world is snapshotted before it runs, and a snapshot means "the tree
 * before this call". Two of them in flight at once capture each other's half-applied writes, so
 * rewinding to before either call stops being true. Effect outranks the tool's own predicate here
 * so that hazard cannot be reintroduced by a tool declaring itself safe.
 */
const changesTheWorld = (effect: EToolEffect): boolean =>
  effect === EToolEffect.Write || effect === EToolEffect.Destructive

export function isConcurrencySafeCall(args: {
  declaration: ToolDeclaration | undefined
  input: unknown
}): boolean {
  const { declaration } = args
  if (declaration === undefined) return false
  if (declaration.isConcurrencySafe === undefined) return false
  if (changesTheWorld(declaration.effect)) return false

  const parsed = declaration.inputSchema.safeParse(args.input)
  if (!parsed.success) return false

  try {
    return declaration.isConcurrencySafe(parsed.data) === true
  } catch {
    return false
  }
}

export function partitionToolCalls<TCall>(args: {
  calls: readonly TCall[]
  isSafe: (call: TCall) => boolean
}): readonly (readonly TCall[])[] {
  const safely = (call: TCall): boolean => {
    try {
      return args.isSafe(call) === true
    } catch {
      return false
    }
  }

  const runs: TCall[][] = []
  let open: TCall[] | undefined

  for (const call of args.calls) {
    if (!safely(call)) {
      runs.push([call])
      open = undefined
      continue
    }

    if (open === undefined) {
      open = [call]
      runs.push(open)
      continue
    }

    open.push(call)
  }

  return runs
}
