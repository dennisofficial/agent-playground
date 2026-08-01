'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { notImplemented, stubMutation, stubQuery, type MutationResultLike } from './_stub';
import { useMutation } from './_tanstack-shim';

export interface GithubAppStatus {
  configured: boolean;
  connected: boolean;
  mode: 'pat' | 'app';
  installationId: string | null;
  account: string | null;
}

export function useGithubAppStatus(_orgId: string) {
  return stubQuery<GithubAppStatus>();
}

export function useGithubAppInstallUrl(_orgId: string) {
  return useMutation({
    mutationFn: (): Promise<{ url: string }> => notImplemented('useGithubAppInstallUrl'),
  });
}

export function useSetGithubAuthMode(_orgId: string) {
  return useMutation({
    mutationFn: (mode: 'pat' | 'app'): Promise<{ ok: true; mode: 'pat' | 'app' }> =>
      notImplemented('useSetGithubAuthMode'),
  });
}

export function useDisconnectGithubApp(_orgId: string) {
  return useMutation({
    mutationFn: (): Promise<{ ok: true }> => notImplemented('useDisconnectGithubApp'),
  });
}

export interface WorkspaceProfileMount {
  path: string;
  mode: 'per-thread' | 'shared-ro' | 'shared-rw';
}
export interface WorkspaceProfileSecretFileRef {
  path: string;
  label?: string | null;
}
export interface WorkspaceProfileView {
  mounts: WorkspaceProfileMount[];
  setupScript: string | null;
  previewRecipe: string | null;
  secretFiles: WorkspaceProfileSecretFileRef[];
  seenManifests: string[] | null;
}

export function useWorkspaceProfile(_orgId: string, _repoId: string) {
  return stubQuery<WorkspaceProfileView>();
}

export function useSaveMount(_orgId: string, _repoId: string) {
  return useMutation({
    mutationFn: (body: {
      path: string;
      mode: string;
    }): Promise<{ ok: true; restartsSandbox: true }> => notImplemented('useSaveMount'),
  });
}

export function useDeleteMount(_orgId: string, _repoId: string) {
  return useMutation({
    mutationFn: (body: { path: string }): Promise<{ ok: true; restartsSandbox: true }> =>
      notImplemented('useDeleteMount'),
  });
}

export function useSaveSetupScript(_orgId: string, _repoId: string) {
  return useMutation({
    mutationFn: (body: { script: string | null }): Promise<{ ok: true }> =>
      notImplemented('useSaveSetupScript'),
  });
}

export function useSavePreviewRecipe(_orgId: string, _repoId: string) {
  return useMutation({
    mutationFn: (body: { instructions: string | null }): Promise<{ ok: true }> =>
      notImplemented('useSavePreviewRecipe'),
  });
}

export function useSaveRepoSecretFile(_orgId: string, _repoId: string) {
  return useMutation({
    mutationFn: (body: { path: string; value: string; label?: string }): Promise<{ ok: boolean }> =>
      notImplemented('useSaveRepoSecretFile'),
  });
}

export function useDeleteRepoSecretFile(_orgId: string, _repoId: string) {
  return useMutation({
    mutationFn: (body: { path: string }): Promise<{ ok: boolean }> =>
      notImplemented('useDeleteRepoSecretFile'),
  });
}

export type McpTransport = 'http' | 'sse' | 'stdio';
export type McpSurface = 'brain' | 'build' | 'review';
export type McpAuthKind = 'static' | 'oauth';
export type McpOAuthTokenAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface McpOAuthConfig {
  scope?: string;
  tokenAuthMethod?: McpOAuthTokenAuthMethod;
}

export interface SystemMcpServer {
  name: string;
  description: string;
  transport: McpTransport;
  tools: string[];
  active: boolean;
  inactiveReason?: string;
}

export interface StoredMcpConfig {
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string | null>;
  env?: Record<string, string | null>;
  oauth?: McpOAuthConfig;
}

