import {
  ARTIFACT_SINK,
  type ArtifactSink,
} from '@harness/surface/artifact-sink.port';
import { Inject, Optional } from '@nestjs/common';
import { z } from 'zod';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

const shareArtifactSchema = z.object({
  content: z
    .string()
    .describe(
      'The full text content of the file to upload (e.g. a report, plan, or code).',
    ),
  filename: z
    .string()
    .describe(
      'Filename with extension (e.g. analysis.md, results.csv). Slack uses this for the viewer and download.',
    ),
  title: z
    .string()
    .optional()
    .describe(
      'Human-readable display title shown above the file in Slack. Defaults to the filename if omitted.',
    ),
});

/**
 * Upload a text artifact (report, plan, code, etc.) as a file and attach it to the agent's
 * outgoing Slack message. The file is uploaded UNSHARED first; the conductor attaches the
 * returned file ID to the message via `chat.update(file_ids)` so text and file appear together.
 *
 * When no `ARTIFACT_SINK` is bound (TUI / headless), the tool degrades gracefully and the
 * content is NOT posted — the agent should summarise inline if the sink is unavailable.
 */
@HarnessTool()
export class ShareArtifactTool implements IHarnessTool<
  typeof shareArtifactSchema
> {
  readonly name = 'share_artifact';
  readonly description =
    'Upload a file or artifact (report, plan, analysis, code) to share it in the current ' +
    'conversation. The file appears attached to your message in Slack. Use it for content ' +
    'that is too long for chat or benefits from a file viewer. ' +
    'Call it in the same turn as the message you want to attach it to — the file will arrive ' +
    'alongside that message rather than as a separate post.';
  readonly schema = shareArtifactSchema;

  constructor(
    @Optional()
    @Inject(ARTIFACT_SINK)
    private readonly sink?: ArtifactSink,
  ) {}

  async execute(
    args: z.infer<typeof shareArtifactSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    if (!this.sink) {
      return 'No file upload adapter is configured for this environment — attachment skipped.';
    }
    const result = await this.sink.upload({
      content: args.content,
      filename: args.filename,
      title: args.title,
      teamId: ctx.identity.team,
      authorBotId: ctx.identity.selfAgent,
    });
    if (result.fileId) {
      return `Uploaded (file_id: ${result.fileId}).`;
    }
    return 'File upload attempted but no file ID was returned — the file may not have been attached.';
  }
}
