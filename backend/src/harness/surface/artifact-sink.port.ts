/**
 * DI token a hosting app binds its artifact-upload adapter to.
 * (`{ provide: ARTIFACT_SINK, useClass: SlackFileUploadService }`).
 * Optional: when absent, `ShareArtifactTool` degrades gracefully (no upload, warns caller).
 */
export const ARTIFACT_SINK = Symbol('ARTIFACT_SINK');

/** What the `share_artifact` tool passes to the sink. */
export interface ArtifactUploadRequest {
  content: string;
  filename: string;
  title?: string;
  /** Slack team id — needed by the Slack adapter to resolve the right WebClient. */
  teamId: string;
  /** Roster bot id (the employee uploading) — for puppet-first identity resolution. */
  authorBotId: string;
}

/** What the sink returns. `fileId` is present when the platform assigned one (Slack: `Fxxxxxxx`). */
export interface ArtifactUploadResult {
  fileId?: string;
}

/**
 * The artifact-upload port — surface-agnostic. The Slack adapter uploads via `filesUploadV2`
 * WITHOUT a `channel_id` (unshared); the conductor later attaches the resulting `fileId` to the
 * agent's outbound message via `chat.update(file_ids)`.
 */
export interface ArtifactSink {
  upload(req: ArtifactUploadRequest): Promise<ArtifactUploadResult>;
}