export interface McpServer {
  scope: 'org' | string;
  name: string;
  transport: McpTransport;
  config: StoredMcpConfig;
  secretKeys: string[];
  surfaces: McpSurface[];
  enabled: boolean;
  discoveredTools: string[] | null;
  lastValidatedAt: string | null;
  validationError: string | null;
  authKind: McpAuthKind;
  oauthConnected: boolean;
  needsReauth: boolean;
}

export interface McpServersView {
  system: SystemMcpServer[];
  servers: McpServer[];
}

export interface McpHeaderInput {
  name: string;
  value: string;
  secret?: boolean;
}

export interface SaveMcpServerBody {
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  headers?: McpHeaderInput[];
  env?: McpHeaderInput[];
  surfaces?: McpSurface[];
  enabled?: boolean;
  authKind?: McpAuthKind;
  oauth?: McpOAuthConfig;
}

export interface McpValidateResult {
  ok: boolean;
  discoveredTools?: string[];
  error?: string;
}

export function useMcpServers(_orgId: string) {
  return stubQuery<McpServersView>();
}

export function useSaveMcpServer(_orgId: string) {
  return useMutation({
    mutationFn: ({
      scope,
      name,
      body,
    }: {
      scope: string;
      name: string;
      body: SaveMcpServerBody;
    }): Promise<{ ok: boolean }> => notImplemented('useSaveMcpServer'),
  });
}

export function useDeleteMcpServer(_orgId: string) {
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }): Promise<{ ok: boolean }> =>
      notImplemented('useDeleteMcpServer'),
  });
}

export function useValidateMcpServer(_orgId: string) {
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }): Promise<McpValidateResult> =>
      notImplemented('useValidateMcpServer'),
  });
}

export function useStartMcpOAuth(_orgId: string) {
  return useMutation({
    mutationFn: ({
      scope,
      name,
    }: {
      scope: string;
      name: string;
    }): Promise<{ authorizeUrl: string }> => notImplemented('useStartMcpOAuth'),
  });
}

export function useMcpOAuthConnect(orgId: string) {
  const startOAuth = useStartMcpOAuth(orgId);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const popupRef = useRef<Window | null>(null);

  useEffect(() => {
    if (!busy) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; ok?: boolean } | null;
      if (!data || data.type !== 'atlas-mcp-oauth') return;
      setBusy(false);
      setResult(
        data.ok
          ? { ok: true, text: 'Connected.' }
          : { ok: false, text: 'Authorization did not complete.' },
      );
    };
    const onFocus = () => {
      if (popupRef.current && popupRef.current.closed) {
        popupRef.current = null;
        setBusy(false);
      }
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', onFocus);
    };
  }, [busy]);

  const connect = useCallback(
    async ({ scope, name }: { scope: string; name: string }) => {
      setResult(null);
      try {
        const { authorizeUrl } = await startOAuth.mutateAsync({ scope, name });
        setBusy(true);
        const popup = window.open(authorizeUrl, 'atlas-mcp-oauth', 'width=520,height=680');
        popupRef.current = popup;
        if (!popup) {
          setBusy(false);
          setResult({
            ok: false,
            text: 'Popup blocked — allow popups and retry.',
          });
        }
      } catch (e) {
        setBusy(false);
        setResult({
          ok: false,
          text: (e as Error)?.message || 'Could not start OAuth.',
        });
      }
    },
    [startOAuth],
  );

  return { connect, busy, result, reset: () => setResult(null) };
}

export function useReonboardRepo(_orgId: string): MutationResultLike<{ jobId: string }, string> {
  return stubMutation<{ jobId: string }, string>('re-onboard repo');
}

export interface ConventionProfile {
  slug: string;
  name: string;
  body: string;
  /** Natural-language "what stack this matches" — used by the onboarding brain to auto-propose it. */
  detectHint: string | null;
}

export interface ConventionProfilesView {
  profiles: ConventionProfile[];
}

export interface SaveConventionProfileBody {
  name: string;
  body: string;
  detectHint?: string;
}

export function useConventionProfiles(_orgId: string) {
  return stubQuery<ConventionProfilesView>();
}

export function useSaveConventionProfile(_orgId: string) {
  return useMutation({
    mutationFn: ({
      slug,
      body,
    }: {
      slug: string;
      body: SaveConventionProfileBody;
    }): Promise<{ ok: boolean }> => notImplemented('useSaveConventionProfile'),
  });
}

