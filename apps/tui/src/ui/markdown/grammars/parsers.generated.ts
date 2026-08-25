// GENERATED from parsers-config.json — do not edit.

import { resolveBundledFilePath } from '@opentui/core'
import type { FiletypeParserOptions, InjectionMapping } from '@opentui/core'

interface FileImportModule {
  readonly default: string
}

const bundledAssetLoaders: Record<string, () => Promise<FileImportModule>> = {
  'assets/python/highlights.scm': () =>
    import('./assets/python/highlights.scm' as string, { with: { type: 'file' } }),
  'assets/python/tree-sitter-python.wasm': () =>
    import('./assets/python/tree-sitter-python.wasm' as string, { with: { type: 'file' } }),
  'assets/bash/highlights.scm': () =>
    import('./assets/bash/highlights.scm' as string, { with: { type: 'file' } }),
  'assets/bash/tree-sitter-bash.wasm': () =>
    import('./assets/bash/tree-sitter-bash.wasm' as string, { with: { type: 'file' } }),
  'assets/json/highlights.scm': () =>
    import('./assets/json/highlights.scm' as string, { with: { type: 'file' } }),
  'assets/json/tree-sitter-json.wasm': () =>
    import('./assets/json/tree-sitter-json.wasm' as string, { with: { type: 'file' } }),
  'assets/css/highlights.scm': () =>
    import('./assets/css/highlights.scm' as string, { with: { type: 'file' } }),
  'assets/css/tree-sitter-css.wasm': () =>
    import('./assets/css/tree-sitter-css.wasm' as string, { with: { type: 'file' } }),
  'assets/sql/highlights.scm': () =>
    import('./assets/sql/highlights.scm' as string, { with: { type: 'file' } }),
  'assets/sql/tree-sitter-sql.wasm': () =>
    import('./assets/sql/tree-sitter-sql.wasm' as string, { with: { type: 'file' } }),
  'assets/yaml/highlights.scm': () =>
    import('./assets/yaml/highlights.scm' as string, { with: { type: 'file' } }),
  'assets/yaml/tree-sitter-yaml.wasm': () =>
    import('./assets/yaml/tree-sitter-yaml.wasm' as string, { with: { type: 'file' } }),
  'assets/java/highlights.scm': () =>
    import('./assets/java/highlights.scm' as string, { with: { type: 'file' } }),
  'assets/java/tree-sitter-java.wasm': () =>
    import('./assets/java/tree-sitter-java.wasm' as string, { with: { type: 'file' } }),
  'assets/go/highlights.scm': () =>
    import('./assets/go/highlights.scm' as string, { with: { type: 'file' } }),
  'assets/go/tree-sitter-go.wasm': () =>
    import('./assets/go/tree-sitter-go.wasm' as string, { with: { type: 'file' } }),
  'assets/rust/highlights.scm': () =>
    import('./assets/rust/highlights.scm' as string, { with: { type: 'file' } }),
  'assets/rust/tree-sitter-rust.wasm': () =>
    import('./assets/rust/tree-sitter-rust.wasm' as string, { with: { type: 'file' } }),
  'assets/cpp/highlights.scm': () =>
    import('./assets/cpp/highlights.scm' as string, { with: { type: 'file' } }),
  'assets/cpp/tree-sitter-cpp.wasm': () =>
    import('./assets/cpp/tree-sitter-cpp.wasm' as string, { with: { type: 'file' } }),
  'assets/javascript/highlights.scm': () =>
    import('./assets/javascript/highlights.scm' as string, { with: { type: 'file' } }),
  'assets/javascript/tree-sitter-javascript.wasm': () =>
    import('./assets/javascript/tree-sitter-javascript.wasm' as string, { with: { type: 'file' } }),
  'assets/typescript/highlights.scm': () =>
    import('./assets/typescript/highlights.scm' as string, { with: { type: 'file' } }),
  'assets/typescript/tree-sitter-typescript.wasm': () =>
    import('./assets/typescript/tree-sitter-typescript.wasm' as string, { with: { type: 'file' } }),
  'assets/typescriptreact/highlights.scm': () =>
    import('./assets/typescriptreact/highlights.scm' as string, { with: { type: 'file' } }),
  'assets/typescriptreact/tree-sitter-tsx.wasm': () =>
    import('./assets/typescriptreact/tree-sitter-tsx.wasm' as string, { with: { type: 'file' } }),
  'assets/html/highlights.scm': () =>
    import('./assets/html/highlights.scm' as string, { with: { type: 'file' } }),
  'assets/html/tree-sitter-html.wasm': () =>
    import('./assets/html/tree-sitter-html.wasm' as string, { with: { type: 'file' } }),
}

interface DefaultParserDescriptor {
  readonly filetype: string
  readonly aliases?: readonly string[]
  readonly queries: {
    readonly highlights: readonly string[]
    readonly injections?: readonly string[]
  }
  readonly wasm: string
  readonly injectionMapping?: InjectionMapping
}

