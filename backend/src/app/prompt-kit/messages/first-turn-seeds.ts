import { renderHarnessTag } from '@shared/prompt-kit/harness/tag-vocabulary';
import { agentMessage, type AgentMessage } from '@shared/prompt-kit/message';
import { CONTAINER_CONTEXT } from '../../sandbox/container-paths';

/**
 * prompt-kit / messages / first-turn-seeds — the small XML seed blocks prepended to a job's first-turn
 * body: the `<review>` orientation block for a `kind: 'review'` job, and the `<uploaded-files>` block for
 * an operator message that carried composer attachments.
 */

/** One persisted composer attachment (rides `messages.card`; the web renders a chip/thumbnail from it). */
export interface AttachmentCardItem {
  /** The operator's (sanitized) filename, for display. */
  name: string;
  /** Bucket-relative path under `/context` (`uploads/<safeName>`) — the raw-file endpoint re-roots it. */
  path: string;
  kind: 'image' | 'file';
  size: number;
}

/** The `<review>` block prepended to the first-turn body for a `kind: 'review'` job (brain orientation). */
export function renderReviewSeedXml(prNumber: number, repoSlug: string): AgentMessage {
  const note =
    `Review this EXISTING pull request. Fetch it with \`gh pr view ${prNumber}\` / \`gh pr diff ${prNumber}\`, ` +
    `review the diff, and post findings grouped by severity. Do not build or open a PR of your own.`;
  return agentMessage(
    renderHarnessTag({
      tag: 'review',
      attrs: [
        ['pr', prNumber],
        ['repo', repoSlug],
        ['note', note],
      ],
    }),
  );
}

/** The `<uploaded-files>` block prepended to an operator message that carried attachments (brain body). */
export function renderUploadedFilesXml(items: AttachmentCardItem[]): AgentMessage {
  const rows = items
    .map((it) =>
      renderHarnessTag({
        tag: 'file',
        indent: '  ',
        attrs: [
          ['name', it.name],
          ['kind', it.kind],
          ['path', `${CONTAINER_CONTEXT}/${it.path}`],
          ['size', it.size],
        ],
      }),
    )
    .join('\n');
  return agentMessage(
    renderHarnessTag({
      tag: 'uploaded-files',
      attrs: [
        [
          'note',
          'The operator attached the file(s) below. Read any you need with your Read tool — images render visually.',
        ],
      ],
      body: rows,
    }),
  );
}
