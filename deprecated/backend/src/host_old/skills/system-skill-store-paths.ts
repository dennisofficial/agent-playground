import { join } from 'node:path';
import { monorepoRoot } from '../../_shared/state-root';

export function managedSkillsRootHost(): string {
  return join(monorepoRoot(), 'backend', 'skills-managed');
}

export function managedSkillRelativeDir(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_') || 'x';
}
