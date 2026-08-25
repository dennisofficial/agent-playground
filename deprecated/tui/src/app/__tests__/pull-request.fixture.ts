import type { PullRequestService } from '../pull-request.service.js';
import type { ToolContext } from '../tools/tool.js';

export type RecordPrCall = { ctx: ToolContext; url: string };

/**
 * A seam fixture's ninth constructor argument. `ThreadSeamService` holds a `PullRequestService` so
 * the registry can offer `record_pr`, so every seam fixture needs one whether or not the test
 * records anything — and a fixture that stopped passing one would make the tool vanish silently.
 *
 * Cast rather than implemented: the real service has private members, and the alternative is
 * exporting a seam nothing but a test would use.
 */
export function fakePullRequestService(calls: RecordPrCall[] = []): PullRequestService {
  return {
    async record(args: RecordPrCall): Promise<string> {
      calls.push(args);
      return 'recorded';
    },
  } as unknown as PullRequestService;
}
