import { readdirSync } from 'node:fs';

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
