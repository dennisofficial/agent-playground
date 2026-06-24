import { DeferredWorkspace } from '@/components/deferred-workspace';

/**
 * Thread workspace — DEFERRED. The channel-based conversation/plan/phase views are dead against the new
 * org/repo/thread backend, so this layout no longer mounts them (it intentionally drops `children`, which
 * keeps the nested channel pages — and their removed `ChannelProvider` dependency — from rendering). The
 * rewire onto `/web/orgs/:orgId/repos/:repoId/threads/:threadId` is the next phase.
 */
export default function ThreadLayout() {
  return <DeferredWorkspace />;
}
