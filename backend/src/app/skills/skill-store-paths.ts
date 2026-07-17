import { repoStateDir } from '@shared/state-root';
import { join } from 'node:path';


function safe(part: string): string {
  return part.replace(/[^a-z0-9_-]/gi, '_') || 'x';
}

export function skillsStoreRoot(root: string | undefined): string {
  return root ?? repoStateDir('skills');
}

export function orgSkillsRootHost(root: string | undefined, orgId: string): string {
  return join(skillsStoreRoot(root), 'orgs', safe(orgId));
}

export function skillDirHost(
  root: string | undefined,
  orgId: string,
  scope: string,
  name: string,
): string {
  return join(orgSkillsRootHost(root, orgId), skillRelativeDir(scope, name));
}

export function skillRelativeDir(scope: string, name: string): string {
  return scope === '*' ? safe(name) : join('repos', safe(scope), safe(name));
}

export function managedGitSkillsRootHost(root: string | undefined): string {
  return join(skillsStoreRoot(root), '_managed');
}

export function managedGitSkillDirHost(root: string | undefined, name: string): string {
  return join(managedGitSkillsRootHost(root), safe(name));
}

export function pendingSkillDirHost(
  root: string | undefined,
  orgId: string,
  requestId: string,
): string {
  return join(skillsStoreRoot(root), '.pending', safe(orgId), safe(requestId));
}

export function managedGitSkillRelativeDir(name: string): string {
  return safe(name);
}
