import { resolveShadowing } from '@dltech/atlas-core'

import {
  CompatMcpSource,
  type LoadedMcpSpec,
  type McpRejection,
  type McpSource,
} from './sources'

export type ResolvedMcpSpecs = {
  specs: readonly LoadedMcpSpec[]
  shadowed: readonly LoadedMcpSpec[]
  rejections: readonly McpRejection[]
}

const isCompatSource = (source: McpSource): boolean => source instanceof CompatMcpSource

export async function resolveMcpSpecs(args: {
  sources: readonly McpSource[]
}): Promise<ResolvedMcpSpecs> {
  const reads = await Promise.all(
    args.sources.map(async (source) => ({ source, read: await source.load() })),
  )

  const nativeNames = new Set(
    reads
      .filter(({ source }) => !isCompatSource(source))
      .flatMap(({ read }) => read.specs.map((spec) => spec.name)),
  )

  const definitions = reads.flatMap(({ source, read }) =>
    isCompatSource(source)
      ? read.specs.filter((spec) => !nativeNames.has(spec.name))
      : read.specs,
  )

  const specs = resolveShadowing({ definitions, nameOf: (spec) => spec.name })
  const winners = new Set(specs)

  return {
    specs,
    shadowed: definitions.filter((spec) => !winners.has(spec)),
    rejections: reads.flatMap(({ read }) => read.rejections),
  }
}
