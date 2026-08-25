import type { ServiceRegistryService } from '../service-registry.service.js';

export type ServiceCall =
  | { verb: 'start'; jobId: string; command: string; description: string; cwd: string }
  | { verb: 'stop'; jobId: string; id: string }
  | { verb: 'list'; jobId: string }
  | { verb: 'reap'; jobId: string };

/**
 * A seam fixture's tenth constructor argument, and the same bargain as `fakePullRequestService`:
 * `ThreadSeamService` holds a `ServiceRegistryService` so the registry can offer the three service
 * tools, so every seam fixture needs one whether or not the test starts a process — and a fixture
 * that stopped passing one would make those tools vanish silently.
 *
 * It spawns nothing. Anything that wants a real process uses `service-registry.spec.ts`, which drives
 * the real service.
 */
export function fakeServiceRegistry(
  calls: ServiceCall[] = [],
): ServiceRegistryService {
  return {
    async start(args: {
      jobId: string;
      command: string;
      description: string;
      cwd: string;
    }): Promise<string> {
      calls.push({ verb: 'start', ...args });
      return 'started';
    },
    async stop(args: { jobId: string; id: string }): Promise<string> {
      calls.push({ verb: 'stop', ...args });
      return 'stopped';
    },
    async list(args: { jobId: string }): Promise<string> {
      calls.push({ verb: 'list', ...args });
      return 'no services';
    },
    // `WorkspaceService` takes the same fixture: deleting a job reaps its services before the tree
    // that holds their logs goes, so a workspace test needs one too.
    async reapJob(jobId: string): Promise<string[]> {
      calls.push({ verb: 'reap', jobId });
      return [];
    },
  } as unknown as ServiceRegistryService;
}
