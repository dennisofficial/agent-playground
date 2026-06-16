import type {
  ArtifactSink,
  ArtifactUploadRequest,
  ArtifactUploadResult,
} from '@harness/surface/artifact-sink.port';
import { Injectable, Logger } from '@nestjs/common';
import { TenantSlackClients } from './tenant-slack-clients';

/**
 * Slack adapter for the `ARTIFACT_SINK` port. Uploads an artifact as an UNSHARED Slack file
 * (no `channel_id`) so the file exists in the workspace but doesn't create its own message.
 * The conductor attaches the returned `fileId` to the agent's outgoing message via
 * `chat.update(file_ids)`. SINGLE VOICE: the one Slack app uploads (Atlas), like `SlackChatSurface`.
 */
@Injectable()
export class SlackFileUploadService implements ArtifactSink {
  private readonly logger = new Logger(SlackFileUploadService.name);

  constructor(private readonly clients: TenantSlackClients) {}

  async upload(req: ArtifactUploadRequest): Promise<ArtifactUploadResult> {
    const { teamId, authorBotId, content, filename, title } = req;

    const client = await this.clients.clientFor(teamId);

    if (!client) {
      this.logger.warn(
        `no Slack client for ${teamId}/${authorBotId} — skipping file upload`,
      );
      return {};
    }

    try {
      // Upload WITHOUT channel_id so the file is unshared (no standalone message in the channel).
      // The conductor attaches it to the agent's text message later via chat.update(file_ids).
      const result = await client.filesUploadV2({
        content,
        filename,
        title: title ?? filename,
      });
      // filesUploadV2 returns: { files: FilesCompleteUploadExternalResponse[] }
      // Each response wraps the completeUploadExternal result, which has files?: File[].
      const fileId = result.files?.[0]?.files?.[0]?.id;
      return { fileId };
    } catch (err) {
      this.logger.warn(
        `file upload (${teamId}/${authorBotId}, ${filename}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {};
    }
  }
}
