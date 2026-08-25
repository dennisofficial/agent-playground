/**
 * Which MCP servers are worth saying something about, and what to say.
 *
 * A repository's own servers come from its checked-in `.mcp.json` and are approved wholesale — see
 * `enableAllProjectMcpServers` in `engine/claude-options.ts`. That makes them work; it does not make
 * them *visible*. A server whose command is missing, whose token expired, or which the human
 * disabled in `.claude/settings.local.json` simply produces no tools, and an agent that never had a
 * tool cannot report that it is gone. The whole symptom is an agent that quietly does the job the
 * long way round.
 *
 * So the `init` frame's roster is read once per session and anything not on its way to working is
 * said out loud, in the transcript, where the human is already looking.
 */

/** One row of the CLI's `init` frame roster. `status` is a bare string on the wire, so it is one here. */
export type McpServerReport = { name: string; status: string };

/**
 * Statuses that are either fine or on their way to being fine, and must never produce a line.
 *
 * `pending` is the important one: the roster is emitted before the servers have finished connecting,
 * so at `init` a perfectly healthy server is almost always pending — Atlas's own in-process server is
 * the only one reliably `connected` by then. Announcing pending would mean announcing every server,
 * every session, and a warning that fires on the happy path is one nobody reads.
 *
 * `disabled` is quiet for the opposite reason: somebody chose it, in `.claude/settings.local.json`,
 * and Atlas honouring that choice is not news.
 */
const QUIET: ReadonlySet<string> = new Set([
  "connected",
  "connecting",
  "pending",
  "disabled",
]);

/** The server needs a human to log in — which is a thing Atlas has no way to do for it. */
const NEEDS_AUTH = "needs-auth";

/**
 * What to say, and what to file it under, for every server that will not be serving tools — in
 * roster order.
 *
 * Empty is the ordinary answer. The `key` is what the caller passes to `noticeOnce`: it carries the
 * status as well as the name, so one broken server costs one row for the whole job, while a server
 * that goes from `failed` to `needs-auth` gets to say the new thing.
 */
export type McpNotice = { key: string; text: string };

export function mcpServerNotices(
  servers: readonly McpServerReport[],
): readonly McpNotice[] {
  return servers
    .filter((server) => !QUIET.has(server.status))
    .map((server) => ({
      key: `mcp:${server.name}:${server.status}`,
      text: noticeFor(server),
    }));
}

function noticeFor(server: McpServerReport): string {
  const head = `mcp server "${server.name}" is ${server.status} — its tools are not in this thread`;
  // The one status with a next step, and it is a step only the human can take: authenticating is an
  // interactive flow, and Atlas's engine home is not the one holding the result.
  if (server.status === NEEDS_AUTH)
    return `${head}. Run \`claude\` in this repository and authenticate it there.`;
  return head;
}
