import { DeferredWorkspace } from '@/components/deferred-workspace';

/**
 * Create-thread — DEFERRED. The old flow posted to the removed `/web/say`/channel API. Creating a thread
 * now needs the org → repo picker + `POST /web/orgs/:orgId/repos/:repoId/threads` AND a thread workspace
 * to land in, so it ships with that rewire. The sidebar's "New thread" CTA is disabled meanwhile.
 */
export default function NewThreadPage() {
  return (
    <DeferredWorkspace
      title="Creating threads is coming soon"
      body="Thread creation is moving to the org → repo flow and ships with the rebuilt thread workspace."
    />
  );
}