const defaultParserDescriptors: readonly DefaultParserDescriptor[] = [
  {
    filetype: 'python',
    queries: {
      highlights: ['assets/python/highlights.scm'],
    },
    wasm: 'assets/python/tree-sitter-python.wasm',
  },
  {
    filetype: 'bash',
    aliases: ['shell'],
    queries: {
      highlights: ['assets/bash/highlights.scm'],
    },
    wasm: 'assets/bash/tree-sitter-bash.wasm',
  },
  {
    filetype: 'json',
    queries: {
      highlights: ['assets/json/highlights.scm'],
    },
    wasm: 'assets/json/tree-sitter-json.wasm',
  },
  {
    filetype: 'css',
    queries: {
      highlights: ['assets/css/highlights.scm'],
    },
    wasm: 'assets/css/tree-sitter-css.wasm',
  },
  {
    filetype: 'sql',
    queries: {
      highlights: ['assets/sql/highlights.scm'],
    },
    wasm: 'assets/sql/tree-sitter-sql.wasm',
  },
  {
    filetype: 'yaml',
    queries: {
      highlights: ['assets/yaml/highlights.scm'],
    },
    wasm: 'assets/yaml/tree-sitter-yaml.wasm',
  },
  {
    filetype: 'java',
    queries: {
      highlights: ['assets/java/highlights.scm'],
    },
    wasm: 'assets/java/tree-sitter-java.wasm',
  },
  {
    filetype: 'go',
    aliases: ['golang'],
    queries: {
      highlights: ['assets/go/highlights.scm'],
    },
    wasm: 'assets/go/tree-sitter-go.wasm',
  },
  {
    filetype: 'rust',
    queries: {
      highlights: ['assets/rust/highlights.scm'],
    },
    wasm: 'assets/rust/tree-sitter-rust.wasm',
  },
  {
    filetype: 'cpp',
    aliases: ['c++'],
    queries: {
      highlights: ['assets/cpp/highlights.scm'],
    },
    wasm: 'assets/cpp/tree-sitter-cpp.wasm',
  },
  {
    filetype: 'javascript',
    aliases: ['javascriptreact', 'jsx'],
    queries: {
      highlights: ['assets/javascript/highlights.scm'],
    },
    wasm: 'assets/javascript/tree-sitter-javascript.wasm',
  },
  {
    filetype: 'typescript',
    queries: {
      highlights: ['assets/typescript/highlights.scm'],
    },
    wasm: 'assets/typescript/tree-sitter-typescript.wasm',
  },
  {
    filetype: 'typescriptreact',
    aliases: ['tsx'],
    queries: {
      highlights: ['assets/typescriptreact/highlights.scm'],
    },
    wasm: 'assets/typescriptreact/tree-sitter-tsx.wasm',
  },
  {
    filetype: 'html',
    aliases: ['htm'],
    queries: {
      highlights: ['assets/html/highlights.scm'],
    },
    wasm: 'assets/html/tree-sitter-html.wasm',
  },
]

export const defaultParserAssetPaths: readonly string[] = [
  ...new Set(
    defaultParserDescriptors.flatMap((parser) => [
      ...parser.queries.highlights,
      parser.wasm,
      ...(parser.queries.injections ?? []),
    ]),
  ),
]

let cachedParsers: Promise<FiletypeParserOptions[]> | undefined

export function getParsers(): Promise<FiletypeParserOptions[]> {
  cachedParsers ??= Promise.all(defaultParserDescriptors.map(resolveDefaultParser))
  return cachedParsers
}

async function resolveDefaultParser(
  parser: DefaultParserDescriptor,
): Promise<FiletypeParserOptions> {
  const queries: FiletypeParserOptions['queries'] = {
    highlights: await Promise.all(parser.queries.highlights.map(resolveParserAsset)),
  }
  if (parser.queries.injections) {
    queries.injections = await Promise.all(parser.queries.injections.map(resolveParserAsset))
  }

  return {
    filetype: parser.filetype,
    ...(parser.aliases ? { aliases: [...parser.aliases] } : {}),
    queries,
    wasm: await resolveParserAsset(parser.wasm),
    ...(parser.injectionMapping ? { injectionMapping: parser.injectionMapping } : {}),
  }
}

function resolveParserAsset(relativePath: string): Promise<string> {
  const loadBundledFile = bundledAssetLoaders[relativePath]
  if (!loadBundledFile) {
    throw new Error(`Unknown parser asset: ${JSON.stringify(relativePath)}`)
  }
  return resolveBundledFilePath(
    relativePath,
    loadBundledFile,
    new URL(`./${relativePath}`, import.meta.url),
    import.meta.url,
    { loadBundledFileFallback: true, useAssetRoot: false },
  )
}
