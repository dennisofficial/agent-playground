import { renderHarnessTag } from '../../../_shared/prompt-kit/harness/tag-vocabulary';
import { agentMessage, type AgentMessage } from '../../../_shared/prompt-kit/message';
import { CONTAINER_CONTEXT } from '../../sandbox/container-paths';


export interface AttachmentCardItem {
  name: string;
  path: string;
  kind: 'image' | 'file';
  size: number;
}

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