export function useDeleteConventionProfile(_orgId: string) {
  return useMutation({
    mutationFn: (slug: string): Promise<{ ok: boolean }> =>
      notImplemented('useDeleteConventionProfile'),
  });
}

export function useRepoConventionProfile(_orgId: string, _repoId: string) {
  return stubQuery<{ slug: string | null }>();
}

export function useAttachConventionProfile(_orgId: string) {
  return useMutation({
    mutationFn: ({
      repoId,
      slug,
    }: {
      repoId: string;
      slug: string | null;
    }): Promise<{ ok: boolean; slug: string | null }> =>
      notImplemented('useAttachConventionProfile'),
  });
}

export type SkillProvenance = 'git' | 'custom' | 'managed';
export type SkillUpdatePolicy = 'pinned' | 'track-ref' | 'manual';

export interface SystemSkill {
  name: string;
  description: string;
  surfaces: McpSurface[];
  reviewForTypes?: string[];
  reviewForGlobs?: string[];
  git?: { url: string; subpath: string; ref: string };
  synced?: boolean;
}

export interface Skill {
  /** `'org'` for an org-wide skill, otherwise the repo id. */
  scope: 'org' | string;
  name: string;
  description: string;
  provenance: SkillProvenance;
  sourceUrl: string | null;
  sourceRef: string | null;
  sourceSubpath: string | null;
  installedSha: string | null;
  updatePolicy: SkillUpdatePolicy | null;
  forkedFrom: string | null;
  surfaces: McpSurface[];
  reviewForTypes: string[];
  reviewForGlobs: string[];
  enabled: boolean;
  /** True for a `pinned`/`manual` git skill whose remote has moved past `installedSha`. */
  updateAvailable: boolean;
}

interface SkillWire {
  scope: string;
  name: string;
  description: string;
  provenance: SkillProvenance;
  source_url: string | null;
  source_ref: string | null;
  source_subpath: string | null;
  installed_sha: string | null;
  update_policy: SkillUpdatePolicy | null;
  forked_from: string | null;
  surfaces: McpSurface[];
  reviewForTypes?: string[];
  reviewForGlobs?: string[];
  enabled: boolean;
  update_available: boolean;
}

export interface SkillsView {
  system: SystemSkill[];
  bundled: string[];
  skills: Skill[];
}

export function useSkills(_orgId: string) {
  return stubQuery<SkillsView>();
}

export interface InstallSkillBody {
  scope: string;
  sourceUrl: string;
  ref?: string;
  subpath?: string;
  updatePolicy?: SkillUpdatePolicy;
  surfaces?: McpSurface[];
}

export function useInstallSkill(_orgId: string) {
  return useMutation({
    mutationFn: (body: InstallSkillBody): Promise<{ skills: SkillWire[] }> =>
      notImplemented('useInstallSkill'),
  });
}

export interface SaveSkillBody {
  description: string;
  provenance?: SkillProvenance;
  surfaces?: McpSurface[];
  reviewForTypes?: string[];
  reviewForGlobs?: string[];
  enabled?: boolean;
  updatePolicy?: SkillUpdatePolicy;
  body?: string;
}

export function useSaveSkill(_orgId: string) {
  return useMutation({
    mutationFn: ({
      scope,
      name,
      body,
    }: {
      scope: string;
      name: string;
      body: SaveSkillBody;
    }): Promise<{ ok: boolean }> => notImplemented('useSaveSkill'),
  });
}

export function useUpdateSkill(_orgId: string) {
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }): Promise<{ ok: boolean }> =>
      notImplemented('useUpdateSkill'),
  });
}

export function useForkSkill(_orgId: string) {
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }): Promise<Skill> =>
      notImplemented('useForkSkill'),
  });
}

export function useDeleteSkill(_orgId: string) {
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }): Promise<{ ok: boolean }> =>
      notImplemented('useDeleteSkill'),
  });
}

export function useSkillFiles(_orgId: string, _scope: string, _name: string, _enabled: boolean) {
  return stubQuery<{ files: string[]; skillMd: string | null }>();
}
