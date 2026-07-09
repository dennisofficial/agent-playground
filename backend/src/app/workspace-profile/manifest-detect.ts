import { readdirSync } from 'node:fs';

/**
 * The dependency-manifest filenames the new-stack heuristic watches — one per ecosystem. Their presence
 * at the repo root is a cheap, stable signal that a stack exists; a manifest appearing that the Workspace
 * Profile hasn't acknowledged (`repos.profile_seen_manifests`) is flagged as a NEW stack worth a skill/MCP.
 */
export const KNOWN_MANIFESTS: readonly string[] = [
  'package.json', // node
  'requirements.txt', // python
  'pyproject.toml', // python
  'Pipfile', // python
  'go.mod', // go
  'Gemfile', // ruby
  'pom.xml', // java (maven)
  'build.gradle', // java/kotlin (gradle)
  'build.gradle.kts',
  'Cargo.toml', // rust
  'composer.json', // php
  'mix.exs', // elixir
  'pubspec.yaml', // dart/flutter
  'Package.swift', // swift
];

const KNOWN = new Set(KNOWN_MANIFESTS);

/**
 * Scan a worktree ROOT for known dependency manifests. Root-level only (cheap, and where the primary
 * stack declares itself); never throws — an unreadable dir yields []. Returns sorted basenames.
 */
export function detectRepoManifests(worktreePath: string): string[] {
  try {
    return readdirSync(worktreePath, { withFileTypes: true })
      .filter((e) => e.isFile() && KNOWN.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
